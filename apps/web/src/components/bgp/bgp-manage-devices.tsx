'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { Button } from '@gmj/ui';
import { getHosts, updateHost } from '@/lib/api';

export function BgpManageDevices({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selection, setSelection] = useState<Record<string, boolean> | null>(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: () => getHosts() });

  useEffect(() => {
    if (hosts.data && !touched) {
      setSelection(
        Object.fromEntries(
          hosts.data.map((host) => [host.id, Boolean(host.bgpMonitoringEnabled)]),
        ),
      );
    }
  }, [hosts.data, touched]);

  const changedCount = useMemo(() => {
    if (!selection || !hosts.data) return 0;
    return hosts.data.filter(
      (host) => (selection[host.id] ?? false) !== Boolean(host.bgpMonitoringEnabled),
    ).length;
  }, [selection, hosts.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!selection || !hosts.data) return;
      const changes = hosts.data.filter(
        (host) => (selection[host.id] ?? false) !== Boolean(host.bgpMonitoringEnabled),
      );
      for (const host of changes) {
        await updateHost(host.id, { bgpMonitoringEnabled: selection[host.id] ?? false });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosts'] });
      void queryClient.invalidateQueries({ queryKey: ['bgp'] });
      onClose();
    },
    onError: (caught) => {
      setError(caught instanceof Error ? caught.message : 'Falha ao salvar alterações');
    },
  });

  const filtered = useMemo(() => {
    const text = search.trim().toLowerCase();
    const list = hosts.data ?? [];
    if (!text) return list;
    return list.filter((host) =>
      [host.hostname, host.displayName, host.vendor, host.model]
        .join(' ')
        .toLowerCase()
        .includes(text),
    );
  }, [hosts.data, search]);

  function toggle(hostId: string, enabled: boolean) {
    setTouched(true);
    setSelection((current) => ({ ...current, [hostId]: enabled }));
  }

  return (
    <div className="panel-overlay" role="dialog" aria-modal="true" aria-label="Gerenciar equipamentos BGP">
      <div className="action-panel bgp-manage">
        <header>
          <div>
            <span>MONITORAMENTO BGP</span>
            <h2>Gerenciar equipamentos</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar">
            <X size={16} />
          </button>
        </header>
        <div className="panel-body">
          <div className="hosts-search bgp-manage__search">
            <Search size={13} />
            <input
              value={search}
              placeholder="Buscar por hostname ou nome"
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <p className="bgp-manage__note">
            Equipamentos marcados participam do polling BGP automático e do dashboard. A decisão é
            manual e não é inferida por vendor/modelo.
          </p>
          <ul className="bgp-manage__list">
            {filtered.map((host) => (
              <li key={host.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selection?.[host.id] ?? Boolean(host.bgpMonitoringEnabled)}
                    disabled={save.isPending}
                    onChange={(event) => toggle(host.id, event.target.checked)}
                  />
                  <span>
                    <strong>{host.displayName || host.hostname}</strong>
                    <small>{host.hostname}</small>
                  </span>
                </label>
              </li>
            ))}
            {!filtered.length && <li className="bgp-manage__empty">Nenhum equipamento encontrado.</li>}
          </ul>
          {error && <p className="bgp-manage__error">{error}</p>}
        </div>
        <footer>
          <span>{changedCount} alteração(ões)</span>
          <Button compact variant="ghost" disabled={save.isPending} onClick={onClose}>
            Cancelar
          </Button>
          <Button
            compact
            variant="primary"
            disabled={save.isPending || changedCount === 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Salvando...' : 'Salvar alterações'}
          </Button>
        </footer>
      </div>
    </div>
  );
}

