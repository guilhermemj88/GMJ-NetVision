-- A2-a (2a auditoria): QUARENTENA das linhas afetadas pelo rollback do release MPLS.
--
-- PROBLEMA CORRIGIDO AQUI
-- `MplsAc.mplsVsiId` e `MplsPw.mplsVsiId` sao ON DELETE CASCADE. A versao
-- anterior guardava apenas as linhas com `source='SSH'`, entao os ACs/PWs com
-- origem SNMP pendurados numa VSI SSH eram APAGADOS pelo cascade e perdidos
-- para sempre. Agora o script calcula o CONJUNTO AFETADO COMPLETO antes de
-- qualquer DELETE:
--
--   MplsVsi         : source = 'SSH'
--   MplsAc / MplsPw : source = 'SSH'  OU  mplsVsiId in (VSIs SSH)
--   MplsDeviceState : source = 'SSH'
--
-- Garantias:
--   * proveniencia preservada (`row_source` + JSONB da linha inteira);
--   * snapshot com contagem e digest por tabela ANTES de apagar;
--   * validacao fail-closed: se o que foi guardado nao bater com o conjunto
--     afetado, o script ABORTA e nada e apagado (transacao);
--   * verificacao pos-delete de que o conjunto afetado saiu das tabelas vivas.
--
-- QUANDO RODAR: com a API PARADA, imediatamente antes de subir um build
-- anterior ao release MPLS/VPWS.

BEGIN;

-- 1) Estruturas operacionais (fora do schema Prisma).
CREATE TABLE IF NOT EXISTS "MplsSshQuarantine" (
  table_name     text        NOT NULL,
  id             text        NOT NULL,
  row_data       jsonb       NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  reason         text        NOT NULL,
  restored_at    timestamptz,
  PRIMARY KEY (table_name, id)
);
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS row_source text;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS superseded_reason text;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE "MplsSshQuarantine" ADD COLUMN IF NOT EXISTS restore_run uuid;

CREATE TABLE IF NOT EXISTS "MplsSshQuarantineSnapshot" (
  taken_at   timestamptz NOT NULL DEFAULT now(),
  table_name text        NOT NULL,
  rows       bigint      NOT NULL,
  digest     text        NOT NULL
);
ALTER TABLE "MplsSshQuarantineSnapshot" ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE "MplsSshQuarantineSnapshot" ADD COLUMN IF NOT EXISTS affected_by_cascade bigint;

-- 2) Identificador do lote e conjunto afetado (inclui o que o cascade levaria).
CREATE TEMP TABLE _a2_batch ON COMMIT DROP AS SELECT gen_random_uuid() AS id;

CREATE TEMP TABLE _a2_afetado ON COMMIT DROP AS
SELECT 'MplsVsi'::text AS tabela, v.id, v.source::text AS row_source, false AS via_cascade
  FROM "MplsVsi" v
 WHERE v.source::text = 'SSH'
UNION ALL
SELECT 'MplsAc', a.id, a.source::text,
       (a.source::text <> 'SSH') AS via_cascade
  FROM "MplsAc" a
 WHERE a.source::text = 'SSH'
    OR a."mplsVsiId" IN (SELECT id FROM "MplsVsi" WHERE source::text = 'SSH')
UNION ALL
SELECT 'MplsPw', p.id, p.source::text,
       (p.source::text <> 'SSH') AS via_cascade
  FROM "MplsPw" p
 WHERE p.source::text = 'SSH'
    OR p."mplsVsiId" IN (SELECT id FROM "MplsVsi" WHERE source::text = 'SSH')
UNION ALL
SELECT 'MplsDeviceState', s.id, s.source::text, false
  FROM "MplsDeviceState" s
 WHERE s.source::text = 'SSH';

-- 3) Snapshot verificavel (contagem + digest) ANTES de qualquer DELETE.
INSERT INTO "MplsSshQuarantineSnapshot" (batch_id, table_name, rows, digest, affected_by_cascade)
SELECT (SELECT id FROM _a2_batch), t.tabela, count(*),
       coalesce(md5(string_agg(t.row_text, '|' ORDER BY t.id)), 'vazio'),
       count(*) FILTER (WHERE t.via_cascade)
  FROM (
    SELECT a.tabela, a.id, a.via_cascade, v::text AS row_text
      FROM _a2_afetado a JOIN "MplsVsi" v ON a.tabela = 'MplsVsi' AND v.id = a.id
    UNION ALL
    SELECT a.tabela, a.id, a.via_cascade, x::text
      FROM _a2_afetado a JOIN "MplsAc" x ON a.tabela = 'MplsAc' AND x.id = a.id
    UNION ALL
    SELECT a.tabela, a.id, a.via_cascade, p::text
      FROM _a2_afetado a JOIN "MplsPw" p ON a.tabela = 'MplsPw' AND p.id = a.id
    UNION ALL
    SELECT a.tabela, a.id, a.via_cascade, s::text
      FROM _a2_afetado a JOIN "MplsDeviceState" s ON a.tabela = 'MplsDeviceState' AND s.id = a.id
  ) t
 GROUP BY t.tabela;

