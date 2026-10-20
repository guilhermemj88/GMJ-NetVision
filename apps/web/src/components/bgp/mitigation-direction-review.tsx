'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  BgpMitigationProfileDto,
  MitigationDirectionPreviewDto,
  MitigationTelemetryEntryDto,
  MitigationAutoTrafficDirection,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import { applyMitigationDirections, previewMitigationDirections } from '@/lib/mitigation-api';
import { diagnosticRate } from './mitigation-telemetry';
import styles from './mitigation-direction-review.module.css';

type Scope = 'PROFILE' | 'INTERFACE';

/**
 * Revisão de direções RX/TX. Dois escopos no MESMO fluxo de aprovação:
 * - PROFILE: override explícito do perfil (vence ENV e interface);
 * - INTERFACE: direção herdada por todos os perfis da interface, inclusive os
 *   descobertos no futuro. Interfaces com perfil AUTO são recusadas pelo backend.
 * Nada aqui altera modo, autorização, runtime ou equipamento.
 */
export function MitigationDirectionReviewPanel({
  profiles,
  entries,
}: {
  profiles: BgpMitigationProfileDto[];
  entries: MitigationTelemetryEntryDto[];
}) {
  const client = useQueryClient();
  const [scope, setScope] = useState<Scope>('PROFILE');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<MitigationDirectionPreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const editable = profiles.filter((p) => p.mode !== 'AUTO');
  const interfaces = [
    ...new Map(
      editable
        .filter((p) => Boolean(p.interfaceId))
        .map((p) => [
          p.interfaceId!,
          {
            interfaceId: p.interfaceId!,
            name:
              entries.find((e) => e.profileId === p.id)?.interfaceName ??
              p.interfaceName ??
              p.interfaceId!,
          },
        ]),
    ).values(),
  ];
  const selected = editable.filter(
    (p) => draft[p.id] !== undefined && draft[p.id] !== 'KEEP',
  );
  const selectedInterfaces = interfaces.filter(
    (i) => draft[i.interfaceId] !== undefined && draft[i.interfaceId] !== 'KEEP',
  );
  const selectionCount = scope === 'PROFILE' ? selected.length : selectedInterfaces.length;
  const edit = (id: string, value: string) => {
    setDraft((d) => ({ ...d, [id]: value }));
    setPreview(null);
    setConfirmed(false);
  };
  const directionOf = (value: string): MitigationAutoTrafficDirection | null =>
    value === 'NONE' ? null : (value as MitigationAutoTrafficDirection);
  const prepare = async () => {
    setBusy(true);
    setMessage('');
    try {
      setPreview(
        await previewMitigationDirections(
          scope === 'PROFILE'
            ? {
                changes: selected.map((p) => ({
                  profileId: p.id,
                  direction: directionOf(draft[p.id]!),
                })),
              }
            : {
                interfaceChanges: selectedInterfaces.map((i) => ({
                  interfaceId: i.interfaceId,
                  direction: directionOf(draft[i.interfaceId]!),
                })),
              },
        ),
      );
      setConfirmed(false);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Falha na prévia');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview || !confirmed) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await applyMitigationDirections(preview.previewId);
      setMessage(`${result.applied} direções registradas com auditoria. Modos preservados.`);
      setPreview(null);
      setDraft({});
      await client.invalidateQueries({ queryKey: ['mitigation'] });
    } catch (e) {
      setPreview(null);
      setConfirmed(false);
      setMessage(e instanceof Error ? e.message : 'Falha ao aplicar; gere nova prévia');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel} aria-label="Revisão de direções">
      <h4>REVISAR DIREÇÕES RX/TX</h4>
      <p>
        RX entra no Huawei; TX sai do Huawei nesta interface. Selecione conforme a finalidade da
        proteção. Sem direção, RX/TX continuam visíveis e a mitigação permanece bloqueada.
      </p>
      <p>
        IPv4/IPv6 compartilham contadores agregados, sem separação por família. A configuração por
        interface é herdada por todos os perfis dela, inclusive descobertas futuras; o override do
        perfil continua tendo precedência.
      </p>
      <label>
        Escopo da alteração
        <select
          aria-label="Escopo da alteração de direção"
          value={scope}
          disabled={busy}
          onChange={(e) => {
            setScope(e.target.value as Scope);
            setDraft({});
            setPreview(null);
            setConfirmed(false);
          }}
        >
          <option value="PROFILE">Por perfil (override explícito)</option>
          <option value="INTERFACE">Por interface (herança)</option>
        </select>
      </label>
      {scope === 'PROFILE' && profiles.length > 1 && (
        <div className={styles.bulk}>
          <label>
            <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} />{' '}
            Confirmo selecionar uma direção em lote
          </label>
          <select
            aria-label="Selecionar direção em lote"
            disabled={!bulk || busy}
            value="KEEP"
            onChange={(e) => {
              setDraft(
                Object.fromEntries(editable.map((p) => [p.id, e.target.value])),
              );
              setPreview(null);
              setConfirmed(false);
              setBulk(false);
            }}
          >
            <option value="KEEP">Selecionar individualmente</option>
            <option value="RX">RX para os perfis desta revisão</option>
            <option value="TX">TX para os perfis desta revisão</option>
          </select>
        </div>
      )}
      {scope === 'INTERFACE' && interfaces.length > 1 && (
        <div className={styles.bulk}>
          <label>
            <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} />{' '}
            Confirmo selecionar uma direção em lote
          </label>
          <select
            aria-label="Selecionar direção em lote por interface"
            disabled={!bulk || busy}
            value="KEEP"
            onChange={(e) => {
              setDraft(Object.fromEntries(interfaces.map((i) => [i.interfaceId, e.target.value])));
              setPreview(null);
              setConfirmed(false);
              setBulk(false);
            }}
          >
            <option value="KEEP">Selecionar individualmente</option>
            <option value="RX">RX para as interfaces desta revisão</option>
            <option value="TX">TX para as interfaces desta revisão</option>
          </select>
        </div>
      )}
      <div className={styles.cards}>
        {scope === 'PROFILE'
          ? profiles.map((p) => {
              const d = entries.find((d) => d.profileId === p.id);
              return (
                <div key={p.id} className={styles.card}>
                  <strong>
                    {p.customer ?? p.interfaceDescription ?? p.interfaceName ?? p.id} ·{' '}
                    {p.addressFamily}
                  </strong>
                  <span>
                    {d?.interfaceName ?? p.interfaceName} · {p.mode}
                  </span>
                  <span>
                    RX {diagnosticRate(d?.rxBps ?? null)} · TX {diagnosticRate(d?.txBps ?? null)}
                  </span>
                  <small>
                    Efetiva: {d?.direction ?? 'NÃO CONFIGURADA'} · origem{' '}
                    {d?.directionSource ?? 'ausente'}
                  </small>
                  <label>
                    Nova direção
                    <select
                      aria-label={`Direção ${p.id}`}
                      disabled={p.mode === 'AUTO' || busy}
                      value={draft[p.id] ?? 'KEEP'}
                      onChange={(e) => edit(p.id, e.target.value)}
                    >
                      <option value="KEEP">Manter</option>
                      <option value="RX">RX</option>
                      <option value="TX">TX</option>
                      <option value="NONE">Limpar persistida (ENV pode permanecer)</option>
                    </select>
                  </label>
                  {p.mode === 'AUTO' && (
                    <small>AUTO: alteração de direção exige autorização separada.</small>
                  )}
                </div>
              );
            })
          : interfaces.map((i) => {
              const d = entries.find(
                (e) => e.interfaceName === i.name || e.interfaceId === i.interfaceId,
              );
              const current = profiles.find((p) => p.interfaceId === i.interfaceId)
                ?.interfaceTrafficDirection;
              return (
                <div key={i.interfaceId} className={styles.card}>
                  <strong>{i.name}</strong>
                  <span>Herdada pelos perfis da interface</span>
                  <span>
                    RX {diagnosticRate(d?.rxBps ?? null)} · TX {diagnosticRate(d?.txBps ?? null)}
                  </span>
                  <small>Interface: {current ?? 'NÃO CONFIGURADA'}</small>
                  <label>
                    Nova direção da interface
                    <select
                      aria-label={`Direção da interface ${i.name}`}
                      disabled={busy}
                      value={draft[i.interfaceId] ?? 'KEEP'}
                      onChange={(e) => edit(i.interfaceId, e.target.value)}
                    >
                      <option value="KEEP">Manter</option>
                      <option value="RX">RX</option>
                      <option value="TX">TX</option>
                      <option value="NONE">Limpar da interface</option>
                    </select>
                  </label>
                </div>
              );
            })}
      </div>
      <Button
        compact
        variant="secondary"
        disabled={busy || selectionCount === 0}
        onClick={() => void prepare()}
      >
        GERAR PRÉVIA ({selectionCount})
      </Button>
      {preview && (
        <div className={styles.preview}>
          <h4>
            PRÉVIA COMPLETA — {preview.changes.length + (preview.interfaceChanges?.length ?? 0)}{' '}
            alterações
          </h4>
          {preview.changes.map((c) => (
            <p key={c.profileId}>
              {c.interfaceName ?? c.profileId} · {c.addressFamily} · {c.mode} preservado ·{' '}
              {c.before ?? 'ausente'} → {c.after ?? 'ausente'} · efetiva{' '}
              {c.effectiveAfter ?? 'ausente'} ({c.sourceAfter ?? 'sem origem'}) ·{' '}
              {c.impact === 'SHADOW_EVALUATION_ONLY'
                ? 'Avaliação em sombra; sem execução'
                : c.impact === 'DISABLED_PRESERVED'
                  ? 'Permanece desabilitado'
                  : 'Direção ainda pendente'}
            </p>
          ))}
          {(preview.interfaceChanges ?? []).map((c) => (
            <p key={c.interfaceId}>
              {c.interfaceName ?? c.interfaceId} · herança para {c.affectedProfileIds.length}{' '}
              perfil(is) · {c.before ?? 'ausente'} → {c.after ?? 'ausente'} ·{' '}
              {c.impact === 'INHERITED_BY_PROFILES_SHADOW_EVALUATION_ONLY'
                ? 'Avaliação em sombra; sem execução'
                : 'Direção ainda pendente'}
            </p>
          ))}
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            Confirmo estas alterações de direção, mantendo modos e autorizações
          </label>
          <Button
            compact
            disabled={!confirmed || busy || Date.now() >= new Date(preview.expiresAt).getTime()}
            onClick={() => void apply()}
          >
            CONFIRMAR DIREÇÕES
          </Button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
