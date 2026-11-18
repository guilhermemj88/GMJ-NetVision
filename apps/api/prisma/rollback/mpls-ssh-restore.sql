-- A2-b (2a auditoria): RESTAURACAO com reconciliacao de colisoes.
--
-- PROBLEMA CORRIGIDO AQUI
-- Durante a janela de rollback a API ANTIGA continua coletando por SNMP e pode
-- recriar `MplsDeviceState` (unico por `hostId`) e `MplsVsi` (unico por
-- `hostId`,`name`) ? com IDs DIFERENTES dos que foram para a quarentena. A
-- versao anterior usava `ON CONFLICT (id) DO NOTHING`, que:
--   * escondia a perda de dados (a linha nao voltava e ninguem ficava sabendo);
--   * quebrava em conflito de chave natural (`hostId`, `name`), abortando no meio;
--   * deixava AC/PW apontando para um `mplsVsiId` que nao existia mais.
--
-- COMO FUNCIONA AGORA (funcao transacional, fail-closed)
--   1. MplsDeviceState : se o host ja tem estado (recriado na janela) o registro
--      VIVO e preservado e a linha da quarentena fica marcada como supersedida
--      (nunca e apagada). Sem conflito -> reinsere com o ID original.
--   2. MplsVsi         : mesmo criterio; se a VSI existe com outro ID mas MESMA
--      identidade natural (hostId,name), os AC/PW sao REPARENTADOS para o ID vivo
--      (reconciliacao) e a linha antiga fica registrada.
--   3. MplsAc / MplsPw : reinseridos com o pai reconciliado; conflito de chave
--      natural = registro vivo vence e a linha antiga fica registrada.
--   4. Ao final, DIGEST por tabela: o que esta vivo tem de ser identico ao que
--      foi guardado (para AC/PW o `mplsVsiId` e ignorado, por ser remapeado de
--      proposito) e nenhum AC/PW pode ficar orfao. Qualquer divergencia
--      LEVANTA EXCECAO e a transacao inteira e desfeita.
--
-- Nada e convertido de SSH para SNMP: as linhas voltam com a proveniencia
-- original (`source`), e as que nao voltam ficam inteiras na quarentena com
-- `superseded_at` + motivo.
--
-- A2-N1 (3a auditoria): ESCOPO DA VALIDACAO DE INTEGRIDADE
-- O digest comparava TODAS as linhas ja restauradas com o snapshot congelado.
-- Depois de uma atualizacao legitima (o coletor novo atualiza `status` de uma
-- VSI restaurada, por exemplo) a reexecucao abortava: o digest "vivo" mudava e
-- o snapshot nao. Agora cada execucao marca as linhas que ELA inseriu
-- (`restore_run`) e valida somente esse conjunto. O snapshot original
-- (`MplsSshQuarantineSnapshot.digest`) continua intocado como evidencia
-- historica do momento da quarentena.
--
-- A2-N3 (3a auditoria): DEVICE REMOVIDO NA JANELA
-- Se o equipamento foi excluido do inventario durante a janela, a FK de
-- `MplsVsi`/`MplsDeviceState` para `Device` barraria a reinsercao. O script NAO
-- recria o cadastro e NAO descarta dado: as linhas ficam BLOQUEADAS
-- (`blocked_at` + `blocked_reason`), seguem pendentes para recuperacao
-- supervisionada, e os demais hosts sao restaurados normalmente.

BEGIN;

-- A2-N1/A2-N3: colunas novas (idempotente, aditivo).
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS restore_run uuid;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS blocked_reason text;

