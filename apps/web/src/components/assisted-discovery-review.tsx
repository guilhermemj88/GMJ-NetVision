'use client';

import { useMemo, useState } from 'react';
import type {
  AssistedDiscoveredNeighbor,
  AssistedDiscoveryPreview,
  DiscoveryApplyAction,
  DiscoveryApplySelection,
  HostRecord,
} from '@gmj/shared';
import { Button } from '@gmj/ui';
import { CheckCircle2, LoaderCircle, Radar, TriangleAlert } from 'lucide-react';
import { applyAssistedDiscovery, previewAssistedDiscovery } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

function defaultAction(neighbor: AssistedDiscoveredNeighbor): DiscoveryApplyAction {
  if (neighbor.linkExists) return 'IGNORE';
  if (neighbor.mapPresent) return 'LINK_ONLY';
  if (neighbor.inventoryState === 'AMBIGUOUS' || neighbor.zabbixState === 'AMBIGUOUS') {
    return 'IGNORE';
  }
  if (neighbor.inventoryState === 'REGISTERED' || neighbor.zabbixState === 'FOUND') return 'ADD';
  return 'ADD_UNMONITORED';
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
  const [preview, setPreview] = useState<AssistedDiscoveryPreview | null>(null);
  const [selections, setSelections] = useState<Record<string, DiscoveryApplySelection>>({});
  const [pending, setPending] = useState<'preview' | 'apply' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const setMap = useMapStore((state) => state.setMap);

  const selectedCount = useMemo(
    () => Object.values(selections).filter((selection) => selection.action !== 'IGNORE').length,
    [selections],
  );

  const loadPreview = async () => {
    setPending('preview');
    setMessage(null);
    try {
      const result = await previewAssistedDiscovery(host.id, mapId);
      setPreview(result);
      setSelections(
        Object.fromEntries(
          result.neighbors.map((neighbor) => [
            neighbor.id,
            { neighborId: neighbor.id, action: defaultAction(neighbor) },
          ]),
        ),
      );
    } catch {
      setMessage('Não foi possível consultar vizinhos com segurança.');
    } finally {
      setPending(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setPending('apply');
    setMessage(null);
    try {
      const result = await applyAssistedDiscovery(host.id, preview.id, Object.values(selections));
      setMap(result.map);
      setMessage(
        `${result.addedNodes.length} nó(s) e ${result.createdLinks.length} enlace(s) aplicados.`,
      );
      setPreview(null);
      onApplied?.();
    } catch {
      setMessage('A revisão expirou ou não pôde ser aplicada. Nada foi alterado.');
    } finally {
      setPending(null);
    }
  };

  if (!preview) {
    return (
      <div className="discovery-empty">
        <Radar size={22} />
        <strong>Descoberta incremental</strong>
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
          <strong>{preview.neighbors.length} vizinho(s) encontrados</strong>
          <span>Método: {preview.method} · nenhuma alteração aplicada</span>
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
        {preview.neighbors.map((neighbor) => {
          const selection = selections[neighbor.id]!;
          return (
            <article key={neighbor.id} className="discovery-neighbor">
              <header>
                <div>
                  <strong>{neighbor.remoteSystemName}</strong>
                  <span>{neighbor.remoteManagementAddress ?? 'IP não informado'}</span>
                </div>
                <select
                  value={selection.action}
                  onChange={(event) =>
                    setSelections((current) => ({
                      ...current,
                      [neighbor.id]: {
                        ...selection,
                        action: event.target.value as DiscoveryApplyAction,
                      },
                    }))
                  }
                >
                  <option value="ADD">Adicionar nó + link</option>
                  <option value="LINK_ONLY">Criar somente link</option>
                  <option value="ADD_UNMONITORED">Adicionar não monitorado</option>
                  <option value="IGNORE">Ignorar</option>
                </select>
              </header>
              <dl>
                <div>
                  <dt>Local</dt>
                  <dd>{neighbor.localPort}</dd>
                </div>
                <div>
                  <dt>Remota</dt>
                  <dd>{neighbor.remotePort}</dd>
                </div>
                <div>
                  <dt>Inventário</dt>
                  <dd>{neighbor.inventoryState}</dd>
                </div>
                <div>
                  <dt>Zabbix</dt>
                  <dd>{neighbor.zabbixState}</dd>
                </div>
              </dl>
              {neighbor.candidateDeviceIds.length > 1 && (
                <label>
                  Correspondência ambígua
                  <select
                    value={selection.selectedDeviceId ?? ''}
                    onChange={(event) => {
                      const selectedDeviceId = event.target.value;
                      const next: DiscoveryApplySelection = selectedDeviceId
                        ? { neighborId: neighbor.id, action: 'ADD', selectedDeviceId }
                        : { neighborId: neighbor.id, action: 'IGNORE' };
                      setSelections((current) => ({ ...current, [neighbor.id]: next }));
                    }}
                  >
                    <option value="">Selecione manualmente</option>
                    {neighbor.candidateDeviceIds.map((deviceId) => (
                      <option value={deviceId} key={deviceId}>
                        {deviceId}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {neighbor.linkExists && (
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
          Adicionar selecionados
        </Button>
      </footer>
      {message && <div className="discovery-result">{message}</div>}
    </div>
  );
}
