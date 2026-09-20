'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { getHosts, updateHost } from '@/lib/api';

export function BgpManageDevices({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: () => getHosts() });

  const toggle = useMutation({
    mutationFn: ({ hostId, enabled }: { hostId: string; enabled: boolean }) =>
      updateHost(hostId, { bgpMonitoringEnabled: enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hosts'] });
      void queryClient.invalidateQueries({ queryKey: ['bgp'] });
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
                    checked={Boolean(host.bgpMonitoringEnabled)}
                    disabled={toggle.isPending}
                    onChange={(event) =>
                      toggle.mutate({ hostId: host.id, enabled: event.target.checked })
                    }
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
        </div>
      </div>
    </div>
  );
}
