// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cloneDemoMaps } from '@gmj/shared';
import { describe, expect, it, vi } from 'vitest';
import { createLink } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { ActionPanels } from './action-panels';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  createLink: vi.fn(),
}));
vi.mock('./assisted-discovery-review', () => ({ AssistedDiscoveryReview: () => null }));

describe('creating links to conceptual nodes', () => {
  it.each(['SOURCE', 'TARGET'] as const)(
    'automatically uses SINGLE_ENDED when %s is the real device',
    async (side) => {
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
      vi.clearAllMocks();
      const map = cloneDemoMaps()[0]!;
      const deviceNode = map.nodes.find(
        (node) =>
          node.deviceId &&
          map.devices.some((device) => device.id === node.deviceId && device.interfaces.length),
      )!;
      const carrier = {
        ...deviceNode,
        id: 'carrier',
        deviceId: null,
        nodeKind: 'GENERIC' as const,
        genericType: 'carrier',
        label: 'FTI',
      };
      map.nodes = [deviceNode, carrier];
      useMapStore.setState({
        map,
        panel: 'create-link',
        readOnly: false,
        editMode: true,
        pendingLink: {
          sourceId: side === 'SOURCE' ? deviceNode.deviceId! : carrier.id,
          targetId: side === 'TARGET' ? deviceNode.deviceId! : carrier.id,
        },
        showToast: vi.fn(),
      });
      vi.mocked(createLink).mockImplementation(async (_mapId, input) => ({
        ...map.links[0]!,
        ...input,
      }));
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const client = new QueryClient({
        defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
      });
      try {
        await act(async () =>
          root.render(
            <QueryClientProvider client={client}>
              <ActionPanels />
            </QueryClientProvider>,
          ),
        );
        const mode = [...container.querySelectorAll('select')].find((select) =>
          [...select.options].some((option) => option.value === 'SINGLE_ENDED'),
        )!;
        expect(mode.value).toBe('SINGLE_ENDED');
        const submit = [...container.querySelectorAll('button')].find((button) =>
          button.textContent?.includes('Criar link'),
        )!;
        expect(submit.disabled).toBe(false);
        await act(async () => {
          submit.click();
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(createLink).toHaveBeenCalledTimes(1);
        const input = vi.mocked(createLink).mock.calls[0]![1];
        expect(input.trafficMode).toBe('SINGLE_ENDED');
        expect(side === 'SOURCE' ? input.sourceDeviceId : input.targetDeviceId).toBe(
          deviceNode.deviceId,
        );
        expect(side === 'SOURCE' ? input.sourceInterfaceId : input.targetInterfaceId).toBeTruthy();
        expect(side === 'SOURCE' ? input.targetNodeId : input.sourceNodeId).toBe(carrier.id);
        expect(side === 'SOURCE' ? input.targetInterfaceId : input.sourceInterfaceId).toBeFalsy();
        expect(side === 'SOURCE' ? input.targetDeviceId : input.sourceDeviceId).toBeFalsy();
      } finally {
        await act(async () => root.unmount());
        client.clear();
        container.remove();
        useMapStore.setState({ map: null, panel: null, pendingLink: null, editMode: false });
      }
    },
  );
});
