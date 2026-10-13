// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BgpMitigationDiscoveryResponseDto,
  BgpMitigationHealthDto,
  BgpMitigationProfileDto,
  BgpMitigationSimulationDto,
} from '@gmj/shared';

const api = vi.hoisted(() => ({
  getMitigationHealth: vi.fn(),
  getMitigationProfiles: vi.fn(),
  getMitigationProfile: vi.fn(),
  runMitigationCommand: vi.fn(),
  discoverMitigationProfiles: vi.fn(),
  simulateMitigationProfile: vi.fn(),
  patchMitigationProfile: vi.fn(),
  setMitigationExclusion: vi.fn(),
  getMitigationSimulations: vi.fn(),
  getMitigationEvents: vi.fn(),
  getHosts: vi.fn(),
  getBgpDashboard: vi.fn(),
  getBgpAlerts: vi.fn(),
  getBgpPeer: vi.fn(),
  getBgpPeerHistory: vi.fn(),
  discoverBgp: vi.fn(),
  pollHost: vi.fn(),
  setBgpPeerAdminState: vi.fn(),
  getBgpPeerAdvertisedRoutes: vi.fn(),
  updateHost: vi.fn(),
}));

vi.mock('@/lib/mitigation-api', () => api);
vi.mock('@/lib/api', () => api);

vi.mock('recharts', () => {
  const stub = () => null;
  return {
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => children,
    LineChart: stub,
    Line: stub,
    XAxis: stub,
    YAxis: stub,
    CartesianGrid: stub,
    Tooltip: stub,
    ReferenceLine: stub,
  };
});

import { BgpMitigationWorkspace } from './bgp-mitigation-workspace';
import { BgpWorkspace } from './bgp-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const health: BgpMitigationHealthDto = {
  mode: 'SIMULATION_ONLY',
  worker: { state: 'STOPPED' },
  migrationReady: false,
  databaseReady: true,
  repository: 'DATABASE',
  lastDiscoveryAt: null,
  mitigationRt: '268568:660',
  prefixLimit: 100,
};

const readyProfile: BgpMitigationProfileDto = {
  id: 'profile-1',
  persisted: true,
  customer: 'HORIZONTE_IP',
  deviceId: 'device-1',
  deviceName: 'BGP-01',
  interfaceId: 'if-1',
  interfaceName: 'Eth-Trunk1.3011',
  interfaceDescription: 'HORIZONTE_IP_40GB',
  detectedBandwidthBps: '40000000000',
  bandwidthOverrideBps: null,
  effectiveBandwidthBps: '40000000000',
  policyName: 'PL-HORIZONTES_IPv4-IN',
  addressFamily: 'IPV4',
  sharedPolicy: true,
  sharedPolicyTargets: [
    {
      interfaceId: 'if-2',
      interfaceName: 'Eth-Trunk1.3013',
      customer: 'HORIZONTE_IP_02',
      peerAddress: '10.200.200.10',
      addressFamily: 'IPV4',
      prefixCount: 8,
      prefixStatus: 'SAFE',
    },
  ],
  autoBlockedReason: null,
  peerAddresses: ['10.200.200.10', '10.200.200.106'],
  primaryPeerAddress: '10.200.200.106',
  prefixCount: 12,
  prefixLimit: 100,
  prefixStatus: 'SAFE',
  existingNodes: [11],
  mitigationNodes: [],
  plannedNode: 1,
  readiness: 'READY',
  snapshotAvailable: true,
  blockedReason: null,
  runtimeState: 'NORMAL',
  mode: 'ALERT_ONLY',
  enabled: true,
  mitigationRt: '268568:660',
  lastDiscoveryAt: null,
};

const candidateProfile: BgpMitigationProfileDto = {
  ...readyProfile,
  id: 'candidate:device-1:if-2',
  persisted: false,
  customer: 'CLIENTE_X',
  interfaceId: 'if-2',
  interfaceName: 'Eth-Trunk1.3099',
  interfaceDescription: 'CLIENTE_X_20GB',
  detectedBandwidthBps: '20000000000',
  effectiveBandwidthBps: '20000000000',
  policyName: null,
  peerAddresses: ['10.200.200.200'],
  primaryPeerAddress: '10.200.200.200',
  prefixCount: null,
  prefixStatus: 'UNKNOWN',
  existingNodes: [],
  plannedNode: null,
  readiness: 'NOT_READY',
  snapshotAvailable: true,
  blockedReason: 'POLICY_NOT_FOUND',
  runtimeState: null,
};

const discovery: BgpMitigationDiscoveryResponseDto = {
  results: [
    {
      deviceId: 'device-1',
      deviceName: 'BGP-01',
      scannedPeers: 32,
      candidateInterfaces: 8,
      ignoredNoBandwidth: 24,
      createdProfiles: 1,
      updatedProfiles: 0,
      blockedProfiles: 1,
      outOfScopeProfiles: [],
      ambiguousPeers: [],
      warnings: [],
    },
  ],
  totals: {
    devices: 1,
    scannedPeers: 32,
    candidateInterfaces: 8,
    ignoredNoBandwidth: 24,
    createdProfiles: 1,
    updatedProfiles: 0,
    blockedProfiles: 1,
  },
  profiles: [readyProfile, candidateProfile],
  warnings: [],
  discoveredAt: '2026-01-01T12:00:00.000Z',
  deviceId: 'device-1',
  scannedPeers: 32,
  candidateInterfaces: 8,
  ignoredNoBandwidth: 24,
  createdProfiles: 1,
  updatedProfiles: 0,
  blockedProfiles: 1,
  outOfScopeProfiles: [],
  ambiguousPeers: [],
};