-- 4) Copia integral (JSONB) para a quarentena, preservando a proveniencia.
INSERT INTO "MplsSshQuarantine" (table_name, id, row_data, reason, batch_id, row_source)
SELECT 'MplsVsi', v.id, to_jsonb(v),
       'A2 rollback: remocao de VSI com origem SSH', (SELECT id FROM _a2_batch), v.source::text
  FROM "MplsVsi" v
 WHERE v.id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsVsi')
UNION ALL
SELECT 'MplsAc', x.id, to_jsonb(x),
       'A2 rollback: AC removido (origem SSH ou cascade da VSI SSH)', (SELECT id FROM _a2_batch), x.source::text
  FROM "MplsAc" x
 WHERE x.id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsAc')
UNION ALL
SELECT 'MplsPw', p.id, to_jsonb(p),
       'A2 rollback: PW removido (origem SSH ou cascade da VSI SSH)', (SELECT id FROM _a2_batch), p.source::text
  FROM "MplsPw" p
 WHERE p.id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsPw')
UNION ALL
SELECT 'MplsDeviceState', s.id, to_jsonb(s),
       'A2 rollback: estado MPLS com origem SSH', (SELECT id FROM _a2_batch), s.source::text
  FROM "MplsDeviceState" s
 WHERE s.id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsDeviceState')
ON CONFLICT (table_name, id) DO UPDATE
  SET row_data = EXCLUDED.row_data,
      reason = EXCLUDED.reason,
      quarantined_at = now(),
      batch_id = EXCLUDED.batch_id,
      row_source = EXCLUDED.row_source,
      restored_at = NULL,
      restore_run = NULL,
      superseded_at = NULL,
      superseded_reason = NULL,
      blocked_at = NULL,
      blocked_reason = NULL;

-- 5) VALIDACAO fail-closed: o que esta guardado tem de ser exatamente o
--    conjunto afetado. Qualquer diferenca aborta a transacao (nada e apagado).
DO $$
DECLARE
  v_afetado bigint;
  v_guardado bigint;
BEGIN
  SELECT count(*) INTO v_afetado FROM _a2_afetado;
  SELECT count(*) INTO v_guardado
    FROM "MplsSshQuarantine" q
    JOIN _a2_batch b ON q.batch_id = b.id
   WHERE q.restored_at IS NULL;
  IF v_afetado <> v_guardado THEN
    RAISE EXCEPTION
      'A2_QUARANTINE_INCOMPLETE: % linhas afetadas, % guardadas - nada foi apagado',
      v_afetado, v_guardado;
  END IF;
END
$$;

-- 6) Remocao das tabelas vivas (filhos primeiro, depois o pai).
DELETE FROM "MplsPw"           WHERE id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsPw');
DELETE FROM "MplsAc"           WHERE id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsAc');
DELETE FROM "MplsVsi"          WHERE id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsVsi');
DELETE FROM "MplsDeviceState"  WHERE id IN (SELECT id FROM _a2_afetado WHERE tabela = 'MplsDeviceState');

-- 7) Validacao pos-delete: nenhuma linha afetada pode ter sobrado.
DO $$
DECLARE
  v_restantes bigint;
BEGIN
  SELECT count(*) INTO v_restantes FROM (
    SELECT v.id FROM "MplsVsi" v JOIN _a2_afetado a ON a.tabela = 'MplsVsi' AND a.id = v.id
    UNION ALL
    SELECT x.id FROM "MplsAc" x JOIN _a2_afetado a ON a.tabela = 'MplsAc' AND a.id = x.id
    UNION ALL
    SELECT p.id FROM "MplsPw" p JOIN _a2_afetado a ON a.tabela = 'MplsPw' AND a.id = p.id
    UNION ALL
    SELECT s.id FROM "MplsDeviceState" s JOIN _a2_afetado a ON a.tabela = 'MplsDeviceState' AND a.id = s.id
  ) r;
  IF v_restantes <> 0 THEN
    RAISE EXCEPTION 'A2_QUARANTINE_NOT_APPLIED: % linha(s) afetada(s) continuam vivas', v_restantes;
  END IF;
END
$$;

COMMIT;

-- 8) Relatorio: lote, proveniencia e dependentes preservados pelo cascade.
SELECT q.batch_id,
       count(*)                                                   AS linhas_em_quarentena,
       count(*) FILTER (WHERE q.row_source = 'SSH')               AS origem_ssh,
       count(*) FILTER (WHERE q.row_source <> 'SSH')              AS origem_nao_ssh_preservada,
       count(*) FILTER (WHERE q.table_name IN ('MplsAc','MplsPw')) AS ac_pw_preservados
  FROM "MplsSshQuarantine" q
 WHERE q.restored_at IS NULL
 GROUP BY q.batch_id
 ORDER BY max(q.quarantined_at) DESC;

SELECT table_name, rows, affected_by_cascade, digest, taken_at, batch_id
  FROM "MplsSshQuarantineSnapshot"
 ORDER BY taken_at DESC, table_name
 LIMIT 8;
