// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlarmRuleDto } from '@gmj/shared';

const api = vi.hoisted(() => ({
  getAlarmRules: vi.fn(),
  createAlarmRule: vi.fn(),
  updateAlarmRule: vi.fn(),
  setAlarmRuleEnabled: vi.fn(),
  deleteAlarmRule: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  ...api,
}));

const mediaApi = vi.hoisted(() => ({
  getMediaIntegrationsByPurpose: vi.fn(),
}));

vi.mock('@/lib/media-api', () => ({
  ...mediaApi,
  MEDIA_SOURCE_LABELS: { DATABASE: 'BANCO', ENV: 'ENV / LEGACY', MEMORY: 'MEMÓRIA', NONE: 'NÃO CONFIGURADO' },
  MEDIA_STATUS_LABELS: {
    DISABLED: 'Desativado',
    NOT_CONFIGURED: 'Não configurado',
    NEVER_TESTED: 'Configurado · nunca testado',
    LAST_DELIVERY_OK: 'Último envio OK',
    LAST_DELIVERY_FAILED: 'Erro no último envio',
  },
}));

import { AlarmRulesPanel } from './alarm-rules-panel';
import { BASIC_ALARM_RULE_SLOTS, opticalRuleDefaults } from '@/lib/alarm-rule-presets';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const CRC_RULE: AlarmRuleDto = {
  id: 'rule-crc',
  name: 'CRC backbone',
  type: 'INTERFACE_CRC',
  enabled: true,
  severity: 'WARNING',
  mapLinkedOnly: true,
  mediaEnabled: true,
  scope: { speedsBps: [40_000_000_000, 100_000_000_000] },
  config: {
    thresholdPerMinute: 2,
    recoveryThresholdPerMinute: 0,
    triggerSamples: 1,
    recoverySamples: 1,
  },
  managedKey: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
};

/** Regra gerenciada pelo Básico (slot CRC) com o preset recomendado. */
const MANAGED_CRC_RULE: AlarmRuleDto = {
  id: 'rule-basic-crc',
  name: 'CRC/FCS (recomendado)',
  type: 'INTERFACE_CRC',
  enabled: true,
  severity: 'WARNING',
  mapLinkedOnly: true,
  mediaEnabled: false,
  scope: {},
  config: { ...BASIC_ALARM_RULE_SLOTS[0]!.config },
  managedKey: 'BASIC_INTERFACE_CRC',
  createdAt: '2026-10-08T12:00:00.000Z',
  updatedAt: '2026-10-08T12:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

async function mount(): Promise<HTMLDivElement> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const element: ReactElement = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(AlarmRulesPanel),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * React controla o `value` do input; escrever direto na propriedade e ignorado.
 * O setter nativo + evento de input e o que o React entende como digitacao.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`Botão "${label}" não encontrado`);
  return found;
}

function cardFor(title: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.alarms-basic-card')].find((item) =>
    item.querySelector('strong')?.textContent?.includes(title),
  );
  if (!found) throw new Error(`Card "${title}" não encontrado`);
  return found;
}