const simulation: BgpMitigationSimulationDto = {
  id: 'sim-1',
  persisted: true,
  profileId: 'profile-1',
  customer: 'HORIZONTE_IP',
  deviceName: 'BGP-01',
  interfaceName: 'Eth-Trunk1.3011',
  policyName: 'PL-HORIZONTES_IPv4-IN',
  result: 'WOULD_MITIGATE',
  blockedReason: null,
  simulatedTrafficBps: '38700000000',
  effectiveBandwidthBps: '40000000000',
  utilizationPercent: 96.75,
  thresholdBps: '36000000000',
  thresholdPercent: 90,
  recoveryThresholdBps: '28000000000',
  recoveryPercent: 70,
  samples: 3,
  requiredSamples: 3,
  prefixCount: 12,
  prefixLimit: 100,
  prefixStatus: 'SAFE',
  plannedNode: 1,
  mitigationRt: '268568:660',
  affectedPeers: ['10.200.200.10', '10.200.200.106'],
  affectedPolicyPeers: ['10.200.200.10', '10.200.200.106'],
  affectedPolicyPeerCount: 2,
  sharedPolicy: false,
  sharedPolicyTargets: [],
  primaryPeerAddress: '10.200.200.106',
  commandPreview: [
    'system-view',
    'route-policy PL-HORIZONTES_IPv4-IN permit node 1',
    ' apply extcommunity rt 268568:660 additive',
    'commit',
  ],
  createdAt: '2026-01-01T12:05:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

async function render(element: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await flush();
  await flush();
}

function find(selector: string): HTMLElement {
  const element = container.querySelector(selector);
  if (!element) throw new Error(`elemento nao encontrado: ${selector}`);
  return element as HTMLElement;
}

function text(): string {
  return container.textContent ?? '';
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

async function clickByText(label: string): Promise<void> {
  const target = [...container.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!target) throw new Error(`botao nao encontrado: ${label}`);
  await click(target);
}

async function clickIn(scope: Element, label: string): Promise<void> {
  const target = [...scope.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes(label),
  );
  if (!target) throw new Error(`botao nao encontrado em ${label}`);
  await click(target);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error(`condicao nao atendida: ${label}`);
}

async function openDetails(customer: string): Promise<void> {
  // A tabela aparece depois do discovery resolver: damos alguns flushes antes
  // de considerar que a linha realmente nao existe.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const row = [...container.querySelectorAll('tbody tr')].find((candidate) =>
      (candidate.textContent ?? '').includes(customer),
    );
    if (row) {
      const button = [...row.querySelectorAll('button')].find((candidate) =>
        (candidate.textContent ?? '').includes('DETALHES'),
      );
      if (!button) {
        throw new Error(`botao DETALHES nao encontrado na linha ${customer}: ${row.innerHTML}`);
      }
      await click(button);
      return;
    }
    await flush();
  }
  throw new Error(
    `linha nao encontrada: ${customer} | discovery=${api.discoverMitigationProfiles.mock.calls.length} | ui=${text().slice(0, 300)}`,
  );
}

function detailPanel(): Element {
  const panel = container.querySelector('[aria-label^="Detalhes de"]');
  if (!panel) throw new Error('painel de detalhes nao esta aberto');
  return panel;
}

async function setInput(ariaLabel: string, value: string): Promise<void> {
  const input = find(`input[aria-label="${ariaLabel}"]`) as HTMLInputElement;
  await act(async () => {
    // Inputs controlados do React exigem o setter nativo: atribuir `.value`
    // direto nao passa pelo value tracker e o onChange nunca dispara.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
}

async function setSelect(ariaLabel: string, value: string): Promise<void> {
  const select = find(`select[aria-label="${ariaLabel}"]`) as HTMLSelectElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      'value',
    )?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

async function chooseDevice(value: string): Promise<void> {
  // A lista de equipamentos vem de uma query: sem esperar as options, atribuir
  // o valor nao pega e o botao de discovery continua desabilitado. O limite e por
  // tempo (nao por numero de flushes) para nao depender da carga da suite.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const select = find('select[aria-label="Equipamento"]') as HTMLSelectElement;
    if ([...select.options].some((option) => option.value === value)) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype,
          'value',
        )?.set;
        setter?.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
      return;
    }
    await flush();
  }
  throw new Error(`opcao de equipamento nao carregou: ${value}`);
}

