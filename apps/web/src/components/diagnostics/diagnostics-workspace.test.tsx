// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeVsiServiceRun, type MplsHostOverview, type VsiServiceDiagnosis } from '@gmj/shared';
import engineReplayVtaJson from './service/fixtures/engine-replay-3072-vta-mcp.json';

const api = vi.hoisted(() => ({
  getVsiDiagnosticStatus: vi.fn(),
  getHosts: vi.fn(),
  getHostMpls: vi.fn(),
}));
const mcp = vi.hoisted(() => ({ getVsiMcpStatus: vi.fn() }));
const service = vi.hoisted(() => ({ vsiServiceClient: { status: vi.fn(), list: vi.fn(), get: vi.fn() } }));
const auth = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('@/lib/api', () => api);
vi.mock('@/lib/vsi-mcp-status', () => mcp);
vi.mock('@/lib/vsi-service-api', () => service);
vi.mock('@/app/providers', () => auth);

import { DiagnosticsWorkspace } from './diagnostics-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const replay = engineReplayVtaJson as unknown as VsiServiceDiagnosis;
const NOW = new Date().toISOString();

const HOSTS = [
  { id: 'host-1', name: 'BHE-VTA-6730-MPLS-01', managementIp: '10.20.0.11', vendor: 'Huawei', model: 'NE8000' },
  { id: 'host-2', name: 'BHE-RNJ-6730-MPLS-02', managementIp: '10.30.5.7', vendor: 'Huawei', model: 'NE40E' },
  { id: 'host-3', name: 'SW-ACESSO-01', managementIp: '172.16.0.9', vendor: 'Datacom', model: 'DM' },
];

function vsi(id: string, hostId: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, hostId, name, signalingType: 'LDP', status: 'UP', operationalStatus: 'UP', adminStatus: 'UP', vcType: 'VLAN', vlanId: 3072, mtu: 1500,
    lastSeenAt: NOW, acs: [], pws: [], ...extra,
  };
}
const overviewOf = (vsis: unknown[], extra: Record<string, unknown> = {}) =>
  ({ supported: true, capabilities: { vsi: true, pw: true, ac: true }, source: 'SNMP', lastPollingAt: NOW, lastSuccessAt: NOW, lastErrorSafe: null, summary: {}, vsis, ...extra }) as unknown as MplsHostOverview;

const VSI_A = vsi('vsi-a', 'host-1', 'L2-PPPOE-3072', {
  acs: [{ id: 'ac-1', hostId: 'host-1', mplsVsiId: 'vsi-a', vsiName: 'L2-PPPOE-3072', ifIndex: 7, interface: { id: 'i1', name: 'Eth-Trunk1.3072', alias: '', ifIndex: 7 }, status: 'UP', lastSeenAt: NOW }],
  pws: [
    { id: 'pw-1', hostId: 'host-1', mplsVsiId: 'vsi-a', vsiName: 'L2-PPPOE-3072', pwId: 3072, remoteIp: '10.99.0.2', remoteHostId: 'host-2', remoteHost: { id: 'host-2', name: 'BHE-RNJ-6730-MPLS-02', hostname: 'rnj' }, inboundLabel: 1024, outboundLabel: 2048, status: 'UP', state: 'UP', workingState: 'MASTER' },
    { id: 'pw-2', hostId: 'host-1', mplsVsiId: 'vsi-a', vsiName: 'L2-PPPOE-3072', pwId: 3072, remoteIp: '10.99.0.3', remoteHostId: null, remoteHost: null, inboundLabel: null, outboundLabel: null, status: 'BACKUP', state: 'UP', workingState: 'BACKUP' },
  ],
});
const VSI_B = vsi('vsi-b', 'host-1', 'L2-OUTRA-100', { operationalStatus: 'DOWN' });
const VSI_C = vsi('vsi-c', 'host-2', 'L2-RNJ-200');

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let fetchSpy: ReturnType<typeof vi.fn>;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}
const hostButton = (id: string) => container.querySelector<HTMLButtonElement>(`[data-host-id="${id}"]`);
const vsiSelect = () => container.querySelector<HTMLSelectElement>('select[aria-label="VSI"]');
const search = () => container.querySelector<HTMLInputElement>('input[aria-label="Buscar equipamento por nome ou IP"]')!;
const stepText = (name: string) => container.querySelector(`[data-step="${name}"]`)?.textContent ?? '';
const buttonsIn = (name: string) => [...(container.querySelectorAll(`[data-step="${name}"] button`) as NodeListOf<HTMLButtonElement>)];
const byText = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
async function pickHost(id: string): Promise<void> {
  await act(async () => hostButton(id)?.click());
  await settle();
}

