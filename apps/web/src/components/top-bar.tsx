'use client';

import { Badge, Button } from '@gmj/ui';
import {
  BellRing,
  ChevronDown,
  Compass,
  Globe,
  LogOut,
  MapPinned,
  MonitorPlay,
  Network,
  Server,
  Settings,
  Sparkles,
  Users,
  Warehouse,
} from 'lucide-react';
import { useMapStore } from '@/store/map-store';
import { useAuth } from '@/app/providers';
import { FreshnessTag } from './freshness-tag';
import { newestCollectionStamp } from '@/lib/map-freshness';
import { GlobalInterfaceSearch } from './global-interface-search';
import { alertCenterAttentionCount } from '@gmj/shared';
import { useAlertCenterSummary } from '@/lib/use-alert-center';
import {
  isVisualModeSelectorEnabled,
  useMapVisualMode,
  useSetMapVisualMode,
} from '@/lib/map-visual-v2-preview';
import {
  useLinkV2AnimationMode,
  useSetLinkV2AnimationMode,
} from '@/lib/map-visual-v2-animation';
import type { LinkV2AnimationMode } from '@/lib/map-visual-v2-weathermap';
import type { MapVisualMode } from '@gmj/shared';

export function TopBar() {
  const map = useMapStore((state) => state.map);
  const maps = useMapStore((state) => state.maps);
  const activeMapId = useMapStore((state) => state.activeMapId);
  const setActiveMap = useMapStore((state) => state.setActiveMap);
  const editMode = useMapStore((state) => state.editMode);
  const setEditMode = useMapStore((state) => state.setEditMode);
  const setPanel = useMapStore((state) => state.setPanel);
  const view = useMapStore((state) => state.view);
  const setView = useMapStore((state) => state.setView);
  const { user, logout } = useAuth();
  const authRequired = Boolean(user);
  // Mesma leitura da Central (cache compartilhado): nada de polling paralelo.
  const attention = alertCenterAttentionCount(useAlertCenterSummary(authRequired));
  /**
   * MAP-VISUAL-V2: seletor de visual SOMENTE no preview. Não grava nada no
   * mapa — a escolha vive na aba do operador (ver lib/map-visual-v2-preview).
   */
  const visualMode = useMapVisualMode(map?.settings.filters);
  const setVisualMode = useSetMapVisualMode();
  const showVisualSelector = isVisualModeSelectorEnabled();
  const animationMode = useLinkV2AnimationMode();
  const setAnimationMode = useSetLinkV2AnimationMode();
  if (!map && view === 'MAP') return <header className="topbar topbar--loading" />;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand__mark">
          <span />
          <span />
          <span />
        </span>
        <div>
          <strong>GMJ</strong>
          <span>NETVISION</span>
        </div>
      </div>
      <div className="topbar__divider" />
      <nav className="primary-nav">
        <button
          type="button"
          className={view === 'PHYSICAL' ? 'is-active' : ''}
          onClick={() => setView('PHYSICAL')}
        >
          <Warehouse size={14} /> Físico
        </button>
        <button
          type="button"
          className={view === 'MAP' ? 'is-active' : ''}
          onClick={() => setView('MAP')}
        >
          <MapPinned size={14} /> Mapa
        </button>
        <button
          type="button"
          className={view === 'HOSTS' ? 'is-active' : ''}
          onClick={() => setView('HOSTS')}
        >
          <Server size={14} /> Hosts
        </button>
        <button
          type="button"
          className={view === 'BGP' ? 'is-active' : ''}
          onClick={() => setView('BGP')}
        >
          <Network size={14} /> BGP
        </button>
        <button
          type="button"
          className={view === 'ALERTS' ? 'is-active' : ''}
          onClick={() => setView('ALERTS')}
        >
          <BellRing size={14} /> Alertas
          {attention > 0 ? (
            <span className="primary-nav__badge" aria-label={`${attention} alertas exigindo atenção`}>
              {attention}
            </span>
          ) : null}
        </button>
      </nav>
      {view === 'MAP' && map && (
        <>
          <div className="topbar__divider" />
          <label className="map-selector">
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
              <ChevronDown size={13} />
            </div>
          </label>
          <Button
            compact
            variant="ghost"
            aria-label="Gerenciar mapas"
            onClick={() => setPanel('maps')}
          >
            <MapPinned size={15} />
          </Button>
          <Badge tone="hybrid">{map.mode}</Badge>
          {showVisualSelector && (
            <label className="map-selector map-selector--visual" data-testid="map-visual-selector">
              <span>VISUAL DO MAPA</span>
              <div>
                <select
                  value={visualMode}
                  onChange={(event) => setVisualMode(event.target.value as MapVisualMode)}
                  aria-label="Visual do mapa"
                >
                  <option value="V1">Clássico (V1)</option>
                  <option value="V2">Moderno (V2)</option>
                </select>
                <ChevronDown size={13} />
              </div>
            </label>
          )}
          {showVisualSelector && visualMode === 'V2' && (
            <label className="map-selector map-selector--visual" data-testid="map-animation-selector">
              <span>ANIMAÇÃO</span>
              <div>
                <select
                  value={animationMode}
                  onChange={(event) =>
                    setAnimationMode(event.target.value as LinkV2AnimationMode)
                  }
                  aria-label="Animação dos enlaces"
                >
                  <option value="off">Desligada</option>
                  <option value="smart">Inteligente (padrão)</option>
                  <option value="always">Sempre ativa</option>
                </select>
                <ChevronDown size={13} />
              </div>
            </label>
          )}
        </>
      )}
      {/* Busca global de interface disponível em TODAS as áreas, não só no Mapa. */}
      <GlobalInterfaceSearch />
      <div className="topbar__spacer" />
      <div className="source-status" title="Os dados desta tela vêm da API NetVision">
        <span className="source-status__dot" />
        <span>FONTE</span>
        <strong>API</strong>
      </div>
      {map ? (
        <FreshnessTag
          at={newestCollectionStamp(map.devices)}
          label="Coleta"
          unavailable="sem carimbo de coleta"
        />
      ) : null}
      {view === 'MAP' && (
        <>
          <Button compact variant="ghost" onClick={() => setPanel('rotation')}>
            <MonitorPlay size={15} /> NOC
          </Button>
          <Button
            compact
            variant={editMode ? 'primary' : 'secondary'}
            onClick={() => setEditMode(!editMode)}
          >
            <Compass size={15} /> {editMode ? 'Edição ativa' : 'Editar mapa'}
          </Button>
          <Button compact variant="ghost" onClick={() => setPanel('discovery')}>
            <Sparkles size={15} /> Descobrir
          </Button>
          <Button
            compact
            variant="ghost"
            aria-label="Links públicos"
            onClick={() => setPanel('public-links')}
          >
            <Globe size={15} /> Links
          </Button>
          <Button
            compact
            variant="ghost"
            aria-label="Configurações"
            onClick={() => setPanel('settings')}
          >
            <Settings size={16} />
          </Button>
          {user?.role === 'ADMIN' && (
            <Button
              compact
              variant="ghost"
              aria-label="Usuários e senhas"
              onClick={() => setPanel('users')}
            >
              <Users size={15} /> Usuários
            </Button>
          )}
        </>
      )}
      <div className="topbar__divider" />
      {user && <span className="topbar-user" title={user.email}>{user.name || user.username}</span>}
      <Button compact variant="ghost" aria-label="Sair" title="Sair" onClick={() => void logout()}>
        <LogOut size={15} />
      </Button>
    </header>
  );
}
