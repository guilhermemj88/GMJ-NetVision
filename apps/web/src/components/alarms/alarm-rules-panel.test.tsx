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

import { AlarmRulesPanel } from './alarm-rules-panel';
import { opticalRuleDefaults } from '@/lib/alarm-rule-presets';

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
  createdAt: '2026-10-01T12:00:00.000Z',
  updatedAt: '2026-10-01T12:00:00.000Z',
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

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await flush();
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getAlarmRules.mockResolvedValue([CRC_RULE]);
  api.createAlarmRule.mockResolvedValue(CRC_RULE);
  api.updateAlarmRule.mockResolvedValue(CRC_RULE);
  api.setAlarmRuleEnabled.mockResolvedValue({ ...CRC_RULE, enabled: false });
  api.deleteAlarmRule.mockResolvedValue({ removed: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('painel CONFIGURAÇÕES → ALARMES', () => {
  it('lista regras com resumo, escopo, severidade e mídia', async () => {
    const view = await mount();

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
        thresholdPerMinute: 1,
        recoveryThresholdPerMinute: 0,
        triggerSamples: 1,
        recoverySamples: 1,
      },
    });
  });

  it('regra óptica nasce com os defaults (3 dB WARN / 5 dB MAJOR / 30 min)', async () => {
    await mount();
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

  it('edita regra existente preservando escopo por velocidade', async () => {
    await mount();
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
    expect(api.createAlarmRule).not.toHaveBeenCalled();
  });

  it('desativa e exclui (com confirmação) usando o CRUD do backend', async () => {
    await mount();
    await click(button('DESATIVAR'));
    expect(api.setAlarmRuleEnabled).toHaveBeenCalledWith('rule-crc', false);

    await flush();
    await click(button('EXCLUIR'));
    expect(api.deleteAlarmRule).not.toHaveBeenCalled();
    await click(button('CONFIRMAR EXCLUSÃO'));
    expect(api.deleteAlarmRule).toHaveBeenCalledWith('rule-crc');
  });
});
