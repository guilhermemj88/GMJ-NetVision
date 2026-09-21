'use client';

import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { ActionPanels } from './action-panels';
import { ContextDrawer } from './context-drawer';
import { NetworkCanvas } from './network-canvas';
import { TopBar } from './top-bar';
import { NocControls } from './noc-controls';
import { useMapStore } from '@/store/map-store';
import { HostsWorkspace } from './hosts-workspace';
import { BgpWorkspace } from './bgp/bgp-workspace';
import { PhysicalWorkspace } from './physical/physical-workspace';

export function NetworkWorkspace({ publicMode = false }: { publicMode?: boolean }) {
  const toast = useMapStore((state) => state.toast);
  const rotation = useMapStore((state) => state.rotation);
  const view = useMapStore((state) => state.view);
  const setView = useMapStore((state) => state.setView);
  const readOnly = useMapStore((state) => state.readOnly);
  const fullBleed = rotation.active && rotation.hideTopBar;

  useEffect(() => {
    if (publicMode) return;
    const requested = new URLSearchParams(window.location.search).get('view');
    if (requested === 'hosts') setView('HOSTS');
    else if (requested === 'physical' || requested === 'fisico') setView('PHYSICAL');
    else if (requested === 'bgp') setView('BGP');
  }, [publicMode, setView]);

  return (
    <div
      className={`netvision-app ${rotation.active ? 'netvision-app--noc' : ''} ${fullBleed ? 'netvision-app--noc-no-topbar' : ''}`}
    >
      {!fullBleed && (publicMode ? (
        <header className="topbar topbar--placeholder" aria-hidden="true" />
      ) : (
        <TopBar />
      ))}
      {view === 'HOSTS' && !publicMode ? (
        <HostsWorkspace />
      ) : view === 'PHYSICAL' && !publicMode ? (
        <PhysicalWorkspace />
      ) : view === 'BGP' && !publicMode ? (
        <BgpWorkspace />
      ) : (
        <>
          <ReactFlowProvider>
            <NetworkCanvas readOnly={readOnly} />
          </ReactFlowProvider>
          <ContextDrawer />
          {!publicMode && <ActionPanels />}
          <NocControls />
        </>
      )}
      {toast && (
        <div className="toast">
          <span />
          {toast}
        </div>
      )}
    </div>
  );
}