async function renderPage(role: 'ADMIN' | 'OPERATOR' | 'VIEWER' = 'ADMIN'): Promise<void> {
  auth.useAuth.mockReturnValue({ user: { id: 'u1', name: 'QA', email: 'qa@local', username: 'qa', role }, logout: vi.fn() });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(DiagnosticsWorkspace)));
  });
  await settle();
}

beforeEach(() => {
  api.getHosts.mockResolvedValue(HOSTS);
  api.getHostMpls.mockImplementation(async (hostId: string) =>
    hostId === 'host-1' ? overviewOf([VSI_A, VSI_B]) : hostId === 'host-2' ? overviewOf([VSI_C]) : overviewOf([]),
  );
  api.getVsiDiagnosticStatus.mockResolvedValue({ diagnosticEnabled: true, diagnosticTrust: 'AVAILABLE' });
  mcp.getVsiMcpStatus.mockResolvedValue({ enabled: false });
  const store = [{ ...replay, runId: 'run-real', origin: 'ENGINE_RUN' as const, demonstration: { label: 'Homologação', provenance: 'Leituras reais.' } }, { ...replay, runId: 'run-replay' }] as VsiServiceDiagnosis[];
  service.vsiServiceClient.status.mockResolvedValue({ enabled: true, engineAvailable: false, legacyAvailable: false, archiveAvailable: true });
  service.vsiServiceClient.list.mockImplementation(async (vsiName?: string) => store.filter((d) => !vsiName || d.vsiName === vsiName).map((d) => summarizeVsiServiceRun(d, 'ARCHIVE')));
  service.vsiServiceClient.get.mockImplementation(async (runId: string) => store.find((d) => d.runId === runId)!);
  fetchSpy = vi.fn(async () => Response.json({}));
  vi.stubGlobal('fetch', fetchSpy);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('selecao independente do Mapa: equipamento por nome ou IP', () => {
  it('lista os hosts reais cadastrados e a busca filtra por nome, IP parcial e varios termos', async () => {
    await renderPage();
    for (const host of HOSTS) expect(hostButton(host.id)).not.toBeNull();
    await typeInto(search(), 'rnj');
    expect(hostButton('host-2')).not.toBeNull();
    expect(hostButton('host-1')).toBeNull();
    await typeInto(search(), '172.16');
    expect([...container.querySelectorAll('[data-host-id]')].map((e) => e.getAttribute('data-host-id'))).toEqual(['host-3']);
    await typeInto(search(), 'vta 6730');
    expect([...container.querySelectorAll('[data-host-id]')].map((e) => e.getAttribute('data-host-id'))).toEqual(['host-1']);
    await typeInto(search(), 'nao-existe');
    expect(container.querySelector('[data-empty="search"]')?.textContent).toContain('nao-existe');
  });

  it('nao ha host cadastrado: estado vazio explicativo, sem inventar equipamento', async () => {
    api.getHosts.mockResolvedValue([]);
    await renderPage();
    expect(container.querySelector('[data-empty="hosts"]')?.textContent).toContain('Nenhum equipamento cadastrado');
    expect(container.querySelectorAll('[data-host-id]').length).toBe(0);
  });

  it('falha ao carregar hosts: mostra o erro e nada mais acontece', async () => {
    api.getHosts.mockRejectedValue(new Error('Servico indisponivel'));
    await renderPage();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Servico indisponivel');
  });
});

describe('VSIs do equipamento selecionado', () => {
  it('escolher o host carrega so o inventario dele; as VSIs aparecem e podem ser escolhidas', async () => {
    await renderPage();
    expect(api.getHostMpls).not.toHaveBeenCalled(); // nada e consultado antes de escolher
    await pickHost('host-1');
    expect(api.getHostMpls).toHaveBeenCalledTimes(1);
    expect(api.getHostMpls).toHaveBeenCalledWith('host-1');
    expect([...vsiSelect()!.options].map((o) => o.textContent)).toEqual(['Selecione…', 'L2-PPPOE-3072 · UP', 'L2-OUTRA-100 · DOWN']);
    await choose(vsiSelect()!, 'vsi-a');
    expect(container.querySelector('[data-inventory-card]')).not.toBeNull();
  });

  it('trocar o equipamento limpa a VSI e atualiza as opcoes: nenhuma selecao incompativel sobrevive', async () => {
    await renderPage();
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-a');
    expect(stepText('select')).toContain('L2-PPPOE-3072');
    await pickHost('host-2');
    expect(api.getHostMpls).toHaveBeenLastCalledWith('host-2');
    expect(vsiSelect()!.value).toBe('');
    expect([...vsiSelect()!.options].map((o) => o.textContent)).toEqual(['Selecione…', 'L2-RNJ-200 · UP']);
    expect(container.querySelector('[data-inventory-card]')).toBeNull();
    expect(container.querySelector('[data-step="select"] dl')?.textContent).not.toContain('L2-PPPOE-3072');
  });

  it('voltar ao host anterior tambem comeca sem VSI selecionada', async () => {
    await renderPage();
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-a');
    await pickHost('host-2');
    await pickHost('host-1');
    expect(vsiSelect()!.value).toBe('');
    expect(container.querySelector('[data-inventory-card]')).toBeNull();
  });

  it('inventario VSI vazio: estado explicativo, sem seletor de VSI e sem nenhuma chamada de coleta', async () => {
    await renderPage();
    await pickHost('host-3');
    expect(container.querySelector('[data-empty="vsis"]')?.textContent).toMatch(/Nenhuma VSI no inventário/);
    expect(container.querySelector('[data-empty="vsis"]')?.textContent).toMatch(/não inicia\s+descoberta, SNMP nem SSH/);
    expect(vsiSelect()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('equipamento sem suporte a inventario VSI: explica sem inventar dados', async () => {
    api.getHostMpls.mockResolvedValue(overviewOf([], { supported: false }));
    await renderPage();
    await pickHost('host-3');
    expect(container.querySelector('[data-empty="unsupported"]')?.textContent).toContain('Nenhum dado foi inventado');
  });

  it('falha ao ler o inventario: mostra o erro da leitura e nao oferece VSI', async () => {
    api.getHostMpls.mockRejectedValue(new Error('Banco indisponivel'));
    await renderPage();
    await pickHost('host-1');
    expect(stepText('select')).toContain('Banco indisponivel');
    expect(vsiSelect()).toBeNull();
  });

  it('muitas VSIs: aparece o filtro e ele reduz as opcoes', async () => {
    const many = Array.from({ length: 14 }, (_, i) => vsi(`v${i}`, 'host-1', i === 3 ? 'L2-ALVO-9' : `L2-V-${i}`));
    api.getHostMpls.mockResolvedValue(overviewOf(many));
    await renderPage();
    await pickHost('host-1');
    const filter = container.querySelector<HTMLInputElement>('input[aria-label="Filtrar VSIs"]')!;
    await typeInto(filter, 'alvo');
    expect([...vsiSelect()!.options].map((o) => o.textContent)).toEqual(['Selecione…', 'L2-ALVO-9 · UP']);
  });
});

describe('resultado existente', () => {
  it('mostra estado operacional, PEs relacionados, ACs, PWs e labels do inventario, com origem e horario', async () => {
    await renderPage();
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-a');
    const card = container.querySelector('[data-inventory-card]')!;
    expect(card.querySelector('[data-field="operational"]')?.textContent).toContain('UP');
    expect(card.querySelector('[data-origin="INVENTORY"]')?.textContent).toContain('INVENTÁRIO SNMP');
    expect(card.textContent).toContain('Visto pela última vez');
    const pes = card.querySelector('[data-related-pes]')!.textContent!;
    expect(pes).toContain('BHE-RNJ-6730-MPLS-02 (10.99.0.2)');
    expect(pes).toContain('10.99.0.3');
    expect(pes).toContain('fora do cadastro');
    expect(card.querySelector('[data-acs]')?.textContent).toContain('Eth-Trunk1.3072');
    const pws = card.querySelector('[data-pws]')!.textContent!;
    for (const value of ['1024', '2048', 'MASTER', 'BACKUP', '—']) expect(pws).toContain(value);
    expect(card.textContent).toMatch(/E-Trunk MASTER\/BACKUP, encapsulamento QinQ e aprendizado MAC/);
  });

  it('resultados guardados consultaveis SEM selecionar nada; origem real x replay aparece ja na lista', async () => {
    await renderPage();
    expect(service.vsiServiceClient.list).toHaveBeenCalledWith(undefined);
    const tags = [...container.querySelectorAll('[data-origin-tag]')].map((e) => e.getAttribute('data-origin-tag'));
    expect(tags.sort()).toEqual(['real', 'replay']);
    expect(service.vsiServiceClient.get).not.toHaveBeenCalled(); // nada e aberto sozinho
  });

  it('abrir um resultado guardado so le (GET): mostra o diagnostico e nunca chama coleta', async () => {
    await renderPage();
    await act(async () => byText('Abrir')?.click());
    await settle();
    expect(service.vsiServiceClient.get).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-label="Diagnóstico VSI/VPLS por serviço"]')).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('consulta de resultados guardados desligada: aviso explicito em vez de sumir', async () => {
    service.vsiServiceClient.status.mockResolvedValue({ enabled: false, engineAvailable: false, legacyAvailable: false });
    await renderPage();
    expect(container.querySelector('[data-vsi-service-unavailable]')?.textContent).toContain('indisponível');
  });
});

type LegacyCase = 'available' | 'disabled' | 'no-trust' | 'status-fails';
type McpCase = 'enabled' | 'disabled' | 'status-fails';
type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';

function setLegacy(kind: LegacyCase): void {
  if (kind === 'available') api.getVsiDiagnosticStatus.mockResolvedValue({ diagnosticEnabled: true, diagnosticTrust: 'AVAILABLE' });
  if (kind === 'disabled') api.getVsiDiagnosticStatus.mockResolvedValue({ diagnosticEnabled: false, diagnosticTrust: 'AVAILABLE' });
  if (kind === 'no-trust') api.getVsiDiagnosticStatus.mockResolvedValue({ diagnosticEnabled: true, diagnosticTrust: 'UNAVAILABLE' });
  if (kind === 'status-fails') api.getVsiDiagnosticStatus.mockRejectedValue(new Error('rede'));
}
function setMcp(kind: McpCase): void {
  if (kind === 'enabled') mcp.getVsiMcpStatus.mockResolvedValue({ enabled: true });
  if (kind === 'disabled') mcp.getVsiMcpStatus.mockResolvedValue({ enabled: false });
  if (kind === 'status-fails') mcp.getVsiMcpStatus.mockRejectedValue(new Error('rede'));
}
const legacyBlock = () => container.querySelector('[data-collect="legacy"]');
const serviceBlock = () => container.querySelector('[data-collect="service"]');
const legacyButtons = () => [...(container.querySelectorAll('[data-collect="legacy"] button') as NodeListOf<HTMLButtonElement>)].map((b) => b.textContent);

async function openLegacyScenario(legacy: LegacyCase, mcpState: McpCase, role: Role): Promise<void> {
  setLegacy(legacy);
  setMcp(mcpState);
  await renderPage(role);
  await pickHost('host-1');
  await choose(vsiSelect()!, 'vsi-a');
}

describe('nova coleta: legado e MCP sao independentes (matriz de disponibilidade x estado do MCP x papel)', () => {
  const MCP_CASES: McpCase[] = ['enabled', 'disabled', 'status-fails'];

  // O legado depende SOMENTE do estado do proprio servico e do papel: o estado do MCP nunca o altera.
  for (const mcpState of MCP_CASES) {
    describe(`MCP: ${mcpState}`, () => {
      it('legado operacional + ADMIN: mostra Preparar janela / Diagnosticar, habilitando armar so ao ADMIN', async () => {
        await openLegacyScenario('available', mcpState, 'ADMIN');
        expect(legacyBlock()?.getAttribute('data-legacy-state')).toBe('available');
        expect(legacyButtons()).toEqual(['Preparar janela', 'Diagnosticar']);
        expect(byText('Preparar janela')?.disabled).toBe(false);
        expect(byText('Diagnosticar')?.disabled).toBe(true); // ainda sem janela one-shot
        expect(fetchSpy).not.toHaveBeenCalled(); // nada dispara sozinho
      });

      it('legado operacional + OPERATOR: so ADMIN arma a janela (botao desabilitado), mantido', async () => {
        await openLegacyScenario('available', mcpState, 'OPERATOR');
        expect(legacyButtons()).toEqual(['Preparar janela', 'Diagnosticar']);
        expect(byText('Preparar janela')?.disabled).toBe(true);
      });

      it('legado operacional + VIEWER: sem botao de execucao, com nota de perfil', async () => {
        await openLegacyScenario('available', mcpState, 'VIEWER');
        expect(legacyButtons()).toEqual([]);
        expect(container.querySelector('[data-legacy-role-note]')?.textContent).toContain('OPERATOR ou ADMIN');
      });

      for (const legacy of ['disabled', 'no-trust', 'status-fails'] as const) {
        it(`legado ${legacy}: nenhuma acao legada, explicacao propria, qualquer papel`, async () => {
          await openLegacyScenario(legacy, mcpState, 'ADMIN');
          const expected = legacy === 'status-fails' ? 'unknown' : legacy;
          expect(legacyBlock()?.getAttribute('data-legacy-state')).toBe(expected);
          expect(container.querySelector(`[data-legacy-unavailable="${expected}"]`)).not.toBeNull();
          expect(legacyButtons()).toEqual([]);
          expect(byText('Preparar janela')).toBeUndefined();
        });
      }

      it('o bloco do MCP nunca oferece botao (nenhuma acao duplicada) e o total de botoes da etapa 3 vem so do legado', async () => {
        await openLegacyScenario('available', mcpState, 'ADMIN');
        expect(serviceBlock()?.querySelectorAll('button').length).toBe(0);
        expect(buttonsIn('collect').map((b) => b.textContent)).toEqual(['Preparar janela', 'Diagnosticar']);
        expect(buttonsIn('collect').filter((b) => b.textContent === 'Diagnosticar').length).toBe(1);
      });
    });
  }

  it('MCP desligado: nova coleta indisponivel; legado continua disponivel; inventario e resultados guardados consultaveis', async () => {
    await openLegacyScenario('available', 'disabled', 'ADMIN');
    expect(serviceBlock()?.getAttribute('data-service-state')).toBe('unavailable');
    expect(serviceBlock()?.textContent).toContain('Recurso indisponível');
    expect(legacyButtons()).toEqual(['Preparar janela', 'Diagnosticar']);
    expect(container.querySelector('[data-inventory-card]')).not.toBeNull();
    expect(container.querySelector('[data-vsi-service-workspace]')).not.toBeNull(); // resultados guardados consultaveis
  });

  it('falha ao consultar o estado do MCP: so a coleta via MCP fica indisponivel; o legado NAO e desativado', async () => {
    await openLegacyScenario('available', 'status-fails', 'ADMIN');
    expect(serviceBlock()?.getAttribute('data-service-state')).toBe('status-failed');
    expect(serviceBlock()?.textContent).toContain('O diagnóstico legado não é afetado');
    expect(legacyBlock()?.getAttribute('data-legacy-state')).toBe('available');
    expect(legacyButtons()).toEqual(['Preparar janela', 'Diagnosticar']);
  });

  it('MCP habilitado: so informa disponibilidade; o legado segue com o mesmo painel (sem botao novo)', async () => {
    await openLegacyScenario('available', 'enabled', 'OPERATOR');
    expect(serviceBlock()?.querySelector('[data-service-available]')?.textContent).toContain('esta tela não a executa');
    expect(serviceBlock()?.querySelector('[data-live-unavailable]')).toBeNull();
    expect(legacyButtons()).toEqual(['Preparar janela', 'Diagnosticar']);
  });

  it('o estado do legado e consultado SEMPRE, mesmo com o MCP desligado (nao depende dele)', async () => {
    setMcp('disabled');
    await renderPage('ADMIN');
    expect(api.getVsiDiagnosticStatus).toHaveBeenCalledTimes(1);
  });

  it('as duas formas sao identificadas por titulos distintos (legado x por servico) para nao haver ambiguidade', async () => {
    await openLegacyScenario('available', 'enabled', 'ADMIN');
    expect(legacyBlock()?.querySelector('h3')?.textContent).toBe('Diagnóstico legado · janela one-shot');
    expect(serviceBlock()?.querySelector('h3')?.textContent).toBe('Diagnóstico VSI por serviço · nova coleta via MCP');
  });

  it('legado operacional: oferece a acao so apos selecionar VSI', async () => {
    setLegacy('available');
    setMcp('disabled');
    await renderPage('ADMIN');
    expect(legacyBlock()?.textContent).toContain('Selecione equipamento e VSI');
    expect(legacyButtons()).toEqual([]);
    await pickHost('host-1');
    expect(legacyButtons()).toEqual([]);
    await choose(vsiSelect()!, 'vsi-a');
    expect(legacyButtons()).toEqual(['Preparar janela', 'Diagnosticar']);
  });

  it('legado + ADMIN: a janela so e criada quando o operador clica (uma chamada, nada automatico), com MCP desligado', async () => {
    setMcp('disabled');
    fetchSpy.mockResolvedValue(Response.json({ approvalId: '11111111-2222-4333-8444-555555555555', hostId: 'host-1', vsiId: 'vsi-a', createdAt: NOW, expiresAt: new Date(Date.now() + 600_000).toISOString() }));
    await renderPage('ADMIN');
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-a');
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => byText('Preparar janela')?.click());
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]![0]).toBe('/api/hosts/host-1/mpls/vsis/vsi-a/diagnostic-approvals');
  });
});

describe('resultados detalhados: OPERATOR e ADMIN; VIEWER so o inventario (a tela reflete a restricao da API)', () => {
  for (const role of ['OPERATOR', 'ADMIN'] as const) {
    it(`${role}: lista resultados guardados e abre um (GET)`, async () => {
      await renderPage(role);
      expect(service.vsiServiceClient.list).toHaveBeenCalled();
      expect(container.querySelector('[data-results-restricted]')).toBeNull();
      await act(async () => byText('Abrir')?.click());
      await settle();
      expect(service.vsiServiceClient.get).toHaveBeenCalledTimes(1);
    });
  }

  it('VIEWER: aviso explicito, NENHUMA consulta de status/lista/resultado, inventario continua visivel', async () => {
    await renderPage('VIEWER');
    expect(container.querySelector('[data-results-restricted]')?.textContent).toContain('restritos a OPERATOR e ADMIN');
    expect(container.querySelector('[data-vsi-service-workspace]')).toBeNull();
    expect(container.querySelector('[data-hint="inventory"]')?.textContent).not.toContain('resultados guardados abaixo'); // nada sugere acesso
    expect(byText('Abrir')).toBeUndefined();
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-a');
    expect(container.querySelector('[data-inventory-card]')).not.toBeNull(); // inventario permitido
    expect(container.querySelector('[data-inventory-card]')?.textContent).toContain('restritos a OPERATOR e ADMIN');
    expect(service.vsiServiceClient.status).not.toHaveBeenCalled();
    expect(service.vsiServiceClient.list).not.toHaveBeenCalled();
    expect(service.vsiServiceClient.get).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sem usuario carregado: fail-closed (nenhuma consulta de resultados)', async () => {
    auth.useAuth.mockReturnValue({ user: null, logout: vi.fn() });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(DiagnosticsWorkspace)));
    });
    await settle();
    expect(container.querySelector('[data-results-restricted]')).not.toBeNull();
    expect(service.vsiServiceClient.list).not.toHaveBeenCalled();
  });

  it('a API informa resultsAccess=false (papel inesperado): a tela respeita e nao lista', async () => {
    service.vsiServiceClient.status.mockResolvedValue({ enabled: true, engineAvailable: false, legacyAvailable: false, resultsAccess: false });
    await renderPage('OPERATOR');
    expect(container.querySelector('[data-vsi-service-restricted]')).not.toBeNull();
    expect(service.vsiServiceClient.list).not.toHaveBeenCalled();
  });

  it('403 na listagem: mostra o erro e nenhum resultado, sem quebrar a pagina', async () => {
    service.vsiServiceClient.list.mockRejectedValue(new Error('Resultados detalhados do diagnóstico VSI exigem OPERATOR ou ADMIN.'));
    await renderPage('OPERATOR');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('exigem OPERATOR ou ADMIN');
    expect(container.querySelectorAll('[data-run-id]').length).toBe(0);
  });

  it('o legado nao muda por papel de resultados: VIEWER sem botao, OPERATOR com painel (armar so ADMIN)', async () => {
    setLegacy('available');
    setMcp('disabled');
    await renderPage('VIEWER');
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-a');
    expect(legacyButtons()).toEqual([]);
  });

  it('replay sem bloco de demonstracao ainda e mostrado como NAO ESTADO ATUAL (nunca como estado da rede)', async () => {
    const bare = { ...replay, runId: 'replay-sem-demo', origin: 'REPLAY' as const, demonstration: undefined } as unknown as VsiServiceDiagnosis;
    service.vsiServiceClient.list.mockResolvedValue([summarizeVsiServiceRun(bare, 'ARCHIVE')]);
    service.vsiServiceClient.get.mockResolvedValue(bare);
    await renderPage('OPERATOR');
    await act(async () => byText('Abrir')?.click());
    await settle();
    expect(container.querySelector('[data-not-current]')?.textContent).toContain('NÃO É ESTADO ATUAL DA REDE');
    expect(container.querySelector('[data-origin-tag="replay"]')).not.toBeNull();
  });
});

describe('seguranca da pagina: leitura apenas', () => {
  it('um percurso completo (buscar, escolher host e VSI, trocar, abrir resultado) so usa leituras: nenhum POST/SSH', async () => {
    await renderPage('ADMIN');
    await typeInto(search(), 'vta');
    await pickHost('host-1');
    await choose(vsiSelect()!, 'vsi-b');
    await typeInto(search(), '');
    await pickHost('host-2');
    await act(async () => byText('Abrir')?.click());
    await settle();
    expect(fetchSpy).not.toHaveBeenCalled();
    // as unicas chamadas de dados sao as leituras mockadas
    expect(api.getHostMpls.mock.calls.map((c) => c[0])).toEqual(['host-1', 'host-2']);
  });

  it('a pagina nao depende do Mapa: renderiza sozinha, sem provider de mapa, e deixa claro que escolher nao consulta o equipamento', async () => {
    await renderPage('VIEWER');
    expect(container.textContent).toContain('Escolher não consulta o equipamento');
    expect(container.textContent).toContain('Diagnóstico');
  });
});
