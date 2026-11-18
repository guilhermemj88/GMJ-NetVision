'use client';

import { MapPinned, Network, Server, Warehouse } from 'lucide-react';
import { useMapStore } from '@/store/map-store';
import type { WorkspaceView } from '@/store/map-store';

interface MobileNavItem {
  view: WorkspaceView;
  label: string;
  Icon: typeof MapPinned;
}

/**
 * Ordem = prioridade operacional no celular: Mapa primeiro porque e a tela de
 * uso diario; o resto segue a ordem do produto.
 */
export const MOBILE_NAV_ITEMS: readonly MobileNavItem[] = [
  { view: 'MAP', label: 'Mapa', Icon: MapPinned },
  { view: 'HOSTS', label: 'Hosts', Icon: Server },
  { view: 'BGP', label: 'BGP', Icon: Network },
  { view: 'PHYSICAL', label: 'Físico', Icon: Warehouse },
];

/**
 * Navegacao inferior do celular.
 *
 * Reusa `view`/`setView` do `useMapStore` — nao existe store mobile paralelo, a
 * barra e apenas uma segunda apresentacao do mesmo estado. A topbar desktop
 * continua com a navegacao completa; esta so aparece em telas pequenas.
 */
export function MobileNav() {
  const view = useMapStore((state) => state.view);
  const setView = useMapStore((state) => state.setView);

  return (
    <nav className="mobile-nav" aria-label="Navegação principal">
      {MOBILE_NAV_ITEMS.map(({ view: itemView, label, Icon }) => {
        const active = view === itemView;
        return (
          <button
            key={itemView}
            type="button"
            className={`mobile-nav__item ${active ? 'is-active' : ''}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => setView(itemView)}
          >
            <Icon size={20} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
