'use client';

import { ReactFlowProvider } from '@xyflow/react';
import { ActionPanels } from './action-panels';
import { ContextDrawer } from './context-drawer';
import { NetworkCanvas } from './network-canvas';
import { TopBar } from './top-bar';
import { NocControls } from './noc-controls';
import { useMapStore } from '@/store/map-store';

export function NetworkWorkspace() {
  const toast = useMapStore((state) => state.toast);
  const rotation = useMapStore((state) => state.rotation);
  const topBarHidden = rotation.active && rotation.hideTopBar;
  return (
    <div
      className={`netvision-app ${rotation.active ? 'netvision-app--noc' : ''} ${topBarHidden ? 'netvision-app--noc-no-topbar' : ''}`}
    >
      {!topBarHidden && <TopBar />}
      <ReactFlowProvider>
        <NetworkCanvas />
      </ReactFlowProvider>
      <ContextDrawer />
      <ActionPanels />
      <NocControls />
      {toast && (
        <div className="toast">
          <span />
          {toast}
        </div>
      )}
    </div>
  );
}