beforeEach(() => {
  // Esta suíte cobre o ambiente do projeto IMPLANTAR: mitigação DDoS exposta.
  vi.stubEnv('NEXT_PUBLIC_DDOS_MITIGATION_UI', 'true');
  api.getMitigationHealth.mockResolvedValue(health);
  api.getMitigationProfiles.mockResolvedValue([]);
  api.getMitigationProfile.mockResolvedValue(readyProfile);
  api.discoverMitigationProfiles.mockResolvedValue(discovery);
  api.simulateMitigationProfile.mockResolvedValue(simulation);
  api.patchMitigationProfile.mockResolvedValue({ ...readyProfile, bandwidthOverrideBps: '10000000000' });
  api.runMitigationCommand.mockResolvedValue(commandResult);
  api.getHosts.mockResolvedValue([
    { id: 'device-1', hostname: 'BGP-01', displayName: 'BGP-01', sshEnabled: true },
  ]);
  api.getBgpDashboard.mockResolvedValue({
    summary: { peers: 0, established: 0, down: 0, receivedPrefixes: 0, byFamily: { IPV4: 0, IPV6: 0 } },
    devices: [],
  });
  api.getBgpAlerts.mockResolvedValue({ active: [], resolved: [] });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('subabas do workspace BGP', () => {
  it('abre em SESSOES e preserva o conteudo atual do BGP', async () => {
    await render(createElement(BgpWorkspace));

    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(['SESSÕES', 'MITIGAÇÃO DDoS']);
    expect(find('#bgp-tab-sessions').getAttribute('aria-selected')).toBe('true');
    expect(text()).toContain('Gerenciar equipamentos');
    expect(text()).not.toContain('MOTOR EM MODO DE SIMULAÇÃO');
  });

  it('troca para MITIGACAO DDoS mantendo as duas abas', async () => {
    await render(createElement(BgpWorkspace));

    await click(find('#bgp-tab-mitigation'));

    expect(find('#bgp-tab-mitigation').getAttribute('aria-selected')).toBe('true');
    expect(text()).toContain('MOTOR EM MODO DE SIMULAÇÃO');
    expect(text()).toContain('Nenhuma alteração será realizada nos roteadores.');
    expect(text()).not.toContain('Gerenciar equipamentos');
  });
});

describe('workspace de mitigacao DDoS', () => {
  it('mostra banner, cards e aviso de banco nao migrado', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await waitFor(() => text().includes('Banco de dados ainda não migrado'), 'health carregado');

    expect(text()).toContain('🧪 MOTOR EM MODO DE SIMULAÇÃO');
    expect(text()).toContain('SIMULAÇÃO');
    expect(text()).toContain('não implantado');
    expect(text()).toContain('perfis de mitigação');
    expect(text()).toContain('Banco de dados ainda não migrado');
  });

  it('roda a descoberta e mostra o resumo e a tabela com status traduzidos', async () => {
    await render(createElement(BgpMitigationWorkspace));

    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');

    expect(api.discoverMitigationProfiles).toHaveBeenCalledWith({ deviceId: 'device-1' });
    expect(text()).toContain('peers analisados');
    expect(text()).toContain('interfaces ignoradas por não possuir banda');
    expect(text()).toContain('APTO');
    expect(text()).toContain('NÃO APTO');
    expect(text()).toContain('HORIZONTE_IP');
    expect(text()).toContain('40.0 Gbps');
    expect(text()).toContain('12 / 100');
    expect(findAll('tbody tr')).toHaveLength(2);
  });

  it('mostra candidato sem policy com o motivo em portugues', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');

    await openDetails('CLIENTE_X');

    expect(text()).toContain('CLIENTE_X');
    expect(text()).toContain('Política BGP de entrada não encontrada');
    expect(text()).toContain('Policy IN: não encontrada');
  });

  it('abre o detalhe do cliente com banda, BGP e route-policy', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');

    await openDetails('HORIZONTE_IP');

    expect(text()).toContain('Descrição');
    expect(text()).toContain('Perfis de mitigação');
    expect(text()).toContain('HORIZONTE_IP_40GB');
    expect(text()).toContain('Detectada: 40.0 Gbps');
    expect(text()).toContain('Override: não configurado');
    expect(text()).toContain('Efetiva: 40.0 Gbps');
    expect(text()).toContain('Policy IN: PL-HORIZONTES_IPv4-IN');
    expect(text()).toContain('Peer principal: 10.200.200.106');
    expect(text()).toContain('Status: SEGURO');
    expect(text()).toContain('Runtime: NORMAL');
    expect(text()).toContain('Nodes existentes: 11');
    expect(text()).toContain('Nodes de mitigação: nenhum');
    expect(text()).toContain('Node BOGONS planejado: —');
    expect(text()).toContain('Node mitigação planejado: 1');
    expect(text()).toContain('Node planejado (compat): 1');
    expect(text()).toContain('Prefix-list BOGONS: BOGONS');
    expect(text()).toContain('Prefix-list mitigação: PREFIX8to24');
    expect(text()).toContain('RT de mitigação: 268568:660');
  });

  it('simula a mitigacao e mostra resultado + preview de comandos', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    await clickIn(detailPanel(), 'SIMULAR MITIGAÇÃO');
    const dialog = find('[role="dialog"][aria-label="Simular mitigação"]');
    await setInput('Tráfego simulado em Gbps', '38.7');
    await setInput('Número de amostras', '3');
    await clickIn(dialog, 'SIMULAR MITIGAÇÃO');

    expect(api.simulateMitigationProfile).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ simulatedTrafficBps: '38700000000', samples: 3, simulatedPrefixCount: 12 }),
    );
    expect(text()).toContain('RESULTADO DA SIMULAÇÃO');
    expect(text()).toContain('MITIGAÇÃO SERIA ATIVADA');
    expect(text()).toContain('Limite: 36.0 Gbps / 90%');
    expect(text()).toContain('COMANDOS QUE SERIAM EXECUTADOS');
    expect(text()).toContain('apply extcommunity rt 268568:660 additive');
    expect(text()).toContain('Esses comandos NÃO foram enviados ao equipamento.');
  });

  it('edita o override de banda enviando apenas bandwidthOverrideBps', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    await clickIn(detailPanel(), 'EDITAR OVERRIDE');
    await setInput('Override manual em Gbps', '10');
    // O drawer agora tambem tem um botao SALVAR (protecao contra mitigacao):
    // este teste precisa do SALVAR do MODAL de override.
    const overrideModal = container.querySelector('.mitigation-modal');
    if (!overrideModal) throw new Error('modal de override nao encontrado');
    await clickIn(overrideModal, 'SALVAR');

    expect(api.patchMitigationProfile).toHaveBeenCalledWith('profile-1', {
      bandwidthOverrideBps: '10000000000',
    });
  });

  it('permite remover o override', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    await clickIn(detailPanel(), 'EDITAR OVERRIDE');
    await clickByText('REMOVER OVERRIDE');

    expect(api.patchMitigationProfile).toHaveBeenCalledWith('profile-1', {
      bandwidthOverrideBps: null,
    });
  });

  it('mostra estado de erro quando a listagem falha', async () => {
    api.getMitigationProfiles.mockRejectedValue(new Error('API 500'));

    await render(createElement(BgpMitigationWorkspace));
    await waitFor(
      () => text().includes('Não foi possível carregar os perfis de mitigação.'),
      'painel em estado de erro',
    );

    expect(text()).toContain('Não foi possível carregar os perfis de mitigação.');
    expect(text()).toContain('Tentar novamente');
  });

  it('mostra estado de loading antes da resposta', async () => {
    api.getMitigationProfiles.mockReturnValue(new Promise(() => undefined));

    await render(createElement(BgpMitigationWorkspace));

    expect(text()).toContain('Carregando perfis de mitigação…');
  });
});

function findAll(selector: string): Element[] {
  return [...container.querySelectorAll(selector)];
}

const commandResult = {
  ok: true,
  requestId: 'req-1',
  action: 'ACTIVATE' as const,
  status: 'ACTIVATED_VERIFIED',
  profileId: 'profile-1',
  customer: 'HORIZONTE_IP',
  device: 'BGP-01',
  interface: 'if-1',
  addressFamily: 'IPV4',
  policy: 'PL-HORIZONTES_IPv4-IN',
  node: 1,
  rt: '268568:660',
  sharedPolicy: true,
  sharedPolicyTargets: [
    {
      interfaceId: 'if-2',
      interfaceName: 'Eth-Trunk1.3013',
      customer: 'HORIZONTE_IP_02',
      peerAddress: '10.200.200.10',
    },
  ],
  affectedPeers: ['10.200.200.10'],
  verified: true,
  executedAt: '2026-01-01T12:00:00.000Z',
  idempotent: false,
  commandPreview: ['system-view', 'commit'],
  verification: {
    command: 'display route-policy PL-HORIZONTES_IPv4-IN',
    summary: 'node 1 ativo com a RT 268568:660',
  },
};

async function abrirDrawer(): Promise<void> {
  await render(createElement(BgpMitigationWorkspace));
  await chooseDevice('device-1');
  await clickByText('DESCOBRIR CLIENTES');
  await openDetails('HORIZONTE_IP');
}

