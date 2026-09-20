'use client';

import { ChevronDown, Search } from 'lucide-react';
import type { BgpHistoryPeriod, BgpScope, BgpStateFilter } from '@gmj/shared';

interface BgpFiltersProps {
  scope: BgpScope;
  state: BgpStateFilter;
  period: BgpHistoryPeriod;
  search: string;
  onScopeChange: (scope: BgpScope) => void;
  onStateChange: (state: BgpStateFilter) => void;
  onPeriodChange: (period: BgpHistoryPeriod) => void;
  onSearchChange: (search: string) => void;
}

const periods: BgpHistoryPeriod[] = ['1h', '6h', '24h', '7d'];

export function BgpFilters(props: BgpFiltersProps) {
  return (
    <div className="hosts-filters bgp-filters">
      <div className="toggle-option">
        <button
          type="button"
          className={props.scope === 'monitored' ? 'is-active' : ''}
          onClick={() => props.onScopeChange('monitored')}
        >
          <span />
          Monitorados
        </button>
        <button
          type="button"
          className={props.scope === 'all' ? 'is-active' : ''}
          onClick={() => props.onScopeChange('all')}
        >
          <span />
          Todos com BGP
        </button>
      </div>

      <label className="bgp-select">
        <span>ESTADO</span>
        <select
          value={props.state}
          onChange={(event) => props.onStateChange(event.target.value as BgpStateFilter)}
        >
          <option value="all">Todos</option>
          <option value="up">UP</option>
          <option value="down">DOWN</option>
        </select>
        <ChevronDown size={13} />
      </label>

      <label className="bgp-select">
        <span>PERÍODO</span>
        <select
          value={props.period}
          onChange={(event) => props.onPeriodChange(event.target.value as BgpHistoryPeriod)}
        >
          {periods.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <ChevronDown size={13} />
      </label>

      <div className="hosts-search">
        <Search size={13} />
        <input
          value={props.search}
          placeholder="Buscar por peer, nome, ASN ou hostname"
          onChange={(event) => props.onSearchChange(event.target.value)}
        />
      </div>
    </div>
  );
}
