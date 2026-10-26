import type { Page } from '@playwright/test';
import { cloneDemoMaps } from '@gmj/shared';
import { vsi1809Result } from '../../apps/web/src/components/diagnostics/result/vsi-1809.fixture';
import {
  physicalAsset,
  physicalInventory,
  physicalPort,
  physicalRack,
  physicalTemplate,
} from '../../apps/web/src/components/physical/physical-fixtures';
import {
  dashboard,
  health,
  readyProfile,
  candidateProfile,
  shadowReport,
  alertItems,
  alertSummary,
} from './fixtures';

/** Browser interception only. No API process, equipment, credentials or production writes. */
export async function offlineApi(page: Page, options: { running?: boolean } = {}) {
  const maps = cloneDemoMaps();
  const map = maps[0]!;
  map.settings.filters = { ...map.settings.filters, visualMode: 'V2' };
  const hosts = map.devices;
  const template = physicalTemplate({
    id: 'responsive-switch',
    catalogKey: 'huawei-s6730-h48x6c',
    name: 'Huawei S6730-H48X6C',
    model: 'S6730-H48X6C',
    manufacturer: 'Huawei',
    category: 'SWITCH',
    kind: 'NETWORK',
  });
  const asset = physicalAsset({
    id: 'asset-responsive',
    name: 'CORE-RESPONSIVE-S6730',
    startU: 8,
    heightU: 1,
    template,
    ports: [
      physicalPort({
        id: 'port-responsive',
        assetId: 'asset-responsive',
        name: '100GE0/0/1',
        label: 'UPLINK',
      }),
    ],
  });
  const inventory = physicalInventory({
    sites: [
      {
        id: 'site-1',
        name: 'POP Centro',
        code: 'CTO',
        description: '',
        racks: [physicalRack({ id: 'rack-1', units: 12, assets: [asset] })],
        createdAt: '2026-10-26T18:00:00Z',
        updatedAt: '2026-10-26T18:00:00Z',
      },
    ],
  });
  const result = options.running
    ? {
        ...vsi1809Result,
        state: 'RUNNING',
        status: 'RUNNING',
        finishedAt: null,
        stage: 'Testando conectividade entre os PEs',
        remote: null,
      }
    : vsi1809Result;
  await page.route('**/installation', (route) =>
    route.fulfill({
      json: { installation: { id: 'IMPLANTAR' }, modules: { ddosMitigation: { enabled: true } } },
    }),
  );
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const now = new Date().toISOString();
    let data: unknown = [];
    if (path === '/api/auth/me')
      data = {
        user: {
          id: 'qa-responsive',
          name: 'Operador QA',
          username: 'qa',
          email: 'qa@example.test',
          role: 'ADMIN',
        },
      };
    else if (path === '/api/maps')
      data = maps.map((item) => ({
        id: item.id,
        name: item.name,
        mode: item.mode,
        isDefault: item.id === map.id,
      }));
    else if (path.startsWith('/api/maps/')) data = map;
    else if (path === '/api/hosts') data = hosts;
    else if (path === '/api/bgp') data = dashboard;
    else if (path === '/api/bgp/alerts')
      data = {
        active: [],
        resolved: [],
        summary: { active: 0, resolved: 0, total: 0 },
        generatedAt: now,
      };
    else if (path.includes('/history'))
      data = path.startsWith('/api/bgp/')
        ? { peerId: 'p1', samples: [], events: [], period: '1h' }
        : [];
    else if (path === '/api/bgp/peers/p1') data = dashboard.devices[0]!.peers[0];
    else if (path === '/api/bgp/mitigation/health') data = health;
    else if (path === '/api/bgp/mitigation/profiles') data = [readyProfile, candidateProfile];
    else if (path.startsWith('/api/bgp/mitigation/profiles/')) data = readyProfile;
    else if (path === '/api/bgp/mitigation/auto/shadow') data = shadowReport;
    else if (path === '/api/bgp/mitigation/telemetry')
      data = {
        generatedAt: now,
        entries: [readyProfile, candidateProfile].map((profile) => ({
          profileId: profile.id,
          interfaceId: profile.interfaceId,
          interfaceName: profile.interfaceName,
          ifIndex: 151,
          adminStatus: 'UP',
          operStatus: 'UP',
          source: 'LEGACY',
          sampleId: 'offline',
          sampleAt: now,
          sampleAgeMs: 0,
          maxAgeMs: 45000,
          rxBps: '232301595',
          txBps: '1878975895',
          direction: 'TX',
          directionSource: 'PROFILE',
          telemetryAvailable: true,
          reasons: [],
          blockedReason: null,
          mode: profile.mode,
          promotedBySweep: false,
          executionAuthorized: false,
          executionBlocks: ['PROFILE_MODE_NOT_AUTO'],
          sharedCounterProfileIds: [profile.id],
        })),
      };
    else if (path === '/api/bgp/mitigation/fast-bridge')
      data = {
        generatedAt: now,
        mode: 'SHADOW',
        fallback: 'FAIL_CLOSED',
        executionAvailable: false,
        profileIds: [],
        enforceProfileIds: [],
        samples: [],
        decisions: [],
        engine: null,
      };
    else if (path === '/api/alert-center/summary') data = { summary: alertSummary };
    else if (path === '/api/alert-center')
      data = {
        items: alertItems,
        total: alertItems.length,
        offset: 0,
        limit: 50,
        hasMore: false,
        state: 'ACTIVE',
        summary: alertSummary,
        generatedAt: now,
      };
    else if (path === '/api/physical') data = inventory;
    else if (path === '/api/physical/catalog') data = { entries: [] };
    else if (path.includes('/physical/ports/')) data = { segments: [], ports: [], connections: [] };
    else if (path === '/api/diagnostics/status')
      data = { diagnosticEnabled: true, diagnosticTrust: 'AVAILABLE' };
    else if (path.endsWith('/diagnostic-approvals'))
      data = {
        approvalId: 'offline-approval',
        hostId: hosts[0]!.id,
        vsiId: 'vsi-1809-local',
        createdAt: now,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    else if (path.endsWith('/diagnose') || path.includes('/diagnostics/')) data = result;
    else if (path.endsWith('/mpls'))
      data = {
        vsis: [{ id: 'vsi-1809-local', hostId: hosts[0]!.id, name: '1809-L2L-VCONLINE-QinQ' }],
        lastSuccessAt: now,
      };
    else if (path === '/api/interfaces/search')
      data = [
        {
          interfaceId: 'if-search',
          interfaceName: '100GE0/0/1',
          hostname: hosts[0]!.hostname,
          deviceId: hosts[0]!.id,
          deviceName: hosts[0]!.name,
          alias: 'UPLINK DE TESTE',
          description: 'Interface de validação',
          ifIndex: 151,
          ip: '192.0.2.1',
          vlan: null,
          status: 'UP',
          maps: [{ id: map.id, name: map.name }],
        },
      ];
    else if (path === '/api/media/summary') data = { integrations: [], enabled: 0, total: 0 };
    await route.fulfill({ json: data });
  });
  return { map, hosts };
}