describe('acoes de mitigacao na UI (executor MOCK)', () => {
  it('mostra os quatro botoes e o aviso de MOCK', async () => {
    await abrirDrawer();

    expect(text()).toContain('SIMULAR MITIGAÇÃO');
    expect(text()).toContain('ATIVAR MITIGAÇÃO');
    expect(text()).toContain('SIMULAR RETIRADA');
    expect(text()).toContain('RETIRAR MITIGAÇÃO');
    expect(text()).toContain('MODO DE EXECUÇÃO: SIMULAÇÃO / MOCK');
    expect(text()).toContain('Nenhum comando será enviado ao equipamento.');
  });

  it('ATIVAR pede confirmacao, avisa shared policy e envia action + requestId', async () => {
    await abrirDrawer();

    await clickIn(detailPanel(), 'ATIVAR MITIGAÇÃO');
    const dialog = find('[role="dialog"][aria-label="Confirmar ação de mitigação"]');
    expect(dialog.textContent).toContain('Esta route-policy é compartilhada');
    expect(dialog.textContent).toContain('HORIZONTE_IP_02');
    expect(dialog.textContent).toContain('Nenhum comando será enviado ao equipamento.');

    await clickIn(dialog, 'CONFIRMAR ATIVAÇÃO');

    expect(api.runMitigationCommand).toHaveBeenCalledTimes(1);
    const [id, payload] = api.runMitigationCommand.mock.calls[0] as [
      string,
      { action: string; requestId: string },
    ];
    expect(id).toBe('profile-1');
    expect(payload.action).toBe('ACTIVATE');
    expect(typeof payload.requestId).toBe('string');
    expect(payload.requestId.length).toBeGreaterThan(8);
  });

  it('mostra o resultado com status, read-back e evidencia', async () => {
    await abrirDrawer();
    await clickIn(detailPanel(), 'ATIVAR MITIGAÇÃO');
    await clickIn(find('[role="dialog"][aria-label="Confirmar ação de mitigação"]'), 'CONFIRMAR ATIVAÇÃO');

    expect(text()).toContain('SIMULAÇÃO DE EXECUÇÃO CONCLUÍDA');
    expect(text()).toContain('Modo: MOCK / SIMULAÇÃO');
    expect(text()).toContain('Status: ACTIVATED_VERIFIED');
    expect(text()).toContain('Node: 1');
    expect(text()).toContain('RT: 268568:660');
    expect(text()).toContain('Read-back: OK');
    expect(text()).toContain('Comando de verificação: display route-policy PL-HORIZONTES_IPv4-IN');
    expect(text()).toContain('Resultado: node 1 ativo com a RT 268568:660');

    await clickByText('VER EVIDÊNCIA');
    expect(text()).toContain('commandPreview');
  });

  it('RETIRAR usa action REMOVE e o rotulo de retirada', async () => {
    api.runMitigationCommand.mockResolvedValue({
      ...commandResult,
      action: 'REMOVE',
      status: 'REMOVED_VERIFIED',
    });
    await abrirDrawer();

    await clickIn(detailPanel(), 'RETIRAR MITIGAÇÃO');
    await clickIn(find('[role="dialog"][aria-label="Confirmar ação de mitigação"]'), 'CONFIRMAR RETIRADA');

    const [, payload] = api.runMitigationCommand.mock.calls[0] as [string, { action: string }];
    expect(payload.action).toBe('REMOVE');
    expect(text()).toContain('SIMULAÇÃO DE RETIRADA CONCLUÍDA');
  });

  it('SIMULAR RETIRADA vai direto, sem confirmacao', async () => {
    await abrirDrawer();

    await clickIn(detailPanel(), 'SIMULAR RETIRADA');

    const [, payload] = api.runMitigationCommand.mock.calls[0] as [string, { action: string }];
    expect(payload.action).toBe('SIMULATE_REMOVE');
    expect(container.querySelector('[role="dialog"][aria-label="Confirmar ação de mitigação"]')).toBeNull();
  });

  it('erro seguro aparece na tela sem quebrar a aba', async () => {
    api.runMitigationCommand.mockRejectedValue(new Error('API 500'));
    await abrirDrawer();

    await clickIn(detailPanel(), 'ATIVAR MITIGAÇÃO');
    await clickIn(find('[role="dialog"][aria-label="Confirmar ação de mitigação"]'), 'CONFIRMAR ATIVAÇÃO');

    expect(text()).toContain('Erro: API 500');
    expect(text()).toContain('SIMULAÇÃO DE EXECUÇÃO CONCLUÍDA');
  });

  it('loading impede disparar a acao duas vezes', async () => {
    api.runMitigationCommand.mockReturnValue(new Promise(() => undefined));
    await abrirDrawer();

    await clickIn(detailPanel(), 'ATIVAR MITIGAÇÃO');
    await clickIn(find('[role="dialog"][aria-label="Confirmar ação de mitigação"]'), 'CONFIRMAR ATIVAÇÃO');
    expect(api.runMitigationCommand).toHaveBeenCalledTimes(1);

    // botoes do drawer ficam desabilitados durante a execucao
    await clickIn(detailPanel(), 'ATIVAR MITIGAÇÃO');
    await clickIn(detailPanel(), 'RETIRAR MITIGAÇÃO');
    expect(api.runMitigationCommand).toHaveBeenCalledTimes(1);
  });

  it('releitura do profile depois da acao (nao confia so no estado local)', async () => {
    await abrirDrawer();
    api.getMitigationProfile.mockClear();

    await clickIn(detailPanel(), 'ATIVAR MITIGAÇÃO');
    await clickIn(find('[role="dialog"][aria-label="Confirmar ação de mitigação"]'), 'CONFIRMAR ATIVAÇÃO');

    expect(api.getMitigationProfile).toHaveBeenCalledWith('profile-1');
  });

  it('RETIRAR em policy compartilhada avisa que a retirada remove a mitigacao de TODOS', async () => {
    await abrirDrawer();

    await clickIn(detailPanel(), 'RETIRAR MITIGAÇÃO');
    const dialog = find('[role="dialog"][aria-label="Confirmar ação de mitigação"]');

    expect(dialog.textContent).toContain('FISICAMENTE');
    expect(dialog.textContent).toContain('HORIZONTE_IP_02');
    expect(dialog.textContent).toContain('CONFIRMAR RETIRADA');
  });
});

