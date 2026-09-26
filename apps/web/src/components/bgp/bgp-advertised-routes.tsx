'use client';

import { useMemo, useState } from 'react';
import type {
  BgpAdvertisedRouteDto,
  BgpAdvertisedRoutesResponse,
  BgpDashboardPeer,
} from '@gmj/shared';
import { RefreshCw, Search } from 'lucide-react';
import { getBgpPeerAdvertisedRoutes } from '@/lib/api';
import { formatRelative } from '@/lib/bgp-format';
import { AsnChip, PrependBadge } from './bgp-asn-path';

type PrependFilter = 'ALL' | 'WITH' | 'WITHOUT';
type SortKey = 'PREFIX' | 'PREPEND' | 'PATH_LENGTH';

/**
 * The collection is a one-shot SSH read triggered by the operator. Keeping it
 * in component state (instead of a polling query) is what guarantees "nada no
 * polling, nada no banco, nada automático": no interval, no window-focus
 * refetch, and a fresh command every time the button is pressed.
 */
type CollectionState =
  | { status: 'IDLE' }
  | { status: 'LOADING' }
  | { status: 'ERROR'; message: string }
  | { status: 'SUCCESS'; data: BgpAdvertisedRoutesResponse };

const SORT_LABELS: Array<{ value: SortKey; label: string }> = [
  { value: 'PREFIX', label: 'Prefixo' },
  { value: 'PREPEND', label: 'Prepend maior' },
  { value: 'PATH_LENGTH', label: 'AS path length' },
];

const FILTERS: Array<{ value: PrependFilter; label: string }> = [
  { value: 'ALL', label: 'Todos' },
  { value: 'WITH', label: 'Com prepend' },
  { value: 'WITHOUT', label: 'Sem prepend' },
];

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('pt-BR');
}

function collectionAge(fetchedAt: string): string {
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return '—';
  return formatRelative(Date.now() - parsed);
}

function sortRoutes(routes: BgpAdvertisedRouteDto[], key: SortKey): BgpAdvertisedRouteDto[] {
  const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
  return [...routes].sort((left, right) => {
    if (key === 'PREPEND') return right.prependLocal - left.prependLocal || collator.compare(left.prefix, right.prefix);
    if (key === 'PATH_LENGTH') {
      return right.asPath.length - left.asPath.length || collator.compare(left.prefix, right.prefix);
    }
    return collator.compare(left.prefix, right.prefix);
  });
}

