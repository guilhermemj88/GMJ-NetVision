// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VsiDiagnosticResult } from '@gmj/shared';
import { VsiDiagnosticResultView } from './result-view';
import { access, vsi1809Result as base, VSI_1809_IDS } from './vsi-1809.fixture';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

function summaryOf(title: string): HTMLElement | null {
  return [...container.querySelectorAll('summary')].find((node) =>
    node.textContent?.includes(title),
  ) as HTMLElement | null;
}

async function render(result: VsiDiagnosticResult): Promise<string> {
  await act(async () => root.render(<VsiDiagnosticResultView result={result} />));
  return container.textContent ?? '';
}

function contextText(): string {
  return container.querySelector('dl[aria-label="Contexto de execução"]')?.textContent ?? '';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('VsiDiagnosticResultView — caso 1809 (COMPLETED / OK)', () => {
  it('mostra cabecalho com status, VSI, PEs, underlay, execucao, operador e duracao', async () => {
    const text = await render(base);
    expect(container.querySelector('header')!.textContent).toContain('OK');
    expect(text).toContain('1809-L2L-VCONLINE-QinQ');
    expect(text).toContain('IIE-VSR-6730-MPLS-01');
    expect(text).toContain('RNS-FLOR-6730-MPLS-01');
    expect(text).toContain('UNDERLAY_REACHABLE');
    expect(text).toContain('04778b69-33e2-4242-baf9-6591381f8375');
    expect(text).toContain('admin · ADMIN');
    expect(text).toContain('10 s');
  });

  it('mostra os 9 cards de saude com reachability por sentido', async () => {
    await render(base);
    const list = container.querySelector('ul[aria-label="Saúde dos componentes"]');
    expect(list).not.toBeNull();
    expect(list!.querySelectorAll('li')).toHaveLength(9);
    expect(list!.textContent).toContain('Alcançável · 3/3 respostas em cada sentido');
    expect(list!.textContent).not.toContain('6/6');
  });

  it('topologia local -> VSI -> PW -> VSI -> remoto com labels e ACs de cada PE', async () => {
    await render(base);
    const topology = container.querySelector('[aria-label="Cadeia do circuito"]')!;
    const [local, , , remote] = [...topology.children].filter((node) =>
      node.className.includes('node'),
    );
    expect(topology.textContent).toContain('PW');
    expect(local!.textContent).toContain('IIE-VSR-6730-MPLS-01');
    expect(local!.textContent).toContain('10.100.101.5');
    expect(local!.textContent).toContain('XGigabitEthernet0/0/6.1809');
    expect(local!.textContent).toContain('labels in/out 38464 / 37134');
    expect(remote!.textContent).toContain('RNS-FLOR-6730-MPLS-01');
    expect(remote!.textContent).toContain('10.100.101.6');
    expect(remote!.textContent).toContain('XGigabitEthernet0/0/16.1809');
    expect(remote!.textContent).toContain('labels in/out 37134 / 38464');
  });

  it('PW compara local x remoto e mostra os labels cruzados dos dois PEs', async () => {
    await render(base);
    await act(async () => summaryOf('PW')!.click());
    const rows = [...container.querySelectorAll('table tbody tr')].map((row) => row.textContent);
    expect(rows).toEqual([
      expect.stringContaining('IIE-VSR-6730-MPLS-01') as unknown as string,
      expect.stringContaining('RNS-FLOR-6730-MPLS-01') as unknown as string,
    ]);
    expect(rows[0]).toContain('38464 / 37134');
    expect(rows[1]).toContain('37134 / 38464');
    expect(container.textContent).toContain('labels cruzados MATCH');
  });

  it('mantem as secoes fechadas e abre ao clicar', async () => {
    await render(base);
    const details = [...container.querySelectorAll('details')];
    expect(details.length).toBeGreaterThanOrEqual(7);
    expect(details.every((node) => node.open === false)).toBe(true);
    await act(async () => summaryOf('VSI')!.click());
    expect((summaryOf('VSI')!.parentElement as HTMLDetailsElement).open).toBe(true);
  });

  it('reachability: manchete "Alcançável · 3/3 respostas", perda e RTT como detalhe', async () => {
    const text = await render(base);
    const probe = [...container.querySelectorAll('li')].find((node) =>
      node.textContent?.includes('10.100.101.5 → 10.100.101.6'),
    )!;
    expect(probe.querySelector('strong')!.textContent).toBe('Alcançável · 3/3 respostas');
    expect(probe.textContent!.indexOf('perda 0%')).toBeGreaterThan(
      probe.textContent!.indexOf('Alcançável · 3/3 respostas'),
    );
    expect(text).toContain('Tracert não executado: NOT_HOMOLOGATED');
  });
});

describe('Contexto de execução (fonte: executionContext do backend)', () => {
  it('CONFIRMED_FOR_EXECUTED_COMMANDS: RBAC, conta SSH, autorizacao restrita e AAA nao verificado', async () => {
    await render(base);
    const text = contextText();
    expect(text).toContain('Permissão no NetVision');
    expect(text).toContain('admin (ADMIN) — usuário que iniciou esta execução.');
    expect(text).toContain('Acesso aos equipamentos');
    expect(text).toContain('Conta de serviço guilherme3.');
    expect(text).toContain('Confirmada para os comandos executados nesta execução nos dois PEs.');
    expect(text).toContain('Vale somente para os comandos executados nesta execução.');
    expect(text).toContain('Nível de privilégio no equipamento');
    expect(text).toContain(
      'Não verificado explicitamente. Isso não afeta o resultado desta execução.',
    );
    expect(text).not.toMatch(/privilégio (total|suficiente)|nível máximo/i);
  });

  it('NOT_CONFIRMED nunca diz que todos os comandos foram autorizados', async () => {
    await render({
      ...base,
      overallStatus: 'INSUFFICIENT_DATA',
      executionContext: {
        endpoints: [
          access(VSI_1809_IDS.LOCAL, 'IIE-VSR-6730-MPLS-01', {
            commandAuthorization: 'NOT_CONFIRMED',
            executedCommands: 6,
            acceptedCommands: 6,
          }),
          access(VSI_1809_IDS.REMOTE, 'RNS-FLOR-6730-MPLS-01', {
            commandAuthorization: 'NOT_CONFIRMED',
            executedCommands: 5,
            acceptedCommands: 4,
          }),
        ],
      },
    });
    const text = contextText();
    expect(text).not.toContain('Confirmada para os comandos executados');
    expect(text).toContain(
      'RNS-FLOR-6730-MPLS-01: não confirmada (4/5 comandos com evidência válida).',
    );
    expect(text).toContain(
      'IIE-VSR-6730-MPLS-01: não confirmada; nem todos os comandos necessários foram executados (6/6 com evidência válida).',
    );
    expect(text).toContain('Não verificado explicitamente.');
    expect(text).not.toContain('Isso não afeta o resultado');
  });

  it('NOT_EXECUTED fica neutro e nunca vira "permission denied"', async () => {
    await render({
      ...base,
      overallStatus: 'INSUFFICIENT_DATA',
      remotes: [],
      executionContext: {
        endpoints: [
          access(VSI_1809_IDS.LOCAL, 'IIE-VSR-6730-MPLS-01', {
            sshUsername: null,
            commandAuthorization: 'NOT_EXECUTED',
            executedCommands: 0,
            acceptedCommands: 0,
          }),
        ],
      },
    });
    const text = contextText();
    expect(text).toContain('Nenhuma sessão SSH aberta nesta execução.');
    expect(text).toContain('IIE-VSR-6730-MPLS-01: nenhum comando executado nesta execução.');
    expect(text).not.toMatch(/denied|negad|sem permiss/i);
    expect(text).not.toContain('guilherme3');
  });

  it('sem executionContext (API antiga) nao infere autorizacao', async () => {
    const legacy = { ...base };
    delete (legacy as { executionContext?: unknown }).executionContext;
    await render(legacy);
    expect(contextText()).toContain('não informada pelo servidor');
    expect(contextText()).not.toContain('Confirmada');
  });
});

describe('Limitacoes, AAA e RUNNING', () => {
  it('preserva as limitacoes reais e mantem AAA fora delas', async () => {
    const text = await render(base);
    await act(async () => summaryOf('Limitações da análise')!.click());
    const limitations = summaryOf('Limitações da análise')!.parentElement!.textContent ?? '';
    for (const real of [
      'Traceroute real desabilitado: NOT_HOMOLOGATED.',
      'F1A, cliente final, porta física, CRC, LLDP e LSP detalhado não avaliados.',
      'Conclusão limitada às evidências e horários desta execução',
      'Ping IP não comprova caminho físico, caminho completo da VSI, LSP ou entrega ao cliente.',
    ])
      expect(limitations).toContain(real);
    expect(limitations).not.toMatch(/AAA|privilégio/i);
    expect(text).not.toContain('AAA = NOT_VERIFIED');
    expect(text).not.toContain('AAA não verificado');
    expect(text).not.toContain('privilégios da conta');
  });

  it('RUNNING: "DIAGNÓSTICO EM ANDAMENTO" + stepper, sem veredito provisorio', async () => {
    const text = await render({
      ...base,
      state: 'RUNNING',
      stage: 'Validando e coletando PE remoto: RNS-FLOR-6730-MPLS-01',
      completedAt: null,
      overallStatus: 'INSUFFICIENT_DATA',
      summary: 'Diagnóstico solicitado; nenhuma conclusão disponível.',
    });
    expect(text).toContain('DIAGNÓSTICO EM ANDAMENTO');
    expect(text).toContain('Coletando e validando evidências dos PEs…');
    expect(container.querySelector('[aria-label="Diagnóstico em andamento"]')).not.toBeNull();
    expect(text).not.toContain('INSUFFICIENT_DATA');
    expect(text).not.toContain('nenhuma conclusão disponível');
    expect(container.querySelector('ul[aria-label="Saúde dos componentes"]')).toBeNull();
    expect(container.querySelector('[aria-label="Cadeia do circuito"]')).toBeNull();
    expect(container.querySelectorAll('details')).toHaveLength(0);
  });

  it('INSUFFICIENT_DATA final continua aparecendo como veredito', async () => {
    const text = await render({ ...base, overallStatus: 'INSUFFICIENT_DATA' });
    expect(container.querySelector('header')!.textContent).toContain('INSUFFICIENT_DATA');
    expect(text).not.toContain('DIAGNÓSTICO EM ANDAMENTO');
  });
});

describe('Ausencia de PE remoto', () => {
  it('cards remotos e topologia ficam neutros, sem inventar estado', async () => {
    await render({
      ...base,
      overallStatus: 'INSUFFICIENT_DATA',
      remotes: [],
      probes: [],
      checks: base.checks.filter((check) => check.hostId === VSI_1809_IDS.LOCAL),
    });
    const cards = [...container.querySelectorAll('ul[aria-label="Saúde dos componentes"] li')];
    for (const title of ['Loopback remoto', 'VSI remota', 'AC remoto']) {
      const card = cards.find((node) => node.textContent?.includes(title))!;
      expect(card.className).toContain('card_neutral');
      expect(card.textContent).toContain('sem PE remoto');
    }
    const topology = container.querySelector('[aria-label="Cadeia do circuito"]')!;
    expect(topology.textContent).toContain('PE remoto não identificado');
    expect(topology.textContent).toContain('AC não comprovada');
    expect(container.textContent).toContain('nenhum probe executado');
  });
});

describe('Evidence drawer e segredos', () => {
  it('abre a evidencia com as abas Resumo/Comando/Saida bruta/JSON bruto e escapa a saida', async () => {
    await render({
      ...base,
      evidence: [{ ...base.evidence[0]!, output: '<script>alert(1)</script>' }],
    });
    await act(async () => summaryOf('Evidências e comandos')!.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[class*="evidenceItem"]')!.click(),
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    const tabs = [...dialog.querySelectorAll('nav button')].map((b) => b.textContent);
    expect(tabs).toEqual(['Resumo', 'Comando', 'Saída bruta', 'JSON bruto']);
    const tab = (label: string) =>
      [...dialog.querySelectorAll('nav button')].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
    await act(async () => tab('Comando').click());
    expect(dialog.querySelector('pre')!.textContent).toBe('screen-length 0 temporary');
    await act(async () => tab('Saída bruta').click());
    expect(container.querySelector('script')).toBeNull();
    expect(dialog.querySelector('pre')!.textContent).toBe('<script>alert(1)</script>');
    await act(async () =>
      dialog.querySelector<HTMLButtonElement>('[aria-label="Fechar"]')!.click(),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('nenhuma aba nem o contexto expoem campos sensiveis, mesmo se vierem no payload', async () => {
    const tainted = {
      ...base,
      evidence: [
        {
          ...base.evidence[0]!,
          password: 'SEGREDO-1',
          encryptedPayload: 'SEGREDO-2',
          privateKey: 'SEGREDO-3',
          token: 'SEGREDO-4',
          secret: 'SEGREDO-5',
        },
      ],
      executionContext: {
        endpoints: [
          { ...access(VSI_1809_IDS.LOCAL, 'IIE-VSR-6730-MPLS-01'), password: 'SEGREDO-6' },
          access(VSI_1809_IDS.REMOTE, 'RNS-FLOR-6730-MPLS-01'),
        ],
      },
    } as unknown as VsiDiagnosticResult;
    await render(tainted);
    await act(async () => summaryOf('Evidências e comandos')!.click());
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[class*="evidenceItem"]')!.click(),
    );
    const dialog = container.querySelector('[role="dialog"]')!;
    const seen: string[] = [container.textContent ?? ''];
    for (const label of ['Resumo', 'Comando', 'Saída bruta', 'JSON bruto']) {
      const button = [...dialog.querySelectorAll('nav button')].find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;
      await act(async () => button.click());
      seen.push(dialog.textContent ?? '');
    }
    const all = seen.join('\n');
    expect(all).not.toMatch(/SEGREDO-\d/);
    expect(all.toLowerCase()).not.toMatch(
      /password|encryptedpayload|privatekey|private key|"token"|"secret"/,
    );
  });
});