describe('scroll vertical da aba e drawer de detalhes', () => {
  it('a aba monta o container flex com painel rolavel (nao corta a tabela)', async () => {
    await render(createElement(BgpWorkspace));

    expect(container.querySelector('.bgp-workspace')).not.toBeNull();
    expect(container.querySelector('.bgp-tab-panel')).not.toBeNull();

    await click(find('#bgp-tab-mitigation'));

    // O painel de mitigacao e o container de scroll vertical (o shell do app e
    // 100vh com body overflow hidden, entao sem altura o conteudo era cortado).
    const shell = container.querySelector('.mitigation-shell');
    expect(shell).not.toBeNull();
    expect(shell?.closest('.bgp-tab-panel')).not.toBeNull();
  });

  it('DETALHES abre o drawer imediatamente e mantem a tabela visivel', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');

    expect(container.querySelector('.mitigation-drawer')).toBeNull();

    await openDetails('HORIZONTE_IP');

    const drawer = container.querySelector('.mitigation-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute('role')).toBe('dialog');
    // conteudo com scroll proprio dentro do drawer
    expect(drawer?.querySelector('.mitigation-drawer__body')).not.toBeNull();
    // a tabela continua renderizada (nao precisa desaparecer nem rolar ate o fim)
    expect(container.querySelector('.mitigation-table')).not.toBeNull();
  });

  it('o drawer mostra todos os campos do cliente', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    const drawer = container.querySelector('.mitigation-drawer');
    const texto = drawer?.textContent ?? '';

    expect(drawer).not.toBeNull();
    expect(texto).toContain('Detalhes do cliente');
    expect(texto).toContain('HORIZONTE_IP');
    expect(texto).toContain('BGP-01');
    expect(texto).toContain('Eth-Trunk1.3011');
    expect(texto).toContain('HORIZONTE_IP_40GB');
    expect(texto).toContain('Detectada: 40.0 Gbps');
    expect(texto).toContain('Override: não configurado');
    expect(texto).toContain('Efetiva: 40.0 Gbps');
    expect(texto).toContain('Policy IN: PL-HORIZONTES_IPv4-IN');
    expect(texto).toContain('Peer principal: 10.200.200.106');
    expect(texto).toContain('Peers afetados: 10.200.200.10, 10.200.200.106');
    expect(texto).toContain('12 / 100');
    expect(texto).toContain('Status: SEGURO');
    expect(texto).toContain('Nodes existentes: 11');
    expect(texto).toContain('Nodes de mitigação: nenhum');
    expect(texto).toContain('Node BOGONS planejado: —');
    expect(texto).toContain('Node mitigação planejado: 1');
    expect(texto).toContain('Node planejado (compat): 1');
    expect(texto).toContain('Prefix-list BOGONS: BOGONS');
    expect(texto).toContain('Prefix-list mitigação: PREFIX8to24');
    expect(texto).toContain('RT de mitigação: 268568:660');
    expect(texto).toContain('Estado: APTO');
    expect(texto).toContain('Runtime: NORMAL');
    expect(texto).toContain('Modo do perfil: SOMENTE ALERTA');
  });

  it('o drawer mostra o motivo de bloqueio do candidato sem policy', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('CLIENTE_X');

    const drawer = container.querySelector('.mitigation-drawer');
    const texto = drawer?.textContent ?? '';

    expect(texto).toContain('CLIENTE_X');
    expect(texto).toContain('Estado: NÃO APTO');
    expect(texto).toContain('Motivo: Política BGP de entrada não encontrada');
  });

  it('FECHAR fecha o drawer', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');
    expect(container.querySelector('.mitigation-drawer')).not.toBeNull();

    await clickByText('FECHAR');

    expect(container.querySelector('.mitigation-drawer')).toBeNull();
    expect(container.querySelector('.mitigation-table')).not.toBeNull();
  });

  it('o drawer e o modal de override convivem (drawer atras, modal na frente)', async () => {
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    await clickIn(detailPanel(), 'EDITAR OVERRIDE');

    expect(container.querySelector('.mitigation-drawer')).not.toBeNull();
    expect(find('[role="dialog"][aria-label="Editar override de banda"]')).not.toBeNull();
  });
});

describe('protecao contra mitigacao (exclusao administrativa do peer)', () => {
  it('marca "nunca mitigar" pelo painel e mostra badge na lista e no detalhe', async () => {
    api.setMitigationExclusion.mockResolvedValue({
      ...readyProfile,
      mitigationExcluded: true,
      mitigationExclusionReason: 'UPLINK',
      mitigationExclusionNote: 'Upstream principal',
    });

    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    expect(text()).toContain('PROTEÇÃO CONTRA MITIGAÇÃO');
    expect(text()).toContain('Nunca mitigar este peer');

    await click(find('.mitigation-exclusion__toggle input'));
    await setSelect('Motivo da exclusão', 'UPLINK');
    await setInput('Observação da exclusão', 'Upstream principal');
    await clickIn(detailPanel(), 'SALVAR');

    expect(api.setMitigationExclusion).toHaveBeenCalledWith('profile-1', {
      excluded: true,
      reason: 'UPLINK',
      note: 'Upstream principal',
    });
    expect(text()).toContain('EXCLUÍDO DA MITIGAÇÃO');
    expect(text()).toContain('Excluído da mitigação');
    expect(text()).toContain('Mitigação desativada administrativamente para este peer');
  });

  it('peer excluido bloqueia ATIVAR na UI (tom administrativo) e mantem RETIRAR disponivel', async () => {
    api.discoverMitigationProfiles.mockResolvedValue({
      ...discovery,
      profiles: [
        { ...readyProfile, mitigationExcluded: true, mitigationExclusionReason: 'UPLINK' },
        candidateProfile,
      ],
    });

    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await openDetails('HORIZONTE_IP');

    const ativar = [...container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('ATIVAR MITIGAÇÃO'),
    ) as HTMLButtonElement;
    const retirar = [...container.querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('RETIRAR MITIGAÇÃO'),
    ) as HTMLButtonElement;

    expect(ativar.disabled).toBe(true);
    expect(retirar.disabled).toBe(false);
    expect(text()).toContain('EXCLUÍDO DA MITIGAÇÃO');
  });
});

describe('prefixos UNKNOWN sao informativos na UI', () => {
  it('mostra — / 100 + contagem indisponível sem rebaixar o badge', async () => {
    api.discoverMitigationProfiles.mockResolvedValue({
      ...discovery,
      profiles: [{ ...readyProfile, prefixCount: null, prefixStatus: 'UNKNOWN' }],
    });
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
    await waitFor(() => text().includes('contagem indisponível'), 'dica de prefixo');

    const row = [...container.querySelectorAll('tbody tr')].find((candidate) =>
      (candidate.textContent ?? '').includes('HORIZONTE_IP'),
    );
    expect(row).toBeTruthy();
    const rowText = row!.textContent ?? '';
    expect(rowText).toContain('— / 100');
    expect(rowText).toContain('contagem indisponível');
    expect(rowText).toContain('APTO');
    expect(rowText).not.toContain('NÃO APTO');
  });
});