/** Resumo da coleta. Nenhum número é inventado: só o que a CLI entregou. */
function Facts({ data }: { data: BgpAdvertisedRoutesResponse }) {
  const withPrepend = data.routes.filter((route) => route.prependLocal > 0).length;
  const maxPrepend = data.routes.reduce((max, route) => Math.max(max, route.prependLocal), 0);
  const facts: Array<[string, string, string]> = [
    [formatNumber(data.routes.length), 'prefixos anunciados', 'value'],
    [formatNumber(withPrepend), 'com prepend local', withPrepend > 0 ? 'warn' : 'value'],
    [formatNumber(maxPrepend), 'maior prepend', maxPrepend > 0 ? 'warn' : 'value'],
    [data.localAs ?? '—', 'ASN local', 'value'],
    [collectionAge(data.fetchedAt), 'idade da coleta', 'info'],
  ];
  if (data.reportedTotal !== null) {
    facts.push([formatNumber(data.reportedTotal), 'total reportado pela CLI', 'value']);
  }
  return (
    <dl className="bgp-adv__facts">
      {facts.map(([value, label, tone]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={`bgp-adv__fact--${tone}`}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RoutesTable({
  routes,
  localAs,
}: {
  routes: BgpAdvertisedRouteDto[];
  localAs: string | null;
}) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<PrependFilter>('ALL');
  const [sort, setSort] = useState<SortKey>('PREFIX');

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = routes.filter((route) => {
      if (needle && !route.prefix.toLowerCase().includes(needle)) return false;
      if (filter === 'WITH') return route.prependLocal > 0;
      if (filter === 'WITHOUT') return route.prependLocal === 0;
      return true;
    });
    return sortRoutes(filtered, sort);
  }, [routes, search, filter, sort]);

  return (
    <>
      <div className="bgp-adv__filters">
        <label className="bgp-adv__search">
          <Search size={12} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar prefixo"
            aria-label="Buscar prefixo anunciado"
          />
        </label>
        <div className="bgp-adv__segmented" role="group" aria-label="Filtrar por prepend local">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={filter === option.value ? 'is-active' : ''}
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="bgp-adv__sort">
          ORDENAR
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)}>
            {SORT_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span className="bgp-adv__counter">
          {visible.length} / {routes.length}
        </span>
      </div>

      <div className="bgp-adv__table-wrap">
        <table className="bgp-adv__table">
          <thead>
            <tr>
              <th>Prefixo</th>
              <th>Next-hop</th>
              <th className="is-number">MED</th>
              <th className="is-number">Local Pref</th>
              <th className="is-number">PrefVal</th>
              <th>AS Path</th>
              <th>Prepend local</th>
              <th>Origem</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((route) => (
              <tr
                key={route.prefix}
                className={route.prependLocal > 0 ? 'bgp-adv__row--prepend' : undefined}
              >
                <td>
                  <span className="bgp-adv__prefix">{route.prefix}</span>
                </td>
                <td className="bgp-adv__mono">{route.nextHop ?? '—'}</td>
                <td className="is-number bgp-adv__mono">{route.med ?? '—'}</td>
                <td className="is-number bgp-adv__mono">{route.localPreference ?? '—'}</td>
                <td className="is-number bgp-adv__mono">{route.preferredValue ?? '—'}</td>
                <td>
                  {route.asPath.length ? (
                    <span className="bgp-asn-path">
                      {route.asPath.map((asn, index) => (
                        <AsnChip key={`${asn}-${index}`} asn={asn} localAs={localAs} />
                      ))}
                    </span>
                  ) : (
                    <span className="bgp-adv__muted">—</span>
                  )}
                </td>
                <td>
                  <PrependBadge value={route.prependLocal} />
                </td>
                <td className="bgp-adv__mono">{route.origin ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 ? (
          <p className="bgp-adv__empty">Nenhum prefixo corresponde à busca/filtro atual.</p>
        ) : null}
      </div>
    </>
  );
}

/**
 * Aba Anúncios do detalhe do peer BGP.
 *
 * Somente leitura, sob demanda: a coleta roda por SSH apenas quando o operador
 * clica em "Carregar anúncios" e nada é persistido no banco.
 */
export function BgpAdvertisedRoutesPanel({ peer }: { peer: BgpDashboardPeer }) {
  const [state, setState] = useState<CollectionState>({ status: 'IDLE' });

  async function collect(): Promise<void> {
    setState({ status: 'LOADING' });
    try {
      const data = await getBgpPeerAdvertisedRoutes(peer.id);
      setState({ status: 'SUCCESS', data });
    } catch (error) {
      setState({
        status: 'ERROR',
        message:
          error instanceof Error
            ? error.message
            : 'Falha ao consultar os anúncios do peer no equipamento.',
      });
    }
  }

  const localAs = state.status === 'SUCCESS' ? state.data.localAs : peer.localAs;
  // "Depois da primeira coleta" = só após sucesso/erro; durante a primeira
  // coleta o botão continua dizendo "Carregar anúncios" (desabilitado).
  const hasCollected = state.status === 'SUCCESS' || state.status === 'ERROR';

  return (
    <section className="bgp-adv" aria-label="Rotas anunciadas para este peer">
      <header className="bgp-adv__header">
        <div>
          <span className="bgp-adv__eyebrow">ANÚNCIOS · ASN LOCAL {localAs ?? 'NÃO IDENTIFICADO'}</span>
          <strong className="bgp-adv__title">Rotas anunciadas para este peer</strong>
        </div>
        <span className="bgp-adv__badge-ssh">COLETADO SOB DEMANDA VIA SSH</span>
        <button
          type="button"
          className="bgp-adv__load"
          disabled={state.status === 'LOADING'}
          onClick={() => void collect()}
        >
          <RefreshCw size={13} className={state.status === 'LOADING' ? 'spin' : ''} />
          {hasCollected ? 'Atualizar anúncios' : 'Carregar anúncios'}
        </button>
      </header>

      {state.status === 'IDLE' ? (
        <div className="bgp-adv__placeholder">
          <strong>Os anúncios ainda não foram consultados.</strong>
          <p>
            A consulta é feita por SSH, sob demanda, somente quando o operador clica em
            &quot;Carregar anúncios&quot;. Nada roda no polling e nada é gravado no banco.
          </p>
        </div>
      ) : null}

      {state.status === 'LOADING' ? (
        <div className="bgp-adv__placeholder" role="status">
          <strong>Consultando o equipamento via SSH…</strong>
          <p>Executando o display de rotas anunciadas para este peer.</p>
        </div>
      ) : null}

      {state.status === 'ERROR' ? (
        <div className="bgp-adv__error" role="alert">
          <strong>Não foi possível coletar os anúncios.</strong>
          <p>{state.message}</p>
          <button type="button" className="bgp-adv__retry" onClick={() => void collect()}>
            Tentar novamente
          </button>
        </div>
      ) : null}

      {state.status === 'SUCCESS' ? (
        <>
          <Facts data={state.data} />
          {state.data.warnings.length ? (
            <ul className="bgp-adv__warnings">
              {state.data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {state.data.routes.length ? (
            <RoutesTable routes={state.data.routes} localAs={state.data.localAs} />
          ) : (
            <div className="bgp-adv__placeholder">
              <strong>A consulta não retornou nenhum prefixo anunciado para este peer.</strong>
              <p>
                Resposta do equipamento
                {state.data.reportedTotal !== null
                  ? ` · total reportado pela CLI: ${formatNumber(state.data.reportedTotal)}`
                  : ''}
                .
              </p>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