function cardButton(title: string, label: string): HTMLButtonElement {
  const found = [...cardFor(title).querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`Botão "${label}" do card "${title}" não encontrado`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await flush();
}

async function openAdvanced(): Promise<void> {
  await click(button('AVANÇADO'));
}

async function remount(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  await mount();
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getAlarmRules.mockResolvedValue([CRC_RULE]);
  api.createAlarmRule.mockResolvedValue(CRC_RULE);
  api.updateAlarmRule.mockResolvedValue(CRC_RULE);
  api.setAlarmRuleEnabled.mockResolvedValue({ ...CRC_RULE, enabled: false });
  api.deleteAlarmRule.mockResolvedValue({ removed: true });
  mediaApi.getMediaIntegrationsByPurpose.mockResolvedValue({
    repositoryKind: 'DATABASE',
    migrationReady: true,
    resolvedPurpose: 'NETWORK_ALARMS',
    legacyEnv: {
      outboundUrlConfigured: false,
      outboundTokenConfigured: false,
      inboundTokenConfigured: false,
      inboundEndpointPath: '/api/integrations/n8n/mitigation-command',
    },
    integration: {
      id: 'media-alarms',
      name: 'n8n — Alarmes de Rede',
      type: 'WEBHOOK',
      purpose: 'NETWORK_ALARMS',
      enabled: true,
      configSource: 'DATABASE',
      status: 'NEVER_TESTED',
      outboundConfigured: true,
      outboundUrl: 'https://n8n.exemplo.com/webhook/alarmes',
      outboundTokenConfigured: true,
      inboundEnabled: false,
      inboundConfigured: false,
      inboundTokenConfigured: false,
      inboundEndpointPath: '',
      lastOutboundAttemptAt: null,
      lastOutboundSuccessAt: null,
      lastOutboundFailureAt: null,
      lastOutboundStatusCode: null,
      lastOutboundLatencyMs: null,
      lastOutboundEvent: null,
      lastOutboundErrorSafe: null,
      lastInboundAt: null,
      lastInboundAction: null,
      lastInboundStatus: null,
      lastInboundRequestId: null,
      lastInboundErrorSafe: null,
      createdAt: '2026-10-07T12:00:00.000Z',
      updatedAt: '2026-10-07T12:00:00.000Z',
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('painel CONFIGURAÇÕES → ALARMES (AVANÇADO)', () => {
  it('lista regras com resumo, escopo, severidade e mídia', async () => {
    const view = await mount();
    await openAdvanced();

    expect(view.textContent).toContain('CRC backbone');
    expect(view.textContent).toContain('CRC/FCS');
    expect(view.textContent).toContain('RX > 2 CRC/min · 1 amostra');
    expect(view.textContent).toContain('40G / 100G');
    expect(view.textContent).toContain('WARNING');
    expect(view.textContent).toContain('MÍDIA: SIM');
    expect(view.textContent).toContain('ATIVA');
  });

  it('cria regra de CRC a partir do preset QUALQUER CRC com mídia ligada', async () => {
    await mount();
    await openAdvanced();
    await click(button('NOVA REGRA'));
    await click(button('QUALQUER CRC'));

    const nameInput = container.querySelector<HTMLInputElement>('.alarms-form input');
    expect(nameInput?.value).toBe('QUALQUER CRC');
    await act(async () => {
      typeInto(nameInput!, 'CRC acesso');
    });

    const mediaToggle = [...container.querySelectorAll<HTMLButtonElement>('.alarms-form__toggle button')]
      .find((item) => item.textContent === 'OFF');
    await click(mediaToggle!);
    await click(button('SALVAR'));

    expect(api.createAlarmRule).toHaveBeenCalledTimes(1);
    expect(api.createAlarmRule.mock.calls[0]?.[0]).toMatchObject({
      name: 'CRC acesso',
      type: 'INTERFACE_CRC',
      severity: 'WARNING',
      mediaEnabled: true,
      mapLinkedOnly: true,
      scope: {},
      config: {
        thresholdPerMinute: 0,
        recoveryThresholdPerMinute: 0,
        triggerSamples: 1,
        recoverySamples: 1,
      },
    });
    // Regra custom: nenhum vínculo com o Básico.
    expect(api.createAlarmRule.mock.calls[0]?.[0]).not.toHaveProperty('managedKey');
  });

  it('regra óptica nasce com os defaults (3 dB WARN / 5 dB MAJOR / 30 min)', async () => {
    await mount();
    await openAdvanced();
    await click(button('NOVA REGRA'));
    const typeSelect = container.querySelector<HTMLSelectElement>('.alarms-form select');
    await act(async () => {
      typeSelect!.value = 'OPTICAL_RX_DEGRADATION';
      typeSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const nameInput = container.querySelector<HTMLInputElement>('.alarms-form input');
    await act(async () => {
      typeInto(nameInput!, 'Óptico backbone');
    });
    await click(button('SALVAR'));

    expect(api.createAlarmRule.mock.calls[0]?.[0]).toMatchObject({
      type: 'OPTICAL_RX_DEGRADATION',
      config: {
        ...opticalRuleDefaults(),
      },
    });
  });

  it('edita regra existente preservando escopo por velocidade e o managedKey', async () => {
    await mount();
    await openAdvanced();
    await click(button('EDITAR'));
    const nameInput = container.querySelector<HTMLInputElement>('.alarms-form input');
    expect(nameInput?.value).toBe('CRC backbone');
    await act(async () => {
      typeInto(nameInput!, 'CRC backbone v2');
    });
    await click(button('SALVAR'));

    expect(api.updateAlarmRule.mock.calls[0]?.[0]).toBe('rule-crc');
    expect(api.updateAlarmRule.mock.calls[0]?.[1]).toMatchObject({
      name: 'CRC backbone v2',
      scope: { speedsBps: [40_000_000_000, 100_000_000_000] },
    });
    // O formulário avançado NUNCA envia managedKey (o backend preserva o slot).
    expect(api.updateAlarmRule.mock.calls[0]?.[1]).not.toHaveProperty('managedKey');
    expect(api.createAlarmRule).not.toHaveBeenCalled();
  });

  it('desativa e exclui (com confirmação) usando o CRUD do backend', async () => {
    await mount();
    await openAdvanced();
    await click(button('DESATIVAR'));
    expect(api.setAlarmRuleEnabled).toHaveBeenCalledWith('rule-crc', false);

    await flush();
    await click(button('EXCLUIR'));
    expect(api.deleteAlarmRule).not.toHaveBeenCalled();
    await click(button('CONFIRMAR EXCLUSÃO'));
    expect(api.deleteAlarmRule).toHaveBeenCalledWith('rule-crc');
  });

  it('mostra o selo GERENCIADA PELO BÁSICO e avisa ao editar uma regra gerenciada', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();
    await openAdvanced();

    expect(container.textContent).toContain('GERENCIADA PELO BÁSICO');
    await click(button('EDITAR'));
    expect(container.textContent).toContain('Regra GERENCIADA PELO BÁSICO');
  });
});

describe('aba BÁSICO (F9.6)', () => {
  it('com zero regras mostra a proteção nativa e 4 cards disponíveis SEM criar nada', async () => {
    api.getAlarmRules.mockResolvedValue([]);
    await mount();

    const text = container.textContent ?? '';
    expect(text).toContain('QUEDA DE INTERFACE');
    expect(text).toContain('PROTEÇÃO NATIVA');
    expect(text).toContain('Somente enlaces de mapa');
    expect(text).toContain('fase futura');
    expect(text).toContain('CRC / FCS');
    expect(text).toContain('DISCARDS');
    expect(text).toContain('ERROS DE INTERFACE');
    expect(text).toContain('DEGRADAÇÃO ÓPTICA');
    expect(container.querySelectorAll('.alarms-basic-card')).toHaveLength(5);
    // Nenhuma escrita ao abrir a tela.
    expect(api.createAlarmRule).not.toHaveBeenCalled();
    expect(api.updateAlarmRule).not.toHaveBeenCalled();
    expect(api.setAlarmRuleEnabled).not.toHaveBeenCalled();
    expect(api.deleteAlarmRule).not.toHaveBeenCalled();
  });

  it('ATIVAR CRC cria UMA regra gerenciada com o preset recomendado', async () => {
    api.getAlarmRules.mockResolvedValue([]);
    await mount();
    await click(cardButton('CRC / FCS', 'ATIVO'));

    expect(api.createAlarmRule).toHaveBeenCalledTimes(1);
    expect(api.createAlarmRule.mock.calls[0]?.[0]).toMatchObject({
      type: 'INTERFACE_CRC',
      managedKey: 'BASIC_INTERFACE_CRC',
      enabled: true,
      severity: 'WARNING',
      mapLinkedOnly: true,
      mediaEnabled: false,
      scope: {},
      config: {
        thresholdPerMinute: 10,
        recoveryThresholdPerMinute: 2,
        triggerSamples: 3,
        recoverySamples: 3,
      },
    });
  });

  it('segunda ativação reativa a MESMA regra (PATCH enabled) sem duplicar', async () => {
    api.getAlarmRules.mockResolvedValue([{ ...MANAGED_CRC_RULE, enabled: false }]);
    await mount();
    await click(cardButton('CRC / FCS', 'ATIVO'));

    expect(api.createAlarmRule).not.toHaveBeenCalled();
    expect(api.setAlarmRuleEnabled).toHaveBeenCalledWith('rule-basic-crc', true);
  });

  it('OFF desativa (nunca exclui) e explica que alarmes abertos são encerrados', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();

    const toggle = cardButton('CRC / FCS', 'ATIVO');
    expect(toggle.title).toContain('encerra os alarmes atualmente abertos');
    await click(toggle);

    expect(api.setAlarmRuleEnabled).toHaveBeenCalledWith('rule-basic-crc', false);
    expect(api.deleteAlarmRule).not.toHaveBeenCalled();
  });

  it('MÍDIA altera somente mediaEnabled preservando nome, config e o slot', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();
    await click(cardButton('CRC / FCS', 'MÍDIA'));

    expect(api.updateAlarmRule).toHaveBeenCalledTimes(1);
    const [id, input] = api.updateAlarmRule.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('rule-basic-crc');
    expect(input).toMatchObject({
      mediaEnabled: true,
      enabled: true,
      name: 'CRC/FCS (recomendado)',
      mapLinkedOnly: true,
      managedKey: 'BASIC_INTERFACE_CRC',
      config: { ...BASIC_ALARM_RULE_SLOTS[0]!.config },
    });
  });

  it('SOMENTE ENLACES alterna só o mapLinkedOnly', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();
    await click(cardButton('CRC / FCS', 'SOMENTE ENLACES'));

    expect(api.updateAlarmRule.mock.calls[0]?.[1]).toMatchObject({ mapLinkedOnly: false });
  });

  it('badge RECOMENDADA com preset intacto e PERSONALIZADA quando o Avançado mudou algo', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();
    expect(cardFor('CRC / FCS').textContent).toContain('CONFIGURAÇÃO: RECOMENDADA');

    api.getAlarmRules.mockResolvedValue([{
      ...MANAGED_CRC_RULE,
      config: { ...MANAGED_CRC_RULE.config, thresholdPerMinute: 5 },
    }]);
    await remount();
    expect(cardFor('CRC / FCS').textContent).toContain('CONFIGURAÇÃO: PERSONALIZADA');
  });

  it('PERSONALIZAR com regra gerenciada abre o AVANÇADO na mesma regra', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();
    await click(cardButton('CRC / FCS', 'PERSONALIZAR'));

    expect(container.textContent).toContain('EDITAR · CRC/FCS (recomendado)');
    expect(api.updateAlarmRule).not.toHaveBeenCalled();
    expect(api.createAlarmRule).not.toHaveBeenCalled();
  });

  it('PERSONALIZAR sem regra abre o formulário com o preset SEM persistir', async () => {
    api.getAlarmRules.mockResolvedValue([]);
    await mount();
    await click(cardButton('CRC / FCS', 'PERSONALIZAR'));

    expect(container.textContent).toContain('NOVA REGRA');
    const nameInput = container.querySelector<HTMLInputElement>('.alarms-form input');
    expect(nameInput?.value).toBe('CRC/FCS (recomendado)');
    expect(api.createAlarmRule).not.toHaveBeenCalled();
  });

  it('avisa quando existe outra regra avançada ativa do mesmo tipo', async () => {
    const customSameType: AlarmRuleDto = {
      ...CRC_RULE,
      id: 'rule-crc-custom',
      name: 'CRC crítico backbone',
    };
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE, customSameType]);
    await mount();

    expect(cardFor('CRC / FCS').textContent).toContain('+1 regra avançada ativa do mesmo tipo');
  });

  it('excluir a regra gerenciada no Avançado devolve o card para DISPONÍVEL', async () => {
    api.getAlarmRules.mockResolvedValue([MANAGED_CRC_RULE]);
    await mount();
    expect(cardFor('CRC / FCS').textContent).toContain('CONFIGURAÇÃO: RECOMENDADA');

    await openAdvanced();
    await click(button('EXCLUIR'));
    await click(button('CONFIRMAR EXCLUSÃO'));
    expect(api.deleteAlarmRule).toHaveBeenCalledWith('rule-basic-crc');

    // Depois da exclusão a lista volta sem a regra: o card fica disponível.
    api.getAlarmRules.mockResolvedValue([]);
    await remount();
    expect(cardFor('CRC / FCS').textContent).toContain('CONFIGURAÇÃO: DISPONÍVEL');
    expect(cardButton('CRC / FCS', 'ATIVO').getAttribute('aria-pressed')).toBe('false');
  });

  it('avisa quando o canal de mídia dos alarmes não está configurado', async () => {
    mediaApi.getMediaIntegrationsByPurpose.mockResolvedValue({
      repositoryKind: 'DATABASE',
      migrationReady: true,
      resolvedPurpose: null,
      legacyEnv: {
        outboundUrlConfigured: false,
        outboundTokenConfigured: false,
        inboundTokenConfigured: false,
        inboundEndpointPath: '',
      },
      integration: null,
    });
    api.getAlarmRules.mockResolvedValue([{ ...MANAGED_CRC_RULE, mediaEnabled: true }]);
    await mount();

    expect(cardFor('CRC / FCS').textContent).toContain('Canal de mídia não configurado');
  });
});