describe('snapshot de discovery ausente (pos-restart)', () => {
  function hydration(state: 'PENDING' | 'RUNNING' | 'READY' | 'DEGRADED') {
    return {
      state,
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: state === 'PENDING' || state === 'RUNNING' ? null : '2026-01-01T00:00:05.000Z',
      devicesTotal: 1,
      devicesSucceeded: state === 'DEGRADED' ? 0 : 1,
      devicesFailed: state === 'DEGRADED' ? 1 : 0,
      lastError: state === 'DEGRADED' ? '1 device(s) sem snapshot de discovery' : null,
    };
  }

  it('B) hydration RUNNING => badge REVALIDANDO (nunca NÃO APTO)', async () => {
    api.getMitigationHealth.mockResolvedValue({ ...health, snapshotHydration: hydration('RUNNING') });
    api.getMitigationProfiles.mockResolvedValue([
      { ...readyProfile, snapshotAvailable: false, readiness: 'NOT_READY' },
    ]);
    await render(createElement(BgpMitigationWorkspace));
    await waitFor(() => text().includes('REVALIDANDO'), 'badge REVALIDANDO');
    expect(text()).toContain('REVALIDANDO');
    expect(text()).not.toContain('NÃO APTO');
  });

  it('E) hydration DEGRADED => badge SEM SNAPSHOT (fail-closed)', async () => {
    api.getMitigationHealth.mockResolvedValue({ ...health, snapshotHydration: hydration('DEGRADED') });
    api.getMitigationProfiles.mockResolvedValue([
      { ...readyProfile, snapshotAvailable: false, readiness: 'NOT_READY' },
    ]);
    await render(createElement(BgpMitigationWorkspace));
    await waitFor(() => text().includes('SEM SNAPSHOT'), 'badge SEM SNAPSHOT');
    expect(text()).toContain('SEM SNAPSHOT');
    expect(text()).not.toContain('NÃO APTO');
  });

  it('D) hydration READY + snapshotAvailable=true => readiness normal (APTO)', async () => {
    api.getMitigationHealth.mockResolvedValue({ ...health, snapshotHydration: hydration('READY') });
    api.getMitigationProfiles.mockResolvedValue([
      { ...readyProfile, snapshotAvailable: true, readiness: 'READY' },
    ]);
    await render(createElement(BgpMitigationWorkspace));
    await waitFor(() => text().includes('APTO'), 'badge APTO');
    expect(text()).not.toContain('REVALIDANDO');
    expect(text()).not.toContain('SEM SNAPSHOT');
  });
});

describe('estado de mitigacao visivel na tabela (runtimeState)', () => {
  function tableRow(customer: string): Element {
    const row = [...container.querySelectorAll('tbody tr')].find((candidate) =>
      (candidate.textContent ?? '').includes(customer),
    );
    if (!row) throw new Error(`linha nao encontrada na tabela: ${customer}`);
    return row;
  }

  async function abrirTabela(profiles: BgpMitigationProfileDto[]): Promise<void> {
    api.discoverMitigationProfiles.mockResolvedValue({ ...discovery, profiles });
    await render(createElement(BgpMitigationWorkspace));
    await chooseDevice('device-1');
    await clickByText('DESCOBRIR CLIENTES');
  }

  it('MITIGATED aparece como MITIGADO na tabela, sem abrir DETALHES', async () => {
    await abrirTabela([{ ...readyProfile, runtimeState: 'MITIGATED' }, candidateProfile]);

    const row = tableRow('HORIZONTE_IP');
    expect(row.textContent).toContain('MITIGADO');
    expect(row.querySelector('.mitigation-badge.is-mitigated')).not.toBeNull();
    expect(container.querySelector('[aria-label^="Detalhes de"]')).toBeNull();
  });

  it('NORMAL mostra NORMAL e nunca MITIGADO', async () => {
    await abrirTabela([{ ...readyProfile, runtimeState: 'NORMAL' }, candidateProfile]);

    const row = tableRow('HORIZONTE_IP');
    expect(row.textContent).toContain('NORMAL');
    expect(row.textContent).not.toContain('MITIGADO');
  });

  it('MITIGATING aparece como ATIVANDO', async () => {
    await abrirTabela([{ ...readyProfile, runtimeState: 'MITIGATING' }, candidateProfile]);

    expect(tableRow('HORIZONTE_IP').textContent).toContain('ATIVANDO');
  });

  it('RECOVERING aparece como RETIRANDO', async () => {
    await abrirTabela([{ ...readyProfile, runtimeState: 'RECOVERING' }, candidateProfile]);

    expect(tableRow('HORIZONTE_IP').textContent).toContain('RETIRANDO');
  });

  it('RECOVERY_PENDING, FAILED e RECONCILIATION_REQUIRED tem rotulos proprios', async () => {
    await abrirTabela([
      { ...readyProfile, id: 'p-recovery', customer: 'CLIENTE_RECOVERY', runtimeState: 'RECOVERY_PENDING' },
      { ...readyProfile, id: 'p-failed', customer: 'CLIENTE_FAILED', runtimeState: 'FAILED' },
      { ...readyProfile, id: 'p-revalidar', customer: 'CLIENTE_REVALIDAR', runtimeState: 'RECONCILIATION_REQUIRED' },
    ]);

    expect(tableRow('CLIENTE_RECOVERY').textContent).toContain('RECUPERAÇÃO PENDENTE');
    expect(tableRow('CLIENTE_FAILED').textContent).toContain('FALHA');
    expect(tableRow('CLIENTE_REVALIDAR').textContent).toContain('REVALIDAR');
  });

  it('cliente MITIGATED continua com RETIRAR MITIGACAO disponivel no DETALHES', async () => {
    await abrirTabela([{ ...readyProfile, runtimeState: 'MITIGATED' }, candidateProfile]);
    await openDetails('HORIZONTE_IP');

    const retirar = [...detailPanel().querySelectorAll('button')].find((button) =>
      (button.textContent ?? '').includes('RETIRAR MITIGAÇÃO'),
    ) as HTMLButtonElement | undefined;

    expect(retirar).toBeTruthy();
    expect(retirar?.disabled).toBe(false);
  });

  it('depois de REMOVED_VERIFIED + releitura do profile o badge volta para NORMAL', async () => {
    api.runMitigationCommand.mockResolvedValue({
      ...commandResult,
      action: 'REMOVE',
      status: 'REMOVED_VERIFIED',
    });
    api.getMitigationProfile.mockResolvedValue({ ...readyProfile, runtimeState: 'NORMAL' });
    await abrirTabela([{ ...readyProfile, runtimeState: 'MITIGATED' }, candidateProfile]);
    await openDetails('HORIZONTE_IP');

    await clickIn(detailPanel(), 'RETIRAR MITIGAÇÃO');
    await clickIn(find('[role="dialog"][aria-label="Confirmar ação de mitigação"]'), 'CONFIRMAR RETIRADA');

    const row = tableRow('HORIZONTE_IP');
    expect(row.textContent).toContain('NORMAL');
    expect(row.textContent).not.toContain('MITIGADO');
  });
});

