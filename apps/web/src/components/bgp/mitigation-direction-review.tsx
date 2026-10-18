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

export function MitigationDirectionReviewPanel({
  profiles,
  entries,
}: {
  profiles: BgpMitigationProfileDto[];
  entries: MitigationTelemetryEntryDto[];
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [preview, setPreview] = useState<MitigationDirectionPreviewDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const selected = profiles.filter(
    (p) => p.mode !== 'AUTO' && draft[p.id] !== undefined && draft[p.id] !== 'KEEP',
  );
  const edit = (id: string, value: string) => {
    setDraft((d) => ({ ...d, [id]: value }));
    setPreview(null);
    setConfirmed(false);
  };
  const prepare = async () => {
    setBusy(true);
    setMessage('');
    try {
      setPreview(
        await previewMitigationDirections(
          selected.map((p) => ({
            profileId: p.id,
            direction:
              draft[p.id] === 'NONE' ? null : (draft[p.id] as MitigationAutoTrafficDirection),
          })),
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
        IPv4/IPv6 compartilham contadores agregados, sem separação por família. A configuração é
        individual por perfil.
      </p>
      {profiles.length > 1 && (
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
                Object.fromEntries(
                  profiles.filter((p) => p.mode !== 'AUTO').map((p) => [p.id, e.target.value]),
                ),
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
      <div className={styles.cards}>
        {profiles.map((p) => {
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
        })}
      </div>
      <Button
        compact
        variant="secondary"
        disabled={busy || !selected.length}
        onClick={() => void prepare()}
      >
        GERAR PRÉVIA ({selected.length})
      </Button>
      {preview && (
        <div className={styles.preview}>
          <h4>PRÉVIA COMPLETA — {preview.changes.length} alterações</h4>
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
