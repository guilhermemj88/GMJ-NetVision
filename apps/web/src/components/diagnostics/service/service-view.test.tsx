// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VSI_CLAUSE_CODES,
  adaptLegacyVsiDiagnostic,
  composeVsiServiceDiagnosis,
  vsiFindingKind,
  type VsiObserved,
  type VsiServiceComposeInput,
  type VsiServiceDiagnosis,
} from '@gmj/shared';
import { vsi1809Result } from '../result/vsi-1809.fixture';
import engineReplayJson from './fixtures/engine-replay-3072.json';
import engineReplayVtaJson from './fixtures/engine-replay-3072-vta-mcp.json';
import { vsi3066Fixture, vsi3072Fixture, vsi3072Input } from './fixtures/vsi-fixtures';
import { VsiServiceDiagnosisView } from './service-view';
import { CLAUSE_TEMPLATES, renderClause } from './view-model';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(diagnosis: VsiServiceDiagnosis, now: string = diagnosis.completedAt): Promise<string> {
  await act(async () => root.render(<VsiServiceDiagnosisView diagnosis={diagnosis} now={now} />));
  return container.textContent ?? '';
}
const q = (selector: string): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(selector)];
const one = (selector: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nao encontrado: ${selector}`);
  return el;
};
const cell = (layer: string, host: string): HTMLElement => one(`[role="table"] [data-layer="${layer}"][data-endpoint="${host}"]`);
const axis = (name: string): string | null => one(`[data-axis="${name}"]`).getAttribute('data-axis-state');
const group = (kind: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-kind="${kind}"]`);
const GREEN = '[data-tone="ok"], [data-tone="active"]';

const S6750 = 'BHE-VTA-S6750-MPLS-01';
const LIKEE = 'BHE-LIKEE-6730-MPLS-01';
const VTA = 'BHE-VTA-6730-MPLS-01';
const MQT = 'BHE-MQT-6730-MPLS-01';