CREATE OR REPLACE FUNCTION "netvision_mpls_ssh_restore"(p_batch uuid DEFAULT NULL)
RETURNS TABLE (
  tabela         text,
  restauradas    bigint,
  ja_presentes   bigint,
  reconciliadas  bigint,
  supersedidas   bigint,
  bloqueadas     bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
  q record;
  v_run uuid := gen_random_uuid();
  v_live_id text;
  v_parent_id text;
  v_dig_live text;
  v_dig_guardado text;
  v_orfaos bigint;
  v_bloqueadas bigint := 0;
  r_restauradas bigint := 0;
  r_presentes bigint := 0;
  r_reconciliadas bigint := 0;
  r_supersedidas bigint := 0;
  -- AC/PW compartilham o mesmo laco; os contadores sao por tabela e por
  -- EXECUCAO (a reexecucao de uma restauracao ja concluida precisa reportar
  -- zero, como as outras duas tabelas).
  ac_restauradas bigint := 0;
  ac_presentes bigint := 0;
  ac_supersedidas bigint := 0;
  ac_bloqueadas bigint := 0;
  pw_restauradas bigint := 0;
  pw_presentes bigint := 0;
  pw_supersedidas bigint := 0;
  pw_bloqueadas bigint := 0;
BEGIN
  -- Mapa VSI antiga -> VSI viva, usado para reparentar AC/PW.
  CREATE TEMP TABLE IF NOT EXISTS _a2_map (old_id text PRIMARY KEY, new_id text NOT NULL)
    ON COMMIT DROP;
  TRUNCATE _a2_map;

  -- A2-N3: reabre bloqueios que deixaram de existir (o equipamento voltou ao
  -- inventario sob supervisao). A linha volta a ser candidata nesta execucao.
  UPDATE "MplsSshQuarantine" r
     SET blocked_at = NULL, blocked_reason = NULL
   WHERE r.blocked_at IS NOT NULL
     AND r.restored_at IS NULL
     AND r.superseded_at IS NULL
     AND (p_batch IS NULL OR r.batch_id = p_batch)
     AND EXISTS (SELECT 1 FROM "Device" d WHERE d.id = (r.row_data ->> 'hostId'));
  UPDATE "MplsSshQuarantine" r
     SET blocked_at = NULL, blocked_reason = NULL
   WHERE r.table_name IN ('MplsAc', 'MplsPw')
     AND r.blocked_at IS NOT NULL
     AND r.restored_at IS NULL
     AND r.superseded_at IS NULL
     AND (p_batch IS NULL OR r.batch_id = p_batch)
     AND NOT EXISTS (
       SELECT 1 FROM "MplsSshQuarantine" v
        WHERE v.table_name = 'MplsVsi'
          AND v.id = (r.row_data ->> 'mplsVsiId')
          AND v.blocked_at IS NOT NULL
     );

  -- A2-N3: Device ausente. Nada e recriado e nada e apagado — as quatro tabelas
  -- tem `hostId` no `row_data`, entao o bloqueio e global e vale para o host
  -- inteiro (estado, VSIs e dependentes).
  UPDATE "MplsSshQuarantine" r
     SET blocked_at = now(),
         blocked_reason = 'Device ausente no inventario: recuperacao supervisionada pendente'
   WHERE r.restored_at IS NULL
     AND r.superseded_at IS NULL
     AND r.blocked_at IS NULL
     AND (p_batch IS NULL OR r.batch_id = p_batch)
     AND NOT EXISTS (
       SELECT 1 FROM "Device" d WHERE d.id = (r.row_data ->> 'hostId')
     );

  -- ---------------------------------------------------------------- DeviceState
  r_restauradas := 0; r_presentes := 0; r_reconciliadas := 0; r_supersedidas := 0;
  FOR q IN
    SELECT * FROM "MplsSshQuarantine"
     WHERE table_name = 'MplsDeviceState' AND restored_at IS NULL AND superseded_at IS NULL
       AND blocked_at IS NULL
       AND (p_batch IS NULL OR batch_id = p_batch)
  LOOP
    SELECT s.id INTO v_live_id
      FROM "MplsDeviceState" s
     WHERE s."hostId" = (q.row_data ->> 'hostId')
     LIMIT 1;

    IF v_live_id IS NULL THEN
      INSERT INTO "MplsDeviceState"
      SELECT (jsonb_populate_record(NULL::"MplsDeviceState", q.row_data)).*;
      UPDATE "MplsSshQuarantine" SET restored_at = now(), restore_run = v_run
       WHERE table_name = q.table_name AND id = q.id;
      r_restauradas := r_restauradas + 1;
    ELSIF v_live_id = q.id THEN
      UPDATE "MplsSshQuarantine" SET restored_at = now()
       WHERE table_name = q.table_name AND id = q.id;
      r_presentes := r_presentes + 1;
    ELSE
      -- Estado recriado durante a janela: o vivo (mais novo) fica; a linha
      -- antiga permanece integral na quarentena como evidencia.
      UPDATE "MplsSshQuarantine"
         SET superseded_at = now(),
             superseded_reason = 'MplsDeviceState recriado durante a janela (id vivo ' || v_live_id || ')'
       WHERE table_name = q.table_name AND id = q.id;
      r_supersedidas := r_supersedidas + 1;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_bloqueadas FROM "MplsSshQuarantine"
   WHERE table_name = 'MplsDeviceState' AND blocked_at IS NOT NULL
     AND (p_batch IS NULL OR batch_id = p_batch);
  RETURN QUERY SELECT 'MplsDeviceState', r_restauradas, r_presentes, r_reconciliadas, r_supersedidas, v_bloqueadas;

  -- --------------------------------------------------------------------- VSI
  r_restauradas := 0; r_presentes := 0; r_reconciliadas := 0; r_supersedidas := 0;
  FOR q IN
    SELECT * FROM "MplsSshQuarantine"
     WHERE table_name = 'MplsVsi' AND restored_at IS NULL AND superseded_at IS NULL
       AND blocked_at IS NULL
       AND (p_batch IS NULL OR batch_id = p_batch)
  LOOP
    SELECT v.id INTO v_live_id FROM "MplsVsi" v WHERE v.id = q.id;

    IF v_live_id IS NOT NULL THEN
      INSERT INTO _a2_map (old_id, new_id) VALUES (q.id, v_live_id)
        ON CONFLICT (old_id) DO UPDATE SET new_id = EXCLUDED.new_id;
      UPDATE "MplsSshQuarantine" SET restored_at = now()
       WHERE table_name = q.table_name AND id = q.id;
      r_presentes := r_presentes + 1;
    ELSE
      SELECT v.id INTO v_live_id
        FROM "MplsVsi" v
       WHERE v."hostId" = (q.row_data ->> 'hostId')
         AND v.name = (q.row_data ->> 'name')
       LIMIT 1;

      IF v_live_id IS NOT NULL THEN
        -- Mesma identidade natural, ID diferente: reconcilia e reparenta.
        INSERT INTO _a2_map (old_id, new_id) VALUES (q.id, v_live_id)
          ON CONFLICT (old_id) DO UPDATE SET new_id = EXCLUDED.new_id;
        UPDATE "MplsSshQuarantine"
           SET superseded_at = now(),
               superseded_reason = 'VSI recriada na janela; dependentes reparentados para ' || v_live_id
         WHERE table_name = q.table_name AND id = q.id;
        r_reconciliadas := r_reconciliadas + 1;
      ELSE
        INSERT INTO "MplsVsi"
        SELECT (jsonb_populate_record(NULL::"MplsVsi", q.row_data)).*;
        INSERT INTO _a2_map (old_id, new_id) VALUES (q.id, q.id)
          ON CONFLICT (old_id) DO UPDATE SET new_id = EXCLUDED.new_id;
        UPDATE "MplsSshQuarantine" SET restored_at = now(), restore_run = v_run
         WHERE table_name = q.table_name AND id = q.id;
        r_restauradas := r_restauradas + 1;
      END IF;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_bloqueadas FROM "MplsSshQuarantine"
   WHERE table_name = 'MplsVsi' AND blocked_at IS NOT NULL
     AND (p_batch IS NULL OR batch_id = p_batch);
  RETURN QUERY SELECT 'MplsVsi', r_restauradas, r_presentes, r_reconciliadas, r_supersedidas, v_bloqueadas;

  -- ------------------------------------------------------------------ AC e PW
  -- A2-N3: dependentes de uma VSI bloqueada tambem ficam bloqueados (nao
  -- "supersedidos"): quando o equipamento voltar ao inventario, a recuperacao
  -- supervisionada restaura o host inteiro.
  UPDATE "MplsSshQuarantine" r
     SET blocked_at = now(),
         blocked_reason = 'VSI pai bloqueada (Device ausente): recuperacao supervisionada pendente'
   WHERE r.table_name IN ('MplsAc', 'MplsPw')
     AND r.restored_at IS NULL
     AND r.superseded_at IS NULL
     AND r.blocked_at IS NULL
     AND (p_batch IS NULL OR r.batch_id = p_batch)
     AND EXISTS (
       SELECT 1 FROM "MplsSshQuarantine" v
        WHERE v.table_name = 'MplsVsi'
          AND v.id = (r.row_data ->> 'mplsVsiId')
          AND v.blocked_at IS NOT NULL
     );

  FOR q IN
    SELECT * FROM "MplsSshQuarantine"
     WHERE table_name IN ('MplsAc', 'MplsPw')
       AND restored_at IS NULL AND superseded_at IS NULL
       AND blocked_at IS NULL
       AND (p_batch IS NULL OR batch_id = p_batch)
     ORDER BY table_name DESC
  LOOP
    -- Pai remapeado por reconciliacao; sem mapa, o pai segue vivo com o mesmo ID.
    SELECT m.new_id INTO v_parent_id FROM _a2_map m WHERE m.old_id = (q.row_data ->> 'mplsVsiId');
    IF v_parent_id IS NULL THEN
      v_parent_id := (q.row_data ->> 'mplsVsiId');
    END IF;

    IF NOT EXISTS (SELECT 1 FROM "MplsVsi" v WHERE v.id = v_parent_id) THEN
      -- Nao existe mais onde pendurar: preserva para recuperacao supervisionada
      -- em vez de marcar como supersedida (A2-N3).
      UPDATE "MplsSshQuarantine"
         SET blocked_at = now(),
             blocked_reason = 'VSI pai ausente (' || v_parent_id || '): recuperacao supervisionada pendente'
       WHERE table_name = q.table_name AND id = q.id;
      IF q.table_name = 'MplsAc' THEN ac_bloqueadas := ac_bloqueadas + 1;
      ELSE pw_bloqueadas := pw_bloqueadas + 1; END IF;
      CONTINUE;    END IF;

    IF EXISTS (
      SELECT 1 FROM "MplsSshQuarantine" x
       WHERE x.table_name = q.table_name AND x.id = q.id AND x.restored_at IS NOT NULL
    ) THEN
      CONTINUE;
    END IF;

    IF q.table_name = 'MplsAc' THEN
      IF EXISTS (SELECT 1 FROM "MplsAc" a WHERE a.id = q.id) THEN
        UPDATE "MplsSshQuarantine" SET restored_at = now()
         WHERE table_name = q.table_name AND id = q.id;
        ac_presentes := ac_presentes + 1;
      ELSIF EXISTS (
        SELECT 1 FROM "MplsAc" a
         WHERE a."hostId" = (q.row_data ->> 'hostId')
           AND a."vsiName" = (q.row_data ->> 'vsiName')
           AND a."ifIndex" = ((q.row_data ->> 'ifIndex')::int)
      ) THEN
        UPDATE "MplsSshQuarantine"
           SET superseded_at = now(),
               superseded_reason = 'AC recriado durante a janela (mesma chave natural)'
         WHERE table_name = q.table_name AND id = q.id;
        ac_supersedidas := ac_supersedidas + 1;
      ELSE
        INSERT INTO "MplsAc"
        SELECT (jsonb_populate_record(
                  NULL::"MplsAc",
                  jsonb_set(q.row_data, '{mplsVsiId}', to_jsonb(v_parent_id))
                )).*;
        UPDATE "MplsSshQuarantine" SET restored_at = now(), restore_run = v_run
         WHERE table_name = q.table_name AND id = q.id;
        ac_restauradas := ac_restauradas + 1;
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM "MplsPw" p WHERE p.id = q.id) THEN
        UPDATE "MplsSshQuarantine" SET restored_at = now()
         WHERE table_name = q.table_name AND id = q.id;
        pw_presentes := pw_presentes + 1;
      ELSIF EXISTS (
        SELECT 1 FROM "MplsPw" p
         WHERE p."hostId" = (q.row_data ->> 'hostId')
           AND p."vsiName" = (q.row_data ->> 'vsiName')
           AND p."pwId" = ((q.row_data ->> 'pwId')::int)
           AND p."remoteIp" = (q.row_data ->> 'remoteIp')
      ) THEN
        UPDATE "MplsSshQuarantine"
           SET superseded_at = now(),
               superseded_reason = 'PW recriado durante a janela (mesma chave natural)'
         WHERE table_name = q.table_name AND id = q.id;
        pw_supersedidas := pw_supersedidas + 1;
      ELSE
        INSERT INTO "MplsPw"
        SELECT (jsonb_populate_record(
                  NULL::"MplsPw",
                  jsonb_set(q.row_data, '{mplsVsiId}', to_jsonb(v_parent_id))
                )).*;
        UPDATE "MplsSshQuarantine" SET restored_at = now(), restore_run = v_run
         WHERE table_name = q.table_name AND id = q.id;
        pw_restauradas := pw_restauradas + 1;
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO ac_bloqueadas FROM "MplsSshQuarantine"
   WHERE table_name = 'MplsAc' AND blocked_at IS NOT NULL
     AND (p_batch IS NULL OR batch_id = p_batch);
  SELECT count(*) INTO pw_bloqueadas FROM "MplsSshQuarantine"
   WHERE table_name = 'MplsPw' AND blocked_at IS NOT NULL
     AND (p_batch IS NULL OR batch_id = p_batch);

  RETURN QUERY SELECT 'MplsAc', ac_restauradas, ac_presentes, 0::bigint, ac_supersedidas, ac_bloqueadas;
  RETURN QUERY SELECT 'MplsPw', pw_restauradas, pw_presentes, 0::bigint, pw_supersedidas, pw_bloqueadas;

  -- ------------------------------------------- Digest + integridade referencial
  -- A2-N1: a validacao cobre APENAS o que ESTA execucao inseriu (`restore_run`).
  -- Linhas restauradas em execucoes anteriores podem ter sido atualizadas
  -- legitimamente pelo coletor novo - compara-las com o snapshot congelado
  -- abortava a reexecucao sem nenhum problema real. O digest original segue
  -- intacto em "MplsSshQuarantineSnapshot" como evidencia historica.
  IF p_batch IS NULL THEN
    SELECT md5(string_agg(v::text, '|' ORDER BY v.id)) INTO v_dig_live
      FROM "MplsVsi" v WHERE v.id IN (SELECT id FROM "MplsSshQuarantine"
                                       WHERE table_name = 'MplsVsi' AND restore_run = v_run);
    SELECT md5(string_agg((jsonb_populate_record(NULL::"MplsVsi", row_data))::text, '|' ORDER BY id))
      INTO v_dig_guardado
      FROM "MplsSshQuarantine" WHERE table_name = 'MplsVsi' AND restore_run = v_run;
    IF v_dig_live IS DISTINCT FROM v_dig_guardado THEN
      RAISE EXCEPTION 'A2_RESTORE_DIGEST_MISMATCH (MplsVsi): % <> %', v_dig_live, v_dig_guardado;
    END IF;

    SELECT md5(string_agg(s::text, '|' ORDER BY s.id)) INTO v_dig_live
      FROM "MplsDeviceState" s WHERE s.id IN (SELECT id FROM "MplsSshQuarantine"
                                              WHERE table_name = 'MplsDeviceState' AND restore_run = v_run);
    SELECT md5(string_agg((jsonb_populate_record(NULL::"MplsDeviceState", row_data))::text, '|' ORDER BY id))
      INTO v_dig_guardado
      FROM "MplsSshQuarantine" WHERE table_name = 'MplsDeviceState' AND restore_run = v_run;
    IF v_dig_live IS DISTINCT FROM v_dig_guardado THEN
      RAISE EXCEPTION 'A2_RESTORE_DIGEST_MISMATCH (MplsDeviceState): % <> %', v_dig_live, v_dig_guardado;
    END IF;

    -- AC/PW: o `mplsVsiId` pode ter sido remapeado de proposito, entao o digest
    -- ignora essa coluna; o vinculo e conferido pela integridade referencial.
    SELECT md5(string_agg((to_jsonb(a) - 'mplsVsiId')::text, '|' ORDER BY a.id)) INTO v_dig_live
      FROM "MplsAc" a WHERE a.id IN (SELECT id FROM "MplsSshQuarantine"
                                     WHERE table_name = 'MplsAc' AND restore_run = v_run);
    SELECT md5(string_agg((row_data - 'mplsVsiId')::text, '|' ORDER BY id)) INTO v_dig_guardado
      FROM "MplsSshQuarantine" WHERE table_name = 'MplsAc' AND restore_run = v_run;
    IF v_dig_live IS DISTINCT FROM v_dig_guardado THEN
      RAISE EXCEPTION 'A2_RESTORE_DIGEST_MISMATCH (MplsAc): % <> %', v_dig_live, v_dig_guardado;
    END IF;

    SELECT md5(string_agg((to_jsonb(p) - 'mplsVsiId')::text, '|' ORDER BY p.id)) INTO v_dig_live
      FROM "MplsPw" p WHERE p.id IN (SELECT id FROM "MplsSshQuarantine"
                                     WHERE table_name = 'MplsPw' AND restore_run = v_run);
    SELECT md5(string_agg((row_data - 'mplsVsiId')::text, '|' ORDER BY id)) INTO v_dig_guardado
      FROM "MplsSshQuarantine" WHERE table_name = 'MplsPw' AND restore_run = v_run;
    IF v_dig_live IS DISTINCT FROM v_dig_guardado THEN
      RAISE EXCEPTION 'A2_RESTORE_DIGEST_MISMATCH (MplsPw): % <> %', v_dig_live, v_dig_guardado;
    END IF;
  END IF;

  SELECT (SELECT count(*) FROM "MplsAc" a
           WHERE a.id IN (SELECT id FROM "MplsSshQuarantine" WHERE table_name = 'MplsAc' AND restore_run = v_run)
             AND NOT EXISTS (SELECT 1 FROM "MplsVsi" v WHERE v.id = a."mplsVsiId"))
       + (SELECT count(*) FROM "MplsPw" p
           WHERE p.id IN (SELECT id FROM "MplsSshQuarantine" WHERE table_name = 'MplsPw' AND restore_run = v_run)
             AND NOT EXISTS (SELECT 1 FROM "MplsVsi" v WHERE v.id = p."mplsVsiId"))
    INTO v_orfaos;
  IF v_orfaos <> 0 THEN
    RAISE EXCEPTION 'A2_RESTORE_ORPHANS: % AC/PW restaurados sem VSI pai', v_orfaos;
  END IF;
END
$$;

-- Execucao (o chamador pode embrulhar em BEGIN/COMMIT para controlar a falha).
SELECT * FROM "netvision_mpls_ssh_restore"();

COMMIT;

-- Conferencia final.
SELECT table_name,
       count(*) FILTER (WHERE restored_at IS NOT NULL)                    AS restauradas,
       count(*) FILTER (WHERE superseded_at IS NOT NULL)                  AS preservadas_na_quarentena,
       count(*) FILTER (WHERE blocked_at IS NOT NULL)                     AS bloqueadas,
       count(*) FILTER (WHERE restored_at IS NULL AND superseded_at IS NULL
                          AND blocked_at IS NULL)                         AS pendentes
  FROM "MplsSshQuarantine"
 GROUP BY table_name
 ORDER BY table_name;
