'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { NetworkInterface } from '@gmj/shared';

export type InterfaceFilter = 'ALL' | 'UP' | 'DOWN';

const naturalCollator = new Intl.Collator('pt-BR', {
  numeric: true,
  sensitivity: 'base',
  ignorePunctuation: false,
});

function interfaceTypeRank(name: string): number {
  const normalized = name.trim().toLocaleLowerCase('pt-BR');
  if (normalized.includes('.')) return 2;
  if (/^(?:eth-?trunk|port-?channel|bundle-?ether)/.test(normalized)) return 1;
  if (/^vlan(?:if|interface)?/.test(normalized)) return 3;
  if (/^loopback/.test(normalized)) return 4;
  if (/^(?:\d+ge|ge|x?gigabitethernet|ethernet|fastethernet|tengigabitethernet|twentyfivegigabitethernet|fortygigabitethernet|hundredgigabitethernet)[\d/]/.test(normalized)) return 0;
  return 5;
}

export function compareInterfaces(left: NetworkInterface, right: NetworkInterface): number {
  return interfaceTypeRank(left.name) - interfaceTypeRank(right.name)
    || naturalCollator.compare(left.name, right.name)
    || left.ifIndex - right.ifIndex
    || naturalCollator.compare(left.id, right.id);
}

export function filterAndSortInterfaces(
  interfaces: NetworkInterface[],
  query: string,
  filter: InterfaceFilter,
): NetworkInterface[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR');
  return interfaces
    .filter((item) => {
      if (filter !== 'ALL' && item.operStatus !== filter) return false;
      if (!normalizedQuery) return true;
      return [item.name, item.alias, item.description, String(item.ifIndex)]
        .some((value) => value.toLocaleLowerCase('pt-BR').includes(normalizedQuery));
    })
    .sort(compareInterfaces);
}

export function firstInterfaceId(interfaces: NetworkInterface[]): string {
  return [...interfaces].sort(compareInterfaces)[0]?.id ?? '';
}

function secondaryText(item: NetworkInterface): string {
  return [...new Set([item.alias.trim(), item.description.trim()].filter(Boolean))].join(' · ');
}

export function InterfacePicker({
  interfaces,
  value,
  onChange,
  placeholder = 'Selecione uma interface',
}: {
  interfaces: NetworkInterface[];
  value: string;
  onChange: (interfaceId: string) => void;
  placeholder?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InterfaceFilter>('ALL');
  const selected = interfaces.find((item) => item.id === value);
  const results = filterAndSortInterfaces(interfaces, query, filter);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`interface-picker ${open ? 'is-open' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="interface-picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <strong>{selected?.name ?? placeholder}</strong>
          {selected && <small>{secondaryText(selected) || `ifIndex ${selected.ifIndex}`}</small>}
        </span>
        {selected && <em className={`status-${selected.operStatus.toLowerCase()}`}>{selected.operStatus}</em>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="interface-picker__popover">
          <div className="interface-picker__search">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              placeholder="Nome, alias, descrição ou ifIndex"
              aria-label="Pesquisar interfaces"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="interface-picker__filters" aria-label="Filtrar por status">
            {(['ALL', 'UP', 'DOWN'] as const).map((status) => (
              <button
                type="button"
                key={status}
                className={filter === status ? 'is-active' : ''}
                onClick={() => setFilter(status)}
              >
                {status === 'ALL' ? 'Todas' : status}
              </button>
            ))}
            <span>{results.length}</span>
          </div>
          <div className="interface-picker__results" role="listbox" aria-label="Interfaces">
            {results.map((item) => {
              const details = secondaryText(item);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={item.id === value}
                  key={item.id}
                  onClick={() => {
                    onChange(item.id);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  <span className={`port-dot status-${item.operStatus.toLowerCase()}`} />
                  <span>
                    <strong>{item.name}</strong>
                    {details && <small>{details}</small>}
                  </span>
                  <span className="interface-picker__meta">
                    <em>{item.operStatus}</em>
                    <small>ifIndex {item.ifIndex}</small>
                  </span>
                  {item.id === value && <Check size={13} />}
                </button>
              );
            })}
            {results.length === 0 && (
              <div className="interface-picker__empty">Nenhuma interface encontrada</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function InterfaceMultiPicker({
  interfaces,
  value,
  onChange,
}: {
  interfaces: NetworkInterface[];
  value: string[];
  onChange: (interfaceIds: string[]) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<InterfaceFilter>('ALL');
  const results = filterAndSortInterfaces(interfaces, query, filter);
  const selected = interfaces.filter((item) => value.includes(item.id));

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  const toggle = (interfaceId: string) => {
    onChange(
      value.includes(interfaceId)
        ? value.filter((item) => item !== interfaceId)
        : [...value, interfaceId],
    );
  };

  return (
    <div
      ref={rootRef}
      className={`interface-picker interface-multi-picker ${open ? 'is-open' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="interface-picker__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>
          <strong>
            {selected.length ? `${selected.length} interface${selected.length > 1 ? 's' : ''}` : 'Selecione interfaces'}
          </strong>
          {selected.length > 0 && <small>{selected.map((item) => item.name).join(', ')}</small>}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="interface-picker__popover">
          <div className="interface-picker__search">
            <Search size={14} />
            <input
              autoFocus
              value={query}
              placeholder="Nome, alias, descrição ou ifIndex"
              aria-label="Pesquisar interfaces"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="interface-picker__filters" aria-label="Filtrar por status">
            {(['ALL', 'UP', 'DOWN'] as const).map((status) => (
              <button
                type="button"
                key={status}
                className={filter === status ? 'is-active' : ''}
                onClick={() => setFilter(status)}
              >
                {status === 'ALL' ? 'Todas' : status}
              </button>
            ))}
            <span>{results.length}</span>
          </div>
          <div className="interface-picker__results" role="listbox" aria-multiselectable="true">
            {results.map((item) => {
              const checked = value.includes(item.id);
              const details = secondaryText(item);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={checked}
                  key={item.id}
                  onClick={() => toggle(item.id)}
                >
                  <span className={`port-dot status-${item.operStatus.toLowerCase()}`} />
                  <span>
                    <strong>{item.name}</strong>
                    {details && <small>{details}</small>}
                  </span>
                  <span className="interface-picker__meta">
                    <em>{item.operStatus}</em>
                    <small>ifIndex {item.ifIndex}</small>
                  </span>
                  {checked && <Check size={13} />}
                </button>
              );
            })}
            {results.length === 0 && (
              <div className="interface-picker__empty">Nenhuma interface encontrada</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
