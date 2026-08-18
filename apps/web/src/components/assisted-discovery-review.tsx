'use client';

import { useMemo, useState } from 'react';
import type {
  HostRecord,
  LldpAdjacencyProposal,
  LldpApplyAction,
  LldpApplySelection,
  LldpTopologyPreview,
} from '@gmj/shared';
import { Badge, Button } from '@gmj/ui';
import { CheckCircle2, LoaderCircle, Radar, TriangleAlert } from 'lucide-react';
import { applyLldp, getMap, previewHostLldp } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

function defaultAction(adjacency: LldpAdjacencyProposal): LldpApplyAction {
  if (adjacency.duplicate || adjacency.existingLinkId) return 'IGNORE';
  if (adjacency.confidence === 'AMBIGUOUS' || adjacency.confidence === 'UNKNOWN_NEIGHBOR') {
    return 'IGNORE';
  }
  return 'CREATE_LINK';
}

function confidenceTone(confidence: LldpAdjacencyProposal['confidence']): string {
  switch (confidence) {
    case 'CONFIRMED':
      return 'up';
    case 'PROBABLE':
      return 'info';
    case 'AMBIGUOUS':
      return 'ambiguous';
    default:
      return 'down';
  }
}

function friendlyError(message: string): string {
  const text = message.toLowerCase();
  if (/credential not configured|credencial/.test(text)) {
    return 'Credencial SNMP/SSH indisponível para este equipamento';
  }
  if (/not enabled|não está habilitad/.test(text)) {
    return 'Acesso SNMP/SSH não está habilitado para este equipamento';
  }
  if (/no ssh driver|no ssh transport/.test(text)) {
    return 'Driver SSH indisponível para este fabricante';
  }
  if (/timeout|timed ?out|econnrefused|unreachable|enetunreach/.test(text)) {
    return 'Equipamento não respondeu LLDP (timeout/conexão)';
  }
  return message;
}

export function AssistedDiscoveryReview({
  host,
  mapId,
  onApplied,
}: {
  host: HostRecord;
  mapId: string;
  onApplied?: () => void;
}) {
  const [preview, setPreview] = useState<LldpTopologyPreview | null>(null);
  const [selections, setSelections] = useState<Record<string, LldpApplySelection>>({});
  const [pending, setPending] = useState<'preview' | 'apply' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const setMap = useMapStore((state) => state.setMap);

  const selectedCount = useMemo(
    () =>
      Object.values(selections).filter((selection) => selection.action === 'CREATE_LINK').length,
    [selections],
  );

  const loadPreview = async () => {
    setPending('preview');
    setMessage(null);
    try {
      const result = await previewHostLldp(host.id, mapId);
      setPreview(result);
      setSelections(
        Object.fromEntries(
          result.adjacencies.map((adjacency) => [
            adjacency.id,
            { adjacencyId: adjacency.id, action: defaultAction(adjacency) },
          ]),
        ),
      );
    } catch (error) {
      setMessage(friendlyError(error instanceof Error ? error.message : ''));
    } finally {
      setPending(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setPending('apply');
    setMessage(null);
    try {
      const result = await applyLldp(mapId, preview.id, Object.values(selections));
      const refreshed = await getMap(mapId);
      setMap(refreshed);
      setMessage(
        `${result.createdLinks.length} enlace(s) criado(s) · ${result.skipped.length} ignorado(s).`,
      );
      setPreview(null);
      onApplied?.();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'A revisão expirou ou não pôde ser aplicada.',
      );
    } finally {
      setPending(null);
    }
  };

  if (!preview) {
    return (
      <div className="discovery-empty">
        <Radar size={22} />
        <strong>Descoberta LLDP</strong>
        <p>Consulta LLDP por SNMP e usa SSH como fallback. O preview não altera o mapa.</p>
        <Button variant="primary" onClick={() => void loadPreview()} disabled={pending !== null}>
          {pending === 'preview' ? (
            <LoaderCircle className="spin" size={15} />
          ) : (
            <Radar size={15} />
          )}
          Descobrir vizinhos
        </Button>
        {message && <small>{message}</small>}
      </div>
    );
  }

  return (
    <div className="discovery-review">
      <div className="discovery-review__summary">
        <div>
          <strong>{preview.adjacencies.length} adjacência(s) encontrada(s)</strong>
          <span>
            {preview.stats.confirmed} confirmada · {preview.stats.probable} provável ·{' '}
            {preview.stats.ambiguous} ambígua
          </span>
        </div>
        <Button compact variant="ghost" onClick={() => void loadPreview()}>
          Atualizar preview
        </Button>
      </div>
      {preview.warnings.map((warning) => (
        <div className="discovery-warning" key={warning}>
          <TriangleAlert size={13} /> {warning}
        </div>
      ))}
      <div className="discovery-neighbors">
        {preview.adjacencies.map((adjacency) => {
          const selection = selections[adjacency.id]!;
          const disabled = adjacency.duplicate || Boolean(adjacency.existingLinkId);
          return (
            <article key={adjacency.id} className="discovery-neighbor">
              <header>
                <div>
                  <strong>{adjacency.targetHostname}</strong>
                  <span>
                    {adjacency.sourceHostname} · {adjacency.sourcePort} → {adjacency.targetPort}
                  </span>
                </div>
                <Badge tone={confidenceTone(adjacency.confidence)}>
                  {adjacency.confidence}
                </Badge>
              </header>
              <select
                value={selection.action}
                disabled={disabled}
                onChange={(event) =>
                  setSelections((current) => ({
                    ...current,
                    [adjacency.id]: {
                      adjacencyId: adjacency.id,
                      action: event.target.value as LldpApplyAction,
                    },
                  }))
                }
              >
                <option value="CREATE_LINK">Criar link</option>
                <option value="IGNORE">Ignorar</option>
              </select>
              <dl>
                <div>
                  <dt>Fonte</dt>
                  <dd>{adjacency.source.replace('LLDP_', '')}</dd>
                </div>
                <div>
                  <dt>Endereço remoto</dt>
                  <dd>{adjacency.targetManagementAddress ?? '—'}</dd>
                </div>
                <div>
                  <dt>Interface local</dt>
                  <dd>{adjacency.sourceInterfaceId ?? 'não resolvida'}</dd>
                </div>
                <div>
                  <dt>Interface remota</dt>
                  <dd>{adjacency.targetInterfaceId ?? 'não resolvida'}</dd>
                </div>
              </dl>
              {adjacency.reasons.length > 0 && <small>{adjacency.reasons.join(' · ')}</small>}
              {disabled && (
                <small>
                  <CheckCircle2 size={12} /> Link já existe
                </small>
              )}
            </article>
          );
        })}
      </div>
      <footer>
        <span>{selectedCount} selecionado(s)</span>
        <Button
          variant="primary"
          disabled={pending !== null || selectedCount === 0}
          onClick={() => void apply()}
        >
          {pending === 'apply' && <LoaderCircle className="spin" size={15} />}
          Aplicar selecionados
        </Button>
      </footer>
      {message && <div className="discovery-result">{message}</div>}
    </div>
  );
}
