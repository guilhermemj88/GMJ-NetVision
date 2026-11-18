'use client';

import {
  ChevronDown,
  Compass,
  Globe,
  LogOut,
  MapPinned,
  MonitorPlay,
  Settings,
  Sparkles,
  Users,
} from 'lucide-react';
import { useMapStore } from '@/store/map-store';
import { useAuth } from '@/app/providers';

/**
 * Menu overflow do celular: concentra as acoes secundarias que nao cabem na
 * topbar compacta (selecao de mapa, NOC, edicao, descoberta, links, ajustes e
 * usuarios). Uma unica implementacao — nao existe outro menu mobile.
 *
 * Controlado por `mobileMenuOpen` no proprio store do mapa, entao abrir/fechar
 * segue a mesma fonte de verdade da UI desktop.
 */
export function MobileActionsSheet() {
  const open = useMapStore((state) => state.mobileMenuOpen);
  const setOpen = useMapStore((state) => state.setMobileMenuOpen);
  const maps = useMapStore((state) => state.maps);
  const activeMapId = useMapStore((state) => state.activeMapId);
  const setActiveMap = useMapStore((state) => state.setActiveMap);
  const view = useMapStore((state) => state.view);
  const editMode = useMapStore((state) => state.editMode);
  const setEditMode = useMapStore((state) => state.setEditMode);
  const setPanel = useMapStore((state) => state.setPanel);
  const { user, logout } = useAuth();

  if (!open) return null;

  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="mobile-sheet" role="presentation">
      <button
        type="button"
        className="mobile-sheet__scrim"
        aria-label="Fechar menu"
        onClick={() => setOpen(false)}
      />
      <div className="mobile-sheet__panel" role="dialog" aria-modal="true" aria-label="Menu de ações">
        <header className="mobile-sheet__header">
          <strong>Ações</strong>
          <button type="button" className="mobile-sheet__close" onClick={() => setOpen(false)}>
            Fechar
          </button>
        </header>

        {view === 'MAP' && maps.length > 0 && (
          <label className="mobile-sheet__field">
            <span>MAPA ATIVO</span>
            <div>
              <select
                value={activeMapId ?? ''}
                onChange={(event) => setActiveMap(event.target.value)}
              >
                {maps.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} aria-hidden="true" />
            </div>
          </label>
        )}

        <div className="mobile-sheet__actions">
          {view === 'MAP' && (
            <>
              <button type="button" onClick={run(() => setPanel('maps'))}>
                <MapPinned size={16} /> Gerenciar mapas
              </button>
              <button type="button" onClick={run(() => setPanel('rotation'))}>
                <MonitorPlay size={16} /> NOC
              </button>
              <button type="button" onClick={run(() => setEditMode(!editMode))}>
                <Compass size={16} /> {editMode ? 'Sair da edição' : 'Editar mapa'}
              </button>
              <button type="button" onClick={run(() => setPanel('discovery'))}>
                <Sparkles size={16} /> Descobrir
              </button>
              <button type="button" onClick={run(() => setPanel('public-links'))}>
                <Globe size={16} /> Links públicos
              </button>
              <button type="button" onClick={run(() => setPanel('settings'))}>
                <Settings size={16} /> Configurações
              </button>
              {user?.role === 'ADMIN' && (
                <button type="button" onClick={run(() => setPanel('users'))}>
                  <Users size={16} /> Usuários
                </button>
              )}
            </>
          )}
          <button type="button" className="is-danger" onClick={run(() => void logout())}>
            <LogOut size={16} /> Sair
          </button>
        </div>
      </div>
    </div>
  );
}