describe('UI-AUTO-1: clareza operacional do painel de mitigacao', () => {
  function profileOf(overrides: Partial<BgpMitigationProfileDto> = {}): BgpMitigationProfileDto {
    return { ...readyProfile, ...overrides };
  }

  function autoProfile(overrides: Partial<BgpMitigationProfileDto> = {}): BgpMitigationProfileDto {
    return profileOf({
      id: 'auto-1',
      customer: 'BHNET-CEASA',
      interfaceId: 'if-auto',
      interfaceName: 'Eth-Trunk1.3043',
      interfaceDescription: 'BHNET-CEASA_10GB',
      policyName: 'PL-BHNET_IPv4-IN',
      addressFamily: 'IPV4',
      mode: 'AUTO',
      runtimeState: 'NORMAL',
      ...overrides,
    });
  }

  function engineOf(overrides: Partial<NonNullable<BgpMitigationHealthDto['autoEngine']>> = {}) {
    return {
      state: 'RUNNING' as const,
      evaluationIntervalMs: 5000,
      startedAt: '2026-10-13T18:20:12.000Z',
      lastTickAt: '2026-10-13T20:40:00.000Z',
      lastSuccessfulTickAt: '2026-10-13T20:40:00.000Z',
      lastError: null,
      lastDecision: null,
      decisions: [],
      lastAutoActivateAt: null,
      lastAutoActivateProfileId: null,
      ...overrides,
    };
  }

  function healthOf(overrides: Partial<BgpMitigationHealthDto> = {}): BgpMitigationHealthDto {
    return {
      ...health,
      mode: 'AUTO',
      executor: 'HUAWEI',
      liveWriteEnabled: true,
      allowedDeviceCount: 1,
      worker: { state: 'STOPPED' },
      ...overrides,
    };
  }

  function fact(label: string): string {
    const element = [...container.querySelectorAll('.nv-fact')].find((node) =>
      (node.textContent ?? '').includes(label),
    );
    return element?.textContent ?? '';
  }

  /** Renderiza e aguarda a condicao de prontidao (evita flakiness de query). */
  async function renderPanel(ready: () => boolean, label = 'painel carregado'): Promise<void> {
    await render(createElement(BgpMitigationWorkspace));
    await waitFor(ready, label);
  }

  it('indicadores: 1 AUTO / 35 ALERT_ONLY, 35 NORMAL + 1 DISABLED e 0 mitigações ativas', async () => {
    const alertProfiles = Array.from({ length: 35 }, (_, index) =>
      profileOf({
        id: `alert-${index}`,
        customer: `CLIENTE_${index}`,
        mode: 'ALERT_ONLY',
        runtimeState: index === 0 ? 'DISABLED' : 'NORMAL',
      }),
    );
    api.getMitigationProfiles.mockResolvedValue([autoProfile(), ...alertProfiles]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 36, auto: 1, alertOnly: 35, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => fact('perfis AUTO / ALERT_ONLY / OFF').includes('1 / 35 / 0'));

    expect(fact('mitigações ativas').startsWith('0')).toBe(true);
    expect(fact('em ativação').startsWith('0')).toBe(true);
    expect(fact('retirada/recuperação').startsWith('0')).toBe(true);
    expect(fact('requer atenção').startsWith('0')).toBe(true);
    expect(fact('perfis AUTO / ALERT_ONLY / OFF')).toContain('1 / 35 / 0');
    expect(fact('perfis de mitigação')).toContain('36');
    expect(fact('equipamentos')).toContain('1');
    expect(fact('perfil AUTO')).toContain('BHNET-CEASA');
  });

  it('indicadores separam MITIGATED, MITIGATING, RECOVERY e REQUER ATENÇÃO', async () => {
    api.getMitigationProfiles.mockResolvedValue([
      autoProfile({ runtimeState: 'MITIGATED' }),
      profileOf({ id: 'g-1', mode: 'ALERT_ONLY', runtimeState: 'MITIGATING' }),
      profileOf({ id: 'r-1', mode: 'ALERT_ONLY', runtimeState: 'RECOVERING' }),
      profileOf({ id: 'r-2', mode: 'ALERT_ONLY', runtimeState: 'RECOVERY_PENDING' }),
      profileOf({ id: 't-1', mode: 'ALERT_ONLY', runtimeState: 'TRIGGER_PENDING' }),
      profileOf({ id: 'f-1', mode: 'ALERT_ONLY', runtimeState: 'FAILED' }),
      profileOf({ id: 'c-1', mode: 'ALERT_ONLY', runtimeState: 'RECONCILIATION_REQUIRED' }),
    ]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 7, auto: 1, alertOnly: 6, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => fact('mitigações ativas').startsWith('1'));

    expect(fact('mitigações ativas').startsWith('1')).toBe(true);
    expect(fact('em ativação').startsWith('1')).toBe(true);
    expect(fact('retirada/recuperação').startsWith('2')).toBe(true);
    expect(fact('aguardando gatilho').startsWith('1')).toBe(true);
    expect(fact('requer atenção').startsWith('2')).toBe(true);
  });

  it('decisão do perfil AUTO não herda a decisão global de um ALERT_ONLY bloqueado', async () => {
    api.getMitigationProfiles.mockResolvedValue([
      autoProfile(),
      profileOf({
        id: 'alert-blocked',
        customer: 'WFREDES',
        mode: 'ALERT_ONLY',
        runtimeState: 'DISABLED',
        snapshotAvailable: false,
      }),
    ]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 2, auto: 1, alertOnly: 1, disabled: 0 },
        autoEngine: engineOf({
          lastDecision: {
            at: '2026-10-13T20:39:00.000Z',
            profileId: 'alert-blocked',
            deviceId: 'device-1',
            customer: 'WFREDES',
            outcome: 'BLOCKED',
            reason: 'SNAPSHOT_UNAVAILABLE',
            trafficBps: null,
            thresholdBps: null,
            runtimeState: 'DISABLED',
            commandStatus: null,
            verified: false,
            detail: null,
          },
          decisions: [
            {
              at: '2026-10-13T20:39:00.000Z',
              profileId: 'alert-blocked',
              deviceId: 'device-1',
              customer: 'WFREDES',
              outcome: 'BLOCKED',
              reason: 'SNAPSHOT_UNAVAILABLE',
              trafficBps: null,
              thresholdBps: null,
              runtimeState: 'DISABLED',
              commandStatus: null,
              verified: false,
              detail: null,
            },
            {
              at: '2026-10-13T20:39:30.000Z',
              profileId: 'auto-1',
              deviceId: 'device-1',
              customer: 'BHNET-CEASA',
              outcome: 'NO_ACTION',
              reason: 'THRESHOLD_NOT_EXCEEDED',
              trafficBps: null,
              thresholdBps: null,
              runtimeState: 'NORMAL',
              commandStatus: null,
              verified: false,
              detail: null,
            },
          ],
        }),
      }),
    );
    await renderPanel(() => fact('decisão do perfil AUTO').includes('NO_ACTION'));

    expect(fact('decisão do perfil AUTO')).toContain('NO_ACTION');
    expect(fact('decisão do perfil AUTO')).not.toContain('SNAPSHOT_UNAVAILABLE');
    expect(fact('última decisão (global)')).toContain('SNAPSHOT_UNAVAILABLE');
  });

  it('sem decisão por perfil o painel diz indisponível (não atribui decisão alheia)', async () => {
    api.getMitigationProfiles.mockResolvedValue([autoProfile()]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 1, auto: 1, alertOnly: 0, disabled: 0 },
        autoEngine: engineOf({ decisions: [], lastDecision: null }),
      }),
    );
    await renderPanel(() => fact('decisão do perfil AUTO').includes('indisponível'));

    expect(fact('decisão do perfil AUTO')).toContain('indisponível');
  });

  it('sem perfis carregados os indicadores mostram — (nunca zero como total global)', async () => {
    api.getMitigationProfiles.mockResolvedValue([]);
    const healthWithoutProfiles = healthOf({ autoEngine: engineOf({ decisions: [] }) });
    delete (healthWithoutProfiles as { profiles?: unknown }).profiles;
    api.getMitigationHealth.mockResolvedValue(healthWithoutProfiles);
    await renderPanel(() => !text().includes('Carregando perfis de mitigação…'));

    expect(fact('mitigações ativas').startsWith('—')).toBe(true);
    expect(fact('perfis AUTO / ALERT_ONLY / OFF')).toContain('—');
  });

  it('worker externo não aparece como motor desligado', async () => {
    api.getMitigationProfiles.mockResolvedValue([autoProfile()]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        worker: { state: 'STOPPED' },
        profiles: { total: 1, auto: 1, alertOnly: 0, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => fact('motor AUTO (API)').includes('RUNNING'));

    expect(fact('motor AUTO (API)')).toContain('RUNNING');
    expect(fact('worker externo')).toContain('não implantado');
    expect(text()).not.toContain('PARADO');
  });

  it('filtro SOMENTE AUTO mostra apenas os perfis AUTO e preserva DETALHES', async () => {
    api.getMitigationProfiles.mockResolvedValue([
      autoProfile(),
      profileOf({ id: 'alert-1', customer: 'CLIENTE_ALERTA', mode: 'ALERT_ONLY' }),
    ]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 2, auto: 1, alertOnly: 1, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => text().includes('CLIENTE_ALERTA'));

    expect(text()).toContain('CLIENTE_ALERTA');
    await clickByText('SOMENTE AUTO');
    expect(text()).toContain('BHNET-CEASA');
    expect(text()).not.toContain('CLIENTE_ALERTA');
    expect(container.textContent).toContain('SOMENTE AUTO (1)');

    await clickByText('DETALHES');
    expect(text()).toContain('Detalhes do cliente');
  });

  it('filtro MITIGADOS isola o perfil com runtime MITIGATED', async () => {
    api.getMitigationProfiles.mockResolvedValue([
      autoProfile({ id: 'm-1', customer: 'MITIGADO_X', runtimeState: 'MITIGATED' }),
      profileOf({ id: 'n-1', customer: 'NORMAL_Y', runtimeState: 'NORMAL' }),
    ]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 2, auto: 1, alertOnly: 1, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => text().includes('NORMAL_Y'));

    await clickByText('MITIGADOS');
    expect(text()).toContain('MITIGADO_X');
    expect(text()).not.toContain('NORMAL_Y');
  });

  it('filtro REQUER ATENÇÃO isola FAILED/RECONCILIATION_REQUIRED', async () => {
    api.getMitigationProfiles.mockResolvedValue([
      profileOf({ id: 'f-1', customer: 'FALHA_X', runtimeState: 'FAILED' }),
      profileOf({ id: 'c-1', customer: 'REVALIDAR_Y', runtimeState: 'RECONCILIATION_REQUIRED' }),
      profileOf({ id: 'n-1', customer: 'NORMAL_Z', runtimeState: 'NORMAL' }),
    ]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 3, auto: 0, alertOnly: 3, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => text().includes('FALHA_X'));

    await clickByText('REQUER ATENÇÃO');
    expect(text()).toContain('FALHA_X');
    expect(text()).toContain('REVALIDAR_Y');
    expect(text()).not.toContain('NORMAL_Z');
  });

  it('legenda reflete o modo efetivo (live write ativo) em vez de "nenhuma ação automática"', async () => {
    api.getMitigationProfiles.mockResolvedValue([autoProfile()]);
    api.getMitigationHealth.mockResolvedValue(
      healthOf({
        profiles: { total: 1, auto: 1, alertOnly: 0, disabled: 0 },
        autoEngine: engineOf(),
      }),
    );
    await renderPanel(() => text().includes('live write SIM'));

    expect(text()).toContain('live write SIM');
    expect(text()).toContain('mitigação automática armada');
    expect(text()).not.toContain('nenhuma ação automática');
    expect(text()).not.toContain('clientes descobertos');
  });
});
