'use client';

import { ReactFlowProvider } from '@xyflow/react';
import { ActionPanels } from './action-panels';
import { ContextDrawer } from './context-drawer';
import { NetworkCanvas } from './network-canvas';
import { TopBar } from './top-bar';
import { useMapStore } from '@/store/map-store';

export function NetworkWorkspace() {
  const toast = useMapStore((state) => state.toast);
  return (
    <div className="netvision-app">
      <TopBar />
      <ReactFlowProvider>
        <NetworkCanvas />
      </ReactFlowProvider>
      <ContextDrawer />
      <ActionPanels />
      {toast && (
        <div className="toast">
          <span />
          {toast}
        </div>
      )}
    </div>
  );
}
