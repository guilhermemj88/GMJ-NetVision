'use client';

import { useId, useMemo, useState } from 'react';
import type { HostRecord } from '@gmj/shared';
import { HOST_RESULT_LIMIT, hostAddress, searchHosts } from './host-search';
import styles from './central.module.css';

type PickerHost = Pick<HostRecord, 'id' | 'name'> & Partial<Pick<HostRecord, 'displayName' | 'hostname' | 'detectedHostname' | 'managementIp' | 'ip' | 'vendor' | 'model'>>;

/**
 * Seletor EQUIPAMENTO: busca por nome ou IP nos hosts reais cadastrados. Escolher um equipamento so atualiza a
 * selecao local; nenhuma consulta ao equipamento e feita (o inventario VSI vem do banco, pela pagina).
 */
export function HostPicker({
  hosts,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  hosts: readonly PickerHost[];
  loading: boolean;
  error: string | null;
  selectedId: string;
  onSelect: (hostId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const listId = useId();
  const { items, total } = useMemo(() => searchHosts(hosts, query), [hosts, query]);
  const selected = hosts.find((host) => host.id === selectedId) ?? null;

  return (
    <div className={styles.field} data-host-picker>
      <label className={styles.label} htmlFor={`${listId}-q`}>
        Equipamento
      </label>
      <input
        id={`${listId}-q`}
        type="search"
        className={styles.input}
        placeholder="Buscar por nome ou IP"
        aria-label="Buscar equipamento por nome ou IP"
        aria-controls={listId}
        autoComplete="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {selected ? (
        <p className={styles.selected} data-selected-host>
          <strong>{selected.name}</strong>
          <span className={styles.mono}>{hostAddress(selected) || 'sem IP'}</span>
          <button type="button" className={styles.link} onClick={() => onSelect('')}>
            Limpar
          </button>
        </p>
      ) : null}
      {loading ? <p className={styles.note}>Carregando equipamentos cadastrados…</p> : null}
      {error ? (
        <p className={styles.error} role="alert">
          Não foi possível carregar os equipamentos: {error}
        </p>
      ) : null}
      {!loading && !error && hosts.length === 0 ? (
        <p className={styles.empty} data-empty="hosts">
          Nenhum equipamento cadastrado no NetVision.
        </p>
      ) : null}
      {!loading && !error && hosts.length > 0 ? (
        <>
          <ul id={listId} className={styles.options} role="listbox" aria-label="Equipamentos encontrados" data-host-options>
            {items.map((host) => {
              const active = host.id === selectedId;
              return (
                <li key={host.id} role="option" aria-selected={active}>
                  <button type="button" className={`${styles.option} ${active ? styles.optionActive : ''}`} onClick={() => onSelect(host.id)} data-host-id={host.id}>
                    <span className={styles.optionName}>{host.name}</span>
                    <span className={styles.optionMeta}>
                      <span className={styles.mono}>{hostAddress(host) || 'sem IP'}</span>
                      {host.vendor ? <span>{[host.vendor, host.model].filter(Boolean).join(' ')}</span> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {items.length === 0 ? (
            <p className={styles.empty} data-empty="search">
              Nenhum equipamento corresponde a “{query.trim()}”.
            </p>
          ) : null}
          <p className={styles.note} aria-live="polite">
            {total > HOST_RESULT_LIMIT ? `Mostrando ${HOST_RESULT_LIMIT} de ${total}: refine a busca.` : `${total} equipamento${total === 1 ? '' : 's'}.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
