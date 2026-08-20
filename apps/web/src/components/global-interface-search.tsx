'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LoaderCircle, MapPinned, Search, Server } from 'lucide-react';
import type { InterfaceSearchResult } from '@gmj/shared';
import { searchInterfaces } from '@/lib/api';
import { useMapStore } from '@/store/map-store';

export function GlobalInterfaceSearch() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const activeMapId = useMapStore((state) => state.activeMapId);
  const openInterfaceOnMap = useMapStore((state) => state.openInterfaceOnMap);
  const openHostDetails = useMapStore((state) => state.openHostDetails);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setDebouncedQuery('');
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const resultsQuery = useQuery({
    queryKey: ['interface-search', debouncedQuery],
    queryFn: () => searchInterfaces(debouncedQuery, 40),
    enabled: debouncedQuery.length >= 2,
    staleTime: 15_000,
  });

  const finish = () => {
    setOpen(false);
    setQuery('');
    setDebouncedQuery('');
  };
  const openOnMap = (result: InterfaceSearchResult, mapId: string) => {
    openInterfaceOnMap(result, mapId);
    finish();
  };

  return (
    <div ref={rootRef} className={`global-interface-search ${open ? 'is-open' : ''}`}>
      <Search size={14} />
      <input
        value={query}
        aria-label="Buscar interfaces no inventário"
        placeholder="Buscar interface, alias, ifIndex ou IP"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {resultsQuery.isFetching && <LoaderCircle className="spin" size={14} />}
      {open && query.trim().length > 0 && (
        <div className="global-interface-search__popover" role="dialog" aria-label="Resultados da busca de interfaces">
          {query.trim().length < 2 ? (
            <div className="global-interface-search__message">Digite pelo menos 2 caracteres</div>
          ) : resultsQuery.isError ? (
            <div className="global-interface-search__message is-error">Não foi possível consultar o inventário</div>
          ) : !resultsQuery.isFetching && resultsQuery.data?.length === 0 ? (
            <div className="global-interface-search__message">Nenhuma interface encontrada</div>
          ) : (
            <div className="global-interface-search__results">
              {(resultsQuery.data ?? []).map((result) => {
                const currentMap = result.maps.find((map) => map.id === activeMapId);
                const details = [...new Set([result.alias, result.description].filter(Boolean))].join(' · ');
                return (
                  <article key={result.interfaceId}>
                    <div className="global-interface-search__result-head">
                      <span className={`port-dot status-${result.status.toLowerCase()}`} />
                      <span>
                        <strong>{result.hostname || result.deviceName}</strong>
                        <b>{result.interfaceName}</b>
                        {details && <small>{details}</small>}
                      </span>
                      <em>{result.status}</em>
                    </div>
                    <div className="global-interface-search__meta">
                      <span>ifIndex {result.ifIndex}</span>
                      {result.ip && <span>IP {result.ip}</span>}
                      {result.vlan !== null && <span>VLAN {result.vlan}</span>}
                    </div>
                    <div className="global-interface-search__actions">
                      {currentMap && (
                        <button type="button" onClick={() => openOnMap(result, currentMap.id)}>
                          <MapPinned size={12} /> Abrir no mapa atual
                        </button>
                      )}
                      {result.maps.filter((map) => map.id !== activeMapId).map((map) => (
                        <button type="button" key={map.id} onClick={() => openOnMap(result, map.id)}>
                          <MapPinned size={12} /> {map.name}
                        </button>
                      ))}
                      {result.maps.length === 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            openHostDetails(result.deviceId);
                            finish();
                          }}
                        >
                          <Server size={12} /> Abrir detalhes do host
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