/** Cenario SINTETICO (so para teste): LIKEE lido ao vivo e operacional; VTA-01 com caminho em falha inesperada. */
function syntheticPathDown(): VsiServiceDiagnosis {
  const input: VsiServiceComposeInput = structuredClone(vsi3072Input);
  const at = input.completedAt;
  input.readings.push({ id: 'r-syn', kind: 'SSH_SESSION', hostId: 'demo-likee', hostName: LIKEE, startedAt: at, inThisRun: true, outcome: 'OK', scope: 'sintético' });
  input.evidence.push({ id: 'e-syn', readingId: 'r-syn', hostId: null, hostName: LIKEE, source: 'LIVE_SSH', command: 'display vsi name X verbose', collectedAt: at, observedAt: at, complete: true, bytes: 0, sha256: null, output: '(sintético)' });
  const live = <T,>(value: T): VsiObserved<T> => ({ value, basis: 'LIVE_SSH', readingId: 'r-syn', evidenceId: 'e-syn', observedAt: at, freshness: null });
  const likee = input.endpoints[0]!;
  likee.collection = 'READ';
  likee.vsi = live({ state: 'UP', signaling: 'bgp', encapsulation: 'vlan', mtu: 2000, rd: null });
  likee.acs[0]!.state = live('UP');
  likee.pws[0]!.state = live('UP');
  const vta = input.endpoints[1]!;
  vta.accessRole = 'DOWN_UNEXPECTED';
  vta.ethTrunks[0]!.role = 'DOWN_UNEXPECTED';
  input.findings = input.findings.filter((f) => f.code !== 'STANDBY_PATH_IDLE');
  input.nextSteps = input.nextSteps.map((s) => ({ ...s, reasonFindingIds: s.reasonFindingIds.filter((id) => id !== 'agg-not-read-demo-likee') }));
  return composeVsiServiceDiagnosis(input);
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

describe('aceitacao — VSI 3066-BGP-FLASHTELECOM (leitura antiga)', () => {
  it('1. veredito SEM LEITURA ATUAL; nenhuma celula verde; VSI/AC/PW mostram UP EM 09/11 com origem SSH e data', async () => {
    const text = await render(vsi3066Fixture);
    expect(one('[data-verdict]').getAttribute('data-verdict')).toBe('NO_CURRENT_READING');
    expect(text).toContain('SEM LEITURA ATUAL');
    expect(q(`[role="table"] :is(${GREEN})`)).toHaveLength(0);
    for (const layer of ['vsi', 'ac', 'pw']) {
      const c = cell(layer, S6750);
      expect(c.textContent).toContain('UP EM 09/11');
      expect(c.querySelector('[data-origin="ssh"]')!.textContent).toContain('SSH 09/11 14:46Z');
    }
    expect(axis('service')).toBe('STALE');
    expect(axis('redundancy')).toBe('NOT_READ');
  });

  it('2. MAC no Eth-Trunk6 e INCONCLUSIVO, nunca falha, e aponta para as 3 evidencias', async () => {
    await render(vsi3066Fixture);
    expect(group('FAILURE')).toBeNull();
    const finding = one('[data-kind="INCONCLUSIVE"] [data-finding-code="MAC_ORIGIN_UNRESOLVED"]');
    expect(finding.textContent).toContain('Eth-Trunk6');
    expect([...finding.querySelectorAll('[data-evidence-id]')].map((b) => b.getAttribute('data-evidence-id'))).toEqual(['e-mac3066', 'e-vlan3066', 'e-trunk6']);
    expect(axis('mac')).toBe('NOT_CONFIRMED');
  });

  it('as duas leituras de 09/11 aparecem separadas e marcadas como anteriores', async () => {
    await render(vsi3066Fixture);
    const readings = q('[data-reading-id]');
    expect(readings).toHaveLength(2);
    expect(readings.map((r) => r.getAttribute('data-in-this-run'))).toEqual(['false', 'false']);
    expect(readings[0]!.textContent).toContain('09/11 14:46Z');
    expect(readings[1]!.textContent).toContain('09/11 21:16Z');
  });
});

describe('aceitacao — VSI 3072-QinQ-CDB-MANTIQUEIRA (E-Trunk comprovado, servico nao lido)', () => {
  it('3. veredito INCONCLUSIVO; redundancia COMPROVADA; servico NAO CONFIRMADO', async () => {
    const text = await render(vsi3072Fixture);
    expect(one('[data-verdict]').getAttribute('data-verdict')).toBe('INCONCLUSIVE');
    expect(axis('redundancy')).toBe('PROVEN_OK');
    expect(axis('service')).toBe('NOT_CONFIRMED');
    expect(axis('mac')).toBe('NOT_READ');
    expect(text).toContain('E-Trunk Master ou LACP ativo não comprovam que a VSI encaminha');
  });

  it('4. LIKEE mostra MASTER e SERVICO NAO CONFIRMADO ao mesmo tempo; nenhuma celula de VSI/AC/PW verde', async () => {
    await render(vsi3072Fixture);
    const head = one(`[role="columnheader"][data-endpoint="${LIKEE}"]`);
    expect(head.textContent).toContain('ACESSO ATIVO');
    expect(head.textContent).toContain('SERVIÇO NÃO CONFIRMADO');
    expect(cell('etrunk', LIKEE).textContent).toContain('MASTER');
    for (const host of [LIKEE, VTA, MQT])
      for (const layer of ['vsi', 'ac', 'pw']) {
        expect(cell(layer, host).querySelectorAll(GREEN)).toHaveLength(0);
        expect(cell(layer, host).textContent).toMatch(/NÃO CONFIRMADO|OBSOLETO/);
      }
  });

  it('5. Backup do VTA-01 nao gera falha nem conta em pendencias', async () => {
    const text = await render(vsi3072Fixture);
    expect(group('FAILURE')).toBeNull();
    expect(one('[data-kind="STANDBY_EXPECTED"] [data-finding-code="STANDBY_PATH_IDLE"]').textContent).toContain('Eth-Trunk26');
    const pending = vsi3072Fixture.findings.filter((f) => f.kind !== 'STANDBY_EXPECTED' && f.kind !== 'INFO').length;
    expect(text).toContain(`${pending} pendência(s)`);
    expect(one(`[role="columnheader"][data-endpoint="${VTA}"]`).textContent).toContain('ACESSO EM STANDBY ESPERADO');
    expect(cell('etrunk', VTA).querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('standby');
  });

  it('6. os 3 PEs aparecem; o MQT, nao lido, tem coluna propria e no na topologia', async () => {
    await render(vsi3072Fixture);
    expect(q('[role="columnheader"]').map((h) => h.getAttribute('data-endpoint'))).toEqual([LIKEE, VTA, MQT]);
    expect(one(`[role="columnheader"][data-endpoint="${MQT}"]`).textContent).toContain('NÃO LIDO');
    expect(q('svg [data-node]').map((n) => n.getAttribute('data-node'))).toEqual([LIKEE, VTA, MQT]);
  });

  it('7. PW de 27/10 aparece como OBSOLETO, nao como UP', async () => {
    await render(vsi3072Fixture);
    const pw = cell('pw', VTA);
    expect(pw.textContent).toContain('OBSOLETO');
    expect(pw.querySelector('[data-tone]')!.getAttribute('data-tone')).toBe('stale');
    expect(pw.querySelector('[data-origin="snmp"]')!.textContent).toContain('27/10');
    expect(pw.textContent).not.toMatch(/\bUP\b/);
  });

  it('8. configuracao truncada do Eth-Trunk26 fica em Falha de coleta, fora de Falha comprovada', async () => {
    await render(vsi3072Fixture);
    const collect = one('[data-kind="COLLECTION"]');
    expect(collect.textContent).toContain('não é falha do serviço');
    expect(collect.querySelector('[data-finding-code="COLLECTION_OUTPUT_INCOMPLETE"]')!.textContent).toContain('Eth-Trunk26');
    expect(one('[data-evidence-id="e-cfg26"] [data-origin="fail"]').textContent).toBe('incompleta');
  });

  it('capturas manuais sem horario aparecem como envelhecidas e sem hora inventada', async () => {
    await render(vsi3072Fixture);
    const origin = cell('etrunk', VTA).querySelector('[data-origin="ssh"]')!.textContent!;
    expect(origin).toContain('16/11 (hora não informada)');
    expect(origin).toContain('envelhecida');
  });
});

describe('aceitacao — regras gerais', () => {
  it('9. caminho em falha inesperada continua CRITICO mesmo com outro caminho ativo e comprovado', async () => {
    const d = syntheticPathDown();
    expect(d.verdict.status).toBe('FAILED');
    expect(d.verdict.clauses.map((c) => c.code)).toContain('FAILED_OTHER_PATH_ACTIVE');
    expect(d.findings.find((f) => f.code === 'PATH_DOWN_UNEXPECTED')).toMatchObject({ kind: 'FAILURE', severity: 'CRITICAL', hostName: VTA });
    expect(d.endpoints[0]!.serviceState).toBe('PROVEN_OK');
    const text = await render(d);
    expect(text).toContain('FALHA COMPROVADA');
    expect(text).toContain('isso não reduz a severidade da falha');
    expect(one('[data-kind="FAILURE"]').textContent).toContain(VTA);
    expect(axis('redundancy')).toBe('ISSUE');
    expect(one('svg [data-access-kind="crit"]')).toBeTruthy();
  });

  it('10. estado nunca depende so de cor: todo selo e toda celula tem icone e palavra', async () => {
    for (const d of [vsi3066Fixture, vsi3072Fixture, syntheticPathDown()]) {
      await render(d);
      const toned = q('[data-tone]');
      expect(toned.length).toBeGreaterThan(10);
      for (const el of toned) {
        expect(el.querySelector('svg')).not.toBeNull();
        expect((el.textContent ?? '').trim().length).toBeGreaterThan(1);
      }
      for (const el of q('[data-axis]')) expect(el.querySelector('svg')).not.toBeNull();
    }
  });

  it('11. todo valor da matriz tem selo de origem; o link abre o painel da evidencia certa', async () => {
    await render(vsi3072Fixture);
    const entries = q('[role="table"] [data-layer]:not([data-layer="missing"]) [data-tone]');
    expect(entries.length).toBeGreaterThanOrEqual(18);
    for (const entry of entries) expect(entry.querySelector('[data-origin]')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => cell('etrunk', LIKEE).querySelector<HTMLButtonElement>('[data-evidence-id="e-brief-likee"]')!.click());
    const dialog = one('[role="dialog"]');
    expect(dialog.textContent).toContain(LIKEE);
    expect(dialog.textContent).toContain('display e-trunk brief');
    expect([...dialog.querySelectorAll('[data-used="true"]')].map((l) => l.textContent)).toEqual([expect.stringMatching(/^4\s+Master\s+10\.100\.101\.0/)]);
  });

  it('12. o CSS empilha a matriz por PE abaixo de 900 px e nunca fixa largura maior que a tela', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/diagnostics/service/service-view.module.css'), 'utf8');
    const narrow = css.split('@media (max-width: 900px)').find((block) => block.includes('.mxCorner,')) ?? '';
    expect(narrow).toMatch(/\.mx \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(narrow).toMatch(/order: var\(--o\)/);
    expect(css).toMatch(/\.topo \{\s*overflow-x: auto;/);
    expect(css).toMatch(/\.mxScroll \{\s*overflow-x: auto;/);
  });

  it('13. resultado do motor LEGADO mostra o motor e a redundancia como nao avaliada', async () => {
    const d = adaptLegacyVsiDiagnostic(vsi1809Result);
    const text = await render(d);
    expect(one('article').getAttribute('data-engine')).toBe('LEGACY');
    expect(one('[data-testid="engine"]').textContent).toContain('Legado');
    expect(axis('redundancy')).toBe('NOT_APPLICABLE');
    expect(text).toContain('O motor legado não avalia redundância');
    expect(text).toContain(vsi1809Result.summary);
    expect(q('[role="columnheader"]')).toHaveLength(1 + vsi1809Result.remotes.length);
    expect(text).toContain(vsi1809Result.diagnosticId);
    // o veredito do legado e as celulas nao se contradizem: o que o legado leu aparece como lido
    expect(one('[data-verdict]').getAttribute('data-verdict')).toBe('OK');
    expect(cell('vsi', vsi1809Result.local.name).textContent).toContain('UP');
    expect(cell('mac', vsi1809Result.local.name).textContent).toContain('NÃO AVALIADO');
    expect(one('[data-testid="origin"]').textContent).toBe('job do motor legado');
  });

  it('legado: aprovacao das verificacoes nao vira "componente confirmado"', async () => {
    const d = adaptLegacyVsiDiagnostic(vsi1809Result);
    const text = await render(d);
    // eixo e selo dizem o que o legado entrega: verificacoes aprovadas, nao estado lido de cada componente
    expect(axis('service')).toBe('ENGINE_APPROVED');
    expect(one('[data-axis="service"]').textContent).toContain('APROVADO PELAS VERIFICAÇÕES DO LEGADO');
    expect(text).not.toContain('SERVIÇO COMPROVADO');
    const head = one(`[role="columnheader"][data-endpoint="${vsi1809Result.local.name}"]`);
    expect(head.textContent).toContain('VERIFICAÇÕES DO LEGADO APROVADAS');
    // o AC aparece como verificacao do motor, com o texto do proprio legado, e nao como UP lido
    const ac = cell('ac', vsi1809Result.local.name);
    expect(ac.textContent).toContain('VERIFICAÇÃO DO LEGADO');
    expect(ac.textContent).toContain('estado do componente não devolvido como dado estruturado');
    // o rotulo de estado nunca e "UP": o texto do legado aparece citado, como verificacao
    for (const entry of ac.querySelectorAll('[data-tone]')) expect(entry.textContent).toMatch(/^APROVADO · VERIFICAÇÃO DO LEGADO/);
    for (const e of d.endpoints) {
      expect(e.acs).toEqual([]);
      expect(e.serviceState).toBe('ENGINE_APPROVED');
    }
  });

  it('legado: ping, perda, RTT e traceroute sao preservados como o motor mediu', async () => {
    const d = adaptLegacyVsiDiagnostic(vsi1809Result);
    expect(d.connectivity.evaluated).toBe(true);
    expect(d.connectivity.probes).toHaveLength(vsi1809Result.probes.length);
    expect(d.connectivity.underlayClassification).toBe(vsi1809Result.underlayClassification);
    const text = await render(d);
    const probes = q('[data-probe-status]');
    expect(probes).toHaveLength(vsi1809Result.probes.length);
    const first = vsi1809Result.probes[0]!;
    expect(probes[0]!.textContent).toContain(`${first.source} → ${first.destination}`);
    expect(probes[0]!.textContent).toContain(`perda ${first.lossPercent}%`);
    if (first.rttMs) expect(probes[0]!.textContent).toContain(`${first.rttMs.min}/${first.rttMs.avg}/${first.rttMs.max} ms`);
    expect(text).toContain(vsi1809Result.underlayClassification!);
  });

  it('motor novo: conectividade aparece como NAO AVALIADA, nunca como sem perda', async () => {
    const text = await render(vsi3072Fixture);
    expect(one('[data-connectivity-evaluated]').getAttribute('data-connectivity-evaluated')).toBe('false');
    expect(text).toContain('Isso não significa ausência de perda');
    expect(q('[data-probe-status]')).toHaveLength(0);
  });

  it('achado repetido em varios PEs vira um grupo, com cada PE e sua evidencia preservados', async () => {
    await render(vsi3072Fixture);
    const groupEl = one('[data-finding-group="ENDPOINT_SERVICE_NOT_READ"]');
    expect(groupEl.getAttribute('data-group-size')).toBe('3');
    expect(groupEl.querySelector('summary')!.textContent).toContain('· 3 PEs');
    const inner = [...groupEl.querySelectorAll('[data-finding-code="ENDPOINT_SERVICE_NOT_READ"]')];
    expect(inner).toHaveLength(3);
    expect(inner.map((f) => f.querySelector('summary')!.textContent)).toEqual([
      expect.stringContaining(LIKEE),
      expect.stringContaining(VTA),
      expect.stringContaining(MQT),
    ]);
    expect(inner[0]!.querySelector('[data-evidence-id]')!.getAttribute('data-evidence-id')).toBe('e-snmp-likee');
    expect(inner[1]!.querySelector('[data-evidence-id]')!.getAttribute('data-evidence-id')).toBe('e-snmp-vta');
    // achados de codigo unico continuam soltos
    expect(container.querySelector('[data-finding-group="MAC_ORIGIN_UNRESOLVED"]')).toBeNull();
  });

  it('14. clausula sem modelo de frase e codigo sem categoria sao erros', () => {
    expect(Object.keys(CLAUSE_TEMPLATES).sort()).toEqual([...VSI_CLAUSE_CODES].sort());
    expect(() => renderClause({ code: 'CLAUSULA_INEXISTENTE', params: {} })).toThrow(/sem modelo de frase/);
    expect(() => vsiFindingKind('CODIGO_INEXISTENTE', 'CRITICAL')).toThrow(/sem categoria/);
    for (const d of [vsi3066Fixture, vsi3072Fixture, syntheticPathDown(), adaptLegacyVsiDiagnostic(vsi1809Result)])
      for (const c of [...d.verdict.clauses, ...Object.values(d.axes).map((a) => a.clause)]) expect(renderClause(c).length).toBeGreaterThan(5);
  });
});

/** Resposta do motor VSI/MCP + agregador (golden gerado em apps/api a partir das capturas reais; sem SSH). */
const engineReplay = engineReplayJson as unknown as VsiServiceDiagnosis;

describe('interface consumindo a resposta estruturada do motor (replay 3072)', () => {
  it('renderiza a resposta do motor sem adaptacao: motor, origem, execucao e os 3 PEs', async () => {
    const text = await render(engineReplay);
    expect(one('article').getAttribute('data-engine')).toBe('VSI_MCP');
    expect(one('article').getAttribute('data-run-id')).toBe(engineReplay.runId);
    expect(one('[data-testid="origin"]').textContent).toContain('replay');
    expect(one('[role="note"]').textContent).toContain('Nenhum SSH foi aberto');
    expect(q('[role="columnheader"]').map((h) => h.getAttribute('data-endpoint'))).toEqual([LIKEE, VTA, MQT]);
    expect(text).toContain('admin · ADMIN');
  });

  it('MASTER lido pelo motor aparece na matriz e o servico continua NAO CONFIRMADO', async () => {
    const text = await render(engineReplay);
    expect(one('[data-verdict]').getAttribute('data-verdict')).toBe('INCONCLUSIVE');
    expect(cell('etrunk', LIKEE).textContent).toContain('MASTER');
    expect(cell('etrunk', VTA).textContent).toContain('BACKUP');
    expect(cell('etrunk', VTA).querySelector('[data-origin="ssh"]')).not.toBeNull();
    expect(axis('service')).toBe('NOT_CONFIRMED');
    expect(axis('redundancy')).toBe('NOT_CONFIRMED');
    expect(text).toContain('o papel ativo/standby não foi atribuído');
    for (const host of [LIKEE, VTA, MQT]) expect(cell('vsi', host).querySelectorAll(GREEN)).toHaveLength(0);
    expect(group('FAILURE')).toBeNull();
  });

  it('saida nao obtida aparece como FALHA DE COLETA na celula e no grupo de coleta, nunca como VSI down', async () => {
    await render(engineReplay);
    expect(cell('vsi', LIKEE).textContent).toContain('FALHA DE COLETA');
    expect(cell('vsi', LIKEE).querySelector('[data-origin]')!.getAttribute('data-origin')).toBe('fail');
    expect(cell('vsi', LIKEE).textContent).toContain('inventário: up');
    expect(cell('vsi', LIKEE).querySelectorAll('[data-tone="crit"]')).toHaveLength(0);
    expect(cell('vsi', VTA).querySelectorAll('[data-tone="crit"]')).toHaveLength(0);
    const collect = one('[data-kind="COLLECTION"]');
    const grouped = collect.querySelector('[data-finding-group="COLLECTION_OUTPUT_INCOMPLETE"]')!;
    expect(grouped.querySelector('summary')!.textContent).toMatch(/ocorrências em 2 PEs/);
    expect(grouped.querySelectorAll('[data-finding-code="COLLECTION_OUTPUT_INCOMPLETE"]').length).toBe(Number(grouped.getAttribute('data-group-size')));
    expect(cell('vsi', MQT).textContent).toContain('NÃO CONFIRMADO');
  });

  it('PW antigo do inventario aparece OBSOLETO e a evidencia do motor abre com comando e sha256', async () => {
    await render(engineReplay);
    expect(cell('pw', VTA).textContent).toContain('OBSOLETO');
    const link = cell('etrunk', VTA).querySelector<HTMLButtonElement>('[data-evidence-id]')!;
    const id = link.getAttribute('data-evidence-id')!;
    await act(async () => link.click());
    const dialog = one('[role="dialog"]');
    expect(dialog.textContent).toContain('display e-trunk 4');
    const evidence = engineReplay.evidence.find((e) => e.id === id)!;
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(engineReplay)).not.toMatch(/password|passwd|secret/i);
  });
});

describe('coleta, evidencia e estado do servico sao tres respostas separadas', () => {
  const vtaReal = engineReplayVtaJson as unknown as VsiServiceDiagnosis;
  const status = (key: string, host: string): HTMLElement => one(`[role="table"] [data-status="${key}"][data-endpoint="${host}"]`);

  it('Backup lido por inteiro: coleta COMPLETA, evidencia SUFICIENTE, VSI DOWN ESPERADO — e nenhuma nova leitura pedida', async () => {
    const text = await render(vtaReal);
    expect(status('collection', VTA).textContent).toContain('COLETA COMPLETA');
    expect(status('collection', VTA).textContent).toContain('6 de 6 comando(s) com saída completa') // o replay nao grava o display version;
    expect(status('evidence', VTA).textContent).toContain('EVIDÊNCIA SUFICIENTE');
    expect(status('evidence', VTA).textContent).toContain('Nenhuma nova leitura é necessária aqui');
    expect(status('service', VTA).textContent).toContain('VSI DOWN ESPERADO (BACKUP)');
    expect(status('service', VTA).textContent).toContain('não é pendência de leitura');
    for (const key of ['collection', 'evidence', 'service']) expect(status(key, VTA).textContent).not.toMatch(/Falta ler|parcial/i);
    // nenhum proximo passo aponta para o PE ja lido; a sessao nao aparece como parcial
    const stepHosts = q('[data-step-host]').map((el) => el.getAttribute('data-step-host'));
    expect(stepHosts).toContain(LIKEE);
    expect(stepHosts).not.toContain(VTA);
    expect(text).not.toContain('· parcial');
    // e mesmo assim o servico nao e declarado saudavel
    expect(one('[data-verdict]').getAttribute('data-verdict')).toBe('INCONCLUSIVE');
  });

  it('PE nao lido: sem coleta, sem evidencia, e ai sim a leitura e pedida', async () => {
    await render(vtaReal);
    expect(status('collection', LIKEE).textContent).toContain('NÃO LIDO NESTA EXECUÇÃO');
    expect(status('evidence', LIKEE).textContent).toContain('SEM EVIDÊNCIA AO VIVO');
    expect(status('evidence', LIKEE).textContent).toContain('Falta ler: toda a leitura ao vivo desta ponta');
    expect(status('service', LIKEE).textContent).toContain('NÃO LIDO');
  });

  it('coleta parcial e evidencia insuficiente continuam visiveis quando sao verdade (replay sem display vsi)', async () => {
    await render(engineReplay);
    expect(status('collection', LIKEE).textContent).toContain('COLETA PARCIAL');
    expect(status('evidence', LIKEE).textContent).toContain('EVIDÊNCIA INSUFICIENTE');
    expect(status('evidence', LIKEE).textContent).toContain('Falta ler: display vsi name');
    expect(status('service', LIKEE).textContent).toContain('SERVIÇO NÃO CONFIRMADO');
    for (const el of q('[data-status-tone]')) expect(el.querySelector('svg')).not.toBeNull();
  });
});

describe('resultado guardado aberto depois', () => {
  it('aberto na hora nao tem aviso; depois de 15 min e ENVELHECIDO; depois de 24 h e ANTIGO', async () => {
    const at = (ms: number) => new Date(Date.parse(engineReplay.completedAt) + ms).toISOString();
    await render(engineReplay, at(10 * 60_000));
    expect(container.querySelector('[data-result-age]')).toBeNull();
    await render(engineReplay, at(16 * 60_000));
    expect(one('[data-result-age]').getAttribute('data-result-age')).toBe('AGED');
    const text = await render(engineReplay, at(3 * 24 * 3_600_000));
    expect(one('[data-result-age]').getAttribute('data-result-age')).toBe('STALE');
    expect(text).toContain('RESULTADO ANTIGO · montado há 3 dias');
    expect(text).toContain('não o estado atual');
  });
});

describe('rastreabilidade e proveniencia', () => {
  it('o cabecalho traz motor, execucao e o aviso de fixture; nenhum PE descoberto e omitido', async () => {
    const text = await render(vsi3072Fixture);
    expect(one('article').getAttribute('data-run-id')).toBe('fixture-vsi-3072');
    expect(one('[role="note"]').textContent).toContain('NÃO É ESTADO ATUAL DA REDE');
    expect(text).toContain('VSI/MCP · fixture');
    expect(vsi3072Fixture.endpoints).toHaveLength(3);
  });

  it('cada passo aponta a evidencia que o motivou e o achado leva ao passo', async () => {
    await render(vsi3072Fixture);
    expect(one('[data-step-id="s3072-cfg26"] [data-evidence-id]').getAttribute('data-evidence-id')).toBe('e-cfg26');
    expect(one('[data-finding-code="COLLECTION_OUTPUT_INCOMPLETE"]').textContent).toContain('Passo 3');
    expect(one('[data-step-id="s3066-none"], [data-step-id="s3072-vsi-likee"]').textContent).toContain('display vsi name 3072-QinQ-CDB-MANTIQUEIRA verbose');
  });

  it('comando ainda nao homologado e sinalizado no passo', async () => {
    await render(vsi3066Fixture);
    expect(one('[data-step-id="s3066-lsp"]').textContent).toContain('comando não homologado');
    expect(one('[data-step-id="s3066-recollect"]').textContent).not.toContain('não homologado');
  });
});
