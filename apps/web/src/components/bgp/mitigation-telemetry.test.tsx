// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BgpMitigationProfileDto, MitigationTelemetryEntryDto } from '@gmj/shared';
import { MitigationTelemetryFacts, telemetryReasonLabel } from './mitigation-telemetry';
import { MitigationDirectionReviewPanel } from './mitigation-direction-review';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({
  previewMitigationDirections: vi.fn(),
  applyMitigationDirections: vi.fn(),
}));
vi.mock('@/lib/mitigation-api', () => api);
let root: Root;
let el: HTMLDivElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  el?.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});
async function render(element: React.ReactNode) {
  el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  await act(async () =>
    root.render(<QueryClientProvider client={new QueryClient()}>{element}</QueryClientProvider>),
  );
}
const entry = (over: Partial<MitigationTelemetryEntryDto> = {}): MitigationTelemetryEntryDto => ({
  profileId: 'p',
  interfaceId: 'i',
  interfaceName: 'Eth-Trunk1.3024',
  ifIndex: 151,
  adminStatus: 'UP',
  operStatus: 'UP',
  source: 'LEGACY',
  sampleId: 's',
  sampleAt: new Date().toISOString(),
  sampleAgeMs: 0,
  maxAgeMs: 45000,
  rxBps: '232301595',
  txBps: '1878975895',
  direction: null,
  directionSource: null,
  telemetryAvailable: true,
  reasons: ['DIRECTION_NOT_CONFIGURED'],
  blockedReason: 'DIRECTION_NOT_CONFIGURED',
  mode: 'ALERT_ONLY',
  promotedBySweep: false,
  executionAuthorized: false,
  executionBlocks: ['PROFILE_MODE_NOT_AUTO'],
  sharedCounterProfileIds: ['p'],
  ...over,
});
const p = (id: string, mode = 'ALERT_ONLY') =>
  ({
    id,
    customer: 'PLAY CONNECT',
    interfaceName: 'Eth-Trunk1.3024',
    addressFamily: 'IPV4',
    mode,
    autoTrafficDirection: null,
  }) as BgpMitigationProfileDto;
async function click(label: string) {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!;
  await act(async () => button.click());
}
async function select(value: string) {
  const select = el.querySelector('select[aria-label="Direção p"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
describe('telemetry operator view', () => {
  it('shows RX/TX and precise pending direction without presenting protection as authorized', async () => {
    await render(
      <MitigationTelemetryFacts entry={entry()} generatedAt={new Date().toISOString()} />,
    );
    expect(el.textContent).toContain('232,302 Mbps');
    expect(el.textContent).toContain('1,879 Gbps');
    expect(el.textContent).toContain('UP/UP');
    expect(el.textContent).toContain('SELECIONAR RX/TX');
    expect(el.textContent).toContain('NÃO AUTORIZADA');
  });
  it('ages measurements and revokes display of authorization even when refresh is unavailable', async () => {
    vi.useFakeTimers();
    await render(
      <MitigationTelemetryFacts
        entry={entry({ executionAuthorized: true, reasons: [], blockedReason: null })}
        generatedAt={new Date().toISOString()}
      />,
    );
    expect(el.textContent).toContain('AUTORIZADA (sujeita ao preflight)');
    await act(async () => {
      vi.advanceTimersByTime(50000);
    });
    expect(el.textContent).toContain('AMOSTRA ANTIGA');
    expect(el.textContent).toContain('NÃO AUTORIZADA');
  });
  it('renders distinct configuration/association/sample/source conditions', () => {
    expect(telemetryReasonLabel('INTERFACE_ADMIN_DOWN')).not.toContain('SNMP');
    expect(telemetryReasonLabel('DIRECTION_NOT_CONFIGURED')).toContain('CONFIGURAÇÃO');
    expect(
      new Set(
        [
          'SAMPLE_NOT_FOUND',
          'SAMPLE_STALE',
          'INVALID_SAMPLE',
          'INTERFACE_NOT_FOUND',
          'COLLECTION_UNAVAILABLE',
        ].map((r) => telemetryReasonLabel(r as Parameters<typeof telemetryReasonLabel>[0])),
      ).size,
    ).toBe(5);
  });
  it('requires complete preview and explicit confirmation before individual apply; AUTO stays locked', async () => {
    api.previewMitigationDirections.mockResolvedValue({
      previewId: 'preview',
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      changes: [
        {
          profileId: 'p',
          interfaceName: 'Eth-Trunk1.3024',
          addressFamily: 'IPV4',
          mode: 'ALERT_ONLY',
          before: null,
          after: 'TX',
          effectiveAfter: 'TX',
          sourceAfter: 'PROFILE',
          impact: 'SHADOW_EVALUATION_ONLY',
        },
      ],
    });
    api.applyMitigationDirections.mockResolvedValue({ applied: 1 });
    await render(
      <MitigationDirectionReviewPanel profiles={[p('p'), p('auto', 'AUTO')]} entries={[entry()]} />,
    );
    expect(
      (el.querySelector('[aria-label="Selecionar direção em lote"]') as HTMLSelectElement).disabled,
    ).toBe(true);
    expect((el.querySelector('[aria-label="Direção auto"]') as HTMLSelectElement).disabled).toBe(
      true,
    );
    await select('TX');
    await click('GERAR PRÉVIA');
    expect(api.previewMitigationDirections).toHaveBeenCalledWith([
      { profileId: 'p', direction: 'TX' },
    ]);
    expect(api.applyMitigationDirections).not.toHaveBeenCalled();
    expect(el.textContent).toContain('ALERT_ONLY preservado');
    const confirm = [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('Confirmo estas alterações'))!
      .querySelector('input')!;
    await act(async () => confirm.click());
    await click('CONFIRMAR DIREÇÕES');
    expect(api.applyMitigationDirections).toHaveBeenCalledWith('preview');
  });
});
