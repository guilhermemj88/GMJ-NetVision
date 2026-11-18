// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeVsiServiceRun, type VsiServiceDiagnosis } from '@gmj/shared';
import type { VsiServiceClient } from '@/lib/vsi-service-api';
import engineReplayVtaJson from './fixtures/engine-replay-3072-vta-mcp.json';
import { VsiServiceWorkspace, originTag } from './service-workspace';

vi.mock('@/lib/vsi-service-api', () => ({ vsiServiceClient: {} }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const replay = engineReplayVtaJson as unknown as VsiServiceDiagnosis;
const real: VsiServiceDiagnosis = { ...replay, runId: 'homolog-3072', origin: 'ENGINE_RUN', demonstration: { label: 'Homologação DEV', provenance: 'Leituras reais.' } };
const other: VsiServiceDiagnosis = { ...replay, runId: 'outra', vsiName: 'VSI-OUTRA' };
const VSI = replay.vsiName;

function fakeClient(enabled = true) {
  const store = [real, replay, other];
  const client = {
    status: vi.fn(async () => ({ enabled, engineAvailable: false, legacyAvailable: false, archiveAvailable: enabled })),
    list: vi.fn(async (vsiName?: string) => store.filter((d) => !vsiName || d.vsiName === vsiName).map((d) => summarizeVsiServiceRun(d, 'ARCHIVE'))),
    get: vi.fn(async (runId: string) => store.find((d) => d.runId === runId)!),
  } satisfies VsiServiceClient;
  return client;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(client: VsiServiceClient, vsiName: string | null = null) {
  const queryClient = new QueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <VsiServiceWorkspace vsiName={vsiName} client={client} />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const rows = () => [...container.querySelectorAll<HTMLElement>('[data-run-id]')];

describe('Diagnostico VSI/VPLS por servico na area de Diagnostico', () => {
  it('recurso desabilitado na API: nada e exibido e nenhum resultado e consultado (frontend atual preservado)', async () => {
    const client = fakeClient(false);
    await mount(client);
    expect(container.querySelector('[data-vsi-service-workspace]')).toBeNull();
    expect(client.list).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('API sem a rota (producao atual): erro no status nao quebra a area de Diagnostico', async () => {
    const client = { ...fakeClient(), status: vi.fn(async () => Promise.reject(new Error('API 404'))) };
    await mount(client);
    expect(container.textContent).toBe('');
    expect(client.list).not.toHaveBeenCalled();
  });

  it('lista os resultados guardados com VSI, veredito, hora da coleta, PEs e origem — sem abrir nenhum sozinho', async () => {
    const client = fakeClient();
    await mount(client);
    expect(rows().map((r) => r.getAttribute('data-run-id'))).toEqual(['homolog-3072', replay.runId, 'outra']);
    const first = rows()[0]!;
    expect(first.textContent).toContain(VSI);
    expect(first.textContent).toContain('INCONCLUSIVO');
    expect(first.textContent).toContain('coletado em 16/11 19:37Z');
    expect(first.textContent).toContain('BHE-VTA-6730-MPLS-01 (standby esperado)');
    expect(first.textContent).toContain('(não lido)');
    expect(first.querySelector('[data-origin-tag]')!.getAttribute('data-origin-tag')).toBe('real');
    expect(first.textContent).toContain('COLETA REAL · HOMOLOGAÇÃO DEV');
    expect(rows()[1]!.querySelector('[data-origin-tag]')!.getAttribute('data-origin-tag')).toBe('replay');
    expect(rows()[1]!.textContent).toContain('REPLAY · SEM SSH');
    expect(container.textContent).toContain('não executa diagnóstico e não abre SSH');
    // nada foi aberto automaticamente
    expect(client.get).not.toHaveBeenCalled();
    expect(container.querySelector('[data-verdict]')).toBeNull();
  });

  it('abrir e so uma leitura: mostra a tela de servico com Master/Backup, eixos e origem; fechar some com ela', async () => {
    const client = fakeClient();
    await mount(client);
    await act(async () => rows()[0]!.querySelector('button')!.click());
    await settle();
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('homolog-3072');
    expect(Object.keys(client)).toEqual(['status', 'list', 'get']); // o cliente desta tela nao tem como executar coleta
    expect(container.querySelector('[data-verdict]')!.getAttribute('data-verdict')).toBe('INCONCLUSIVE');
    expect(container.querySelector('[data-status="service"][data-endpoint="BHE-VTA-6730-MPLS-01"]')!.textContent).toContain('VSI DOWN ESPERADO (BACKUP)');
    expect(container.textContent).toContain('HOMOLOGAÇÃO DEV');
    await act(async () => rows()[0]!.querySelector('button')!.click());
    expect(container.querySelector('[data-verdict]')).toBeNull();
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('com VSI selecionada a lista e filtrada por ela; o filtro pode ser desligado', async () => {
    const client = fakeClient();
    await mount(client, VSI);
    expect(client.list).toHaveBeenLastCalledWith(VSI);
    expect(rows().map((r) => r.getAttribute('data-run-id'))).toEqual(['homolog-3072', replay.runId]);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await settle();
    expect(rows()).toHaveLength(3);
  });

  it('rotulo de origem: real, replay, fixture e legado nunca se confundem', () => {
    expect(originTag({ origin: 'ENGINE_RUN', label: null })).toEqual({ text: 'COLETA REAL', kind: 'real' });
    expect(originTag({ origin: 'REPLAY', label: 'Replay em DEV' }).kind).toBe('replay');
    expect(originTag({ origin: 'FIXTURE', label: 'x' }).kind).toBe('other');
    expect(originTag({ origin: 'LEGACY_JOB', label: null }).text).toBe('MOTOR LEGADO');
  });
});
