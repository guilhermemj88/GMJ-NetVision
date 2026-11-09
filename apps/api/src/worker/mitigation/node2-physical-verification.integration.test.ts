import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import type { PhysicalSimMode } from '../../testing/physical-bgp-simulator';
import { buildMitigationWebhookPayload } from '../../infrastructure/bgp/mitigation/mitigation-webhook';
import { decodeNotification, type OutboxEntry } from './durable-mitigation-outbox';

/**
 * Fluxo completo (FAST/AUTO -> servico de comandos -> executor Huawei real -> parsers) do node 2
 * estreito com a VERIFICACAO FISICA pos-escrita. Somente a borda SSH e falsa; as saidas BGP base
 * sao a captura real sanitizada do equipamento (ver physical-bgp-simulator).
 */

async function activate(mode: PhysicalSimMode = 'ok', delay = 0) {
  const h = await createPilotHarness();
  h.ssh.physical.mode = mode;
  h.ssh.physical.propagationDelayAttempts = delay;
  for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
    h.sample(rate);
    await h.lifecycle.tickPilot();
  }
  return h;
}

const rows = async (h: Awaited<ReturnType<typeof activate>>) =>
  h.store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
const events = async (h: Awaited<ReturnType<typeof activate>>) =>
  (await rows(h)).map((row) => row.event);

/** Executa o normalizador do workflow n8n RC7.1.2 (o MESMO JSON do repositorio) com o payload. */
function runWorkflowNormalizer(body: Record<string, unknown>): Record<string, unknown> {
  const workflow = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { nodes: Array<{ name: string; parameters: Record<string, unknown> }> };
  let expression = String(
    workflow.nodes.find((node) => node.name === 'Normalizar Evento OUT')!.parameters['jsonOutput'],
  ).trim();
  if (expression.startsWith('=')) expression = expression.slice(1);
  expression = expression.trim();
  if (expression.startsWith('{{')) expression = expression.slice(2);
  if (expression.endsWith('}}')) expression = expression.slice(0, -2);
  return (
    new Function('$json', `return (${expression});`) as (i: unknown) => Record<string, unknown>
  )({ body });
}

describe('node 2 estreito + verificacao fisica (AUTO, executor real)', () => {
  it('PASS: escreve o node 2 estreito UMA vez, prova o efeito e so entao emite MITIGATION_VERIFIED', async () => {
    const h = await activate();
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.writes[0]).toEqual([
      'system-view',
      'route-policy PL-AGLINK_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-AGLINK_IPv4-IN permit node 2',
      ' if-match ip-prefix AGLINK-BLOCO-TODO-23',
      ' apply local-preference 1100',
      ' apply extcommunity rt 268568:660',
      'commit',
    ]);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(await events(h)).toEqual(['MITIGATION_VERIFIED']);
    expect((await h.repository.getRuntime(h.target.profileId))?.state).toBe('MITIGATED');
    // Evidencia: leu o peer do cliente ANTES e o resultado fisico DEPOIS da escrita.
    const flat = h.ssh.physical.batches.flat();
    expect(flat).toContain('display bgp peer 10.200.201.2 verbose');
    expect(flat).toContain('display bgp routing-table 167.250.126.0 23');
    expect(flat).toContain('display bgp routing-table peer 198.19.4.145 advertised-routes');
  });

  it('propagacao tardia (ainda nao ocorrida nas primeiras tentativas) e observada e passa', async () => {
    const h = await activate('ok', 1);
    expect(await events(h)).toEqual(['MITIGATION_VERIFIED']);
    expect((await h.scope())?.phase).toBe('ACTIVE');
  });

  it.each([
    ['wrong-lp', 'FAIL'],
    ['rt140', 'FAIL'],
    ['not-best', 'FAIL'],
    ['peer-down', 'FAIL'],
    ['count-changed', 'FAIL'],
    ['flap', 'FAIL'],
    ['not-advertised', 'INCONCLUSIVE'],
    ['already-advertised', 'INCONCLUSIVE'],
    ['unreadable', 'INCONCLUSIVE'],
    ['garbled-routing', 'INCONCLUSIVE'],
    ['ambiguous-peer', 'INCONCLUSIVE'],
    ['no-mitigation-peer', 'INCONCLUSIVE'],
  ] as const)(
    '%s => %s: NUNCA sucesso; MITIGATION_FAILED/UNVERIFIED_PHYSICAL; ownership incerto; SEM rollback',
    async (mode, expected) => {
      const h = await activate(mode);
      // Uma unica escrita: nenhum `undo` automatico.
      expect(h.ssh.writes).toHaveLength(1);
      expect(h.ssh.writes.flat().some((line) => line.startsWith('undo '))).toBe(false);
      expect(h.ssh.active).toBe(true);
      // Nenhum tipo de evento novo: o n8n so entrega MITIGATION_FAILED.
      expect(await events(h)).toEqual(['MITIGATION_FAILED']);
      const payload = (await rows(h))[0]!.payload as Record<string, unknown>;
      expect(payload['failureKind']).toBe('UNVERIFIED_PHYSICAL');
      expect(payload['verified']).toBe(false);
      expect(expected === 'FAIL' || expected === 'INCONCLUSIVE').toBe(true);
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      expect((await h.scope())?.reason).toBe('ACTIVATED_UNVERIFIED_PHYSICAL');
      expect((await h.repository.getRuntime(h.target.profileId))?.state).toBe(
        'RECONCILIATION_REQUIRED',
      );
    },
  );

  it('o payload UNVERIFIED_PHYSICAL passa no schema do workflow n8n RC7.1.2 e e roteado como STATUS', async () => {
    const h = await activate('wrong-lp');
    const row = (await rows(h))[0]!;
    const body = buildMitigationWebhookPayload(
      decodeNotification(row.payload),
    ) as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'MITIGATION_FAILED',
      simulation: false,
      verified: false,
      failureKind: 'UNVERIFIED_PHYSICAL',
    });
    expect(String(body['failureMessage'])).toBe(
      'escrita aplicada; verificacao fisica nao comprovada; retirada so por CLI + reconciliacao',
    );
    const normalized = runWorkflowNormalizer(body);
    expect(normalized['MOTIVO']).toBeUndefined();
    expect(normalized).toMatchObject({
      RC712_VALID: true,
      RC712_ROUTE: 'STATUS',
      MITIGATION_STATUS: true,
    });
    expect(String(normalized['statusText'])).toContain('FALHA / ESTADO INCERTO');
    // O tipo antigo inventado NAO e entregue pelo workflow (UNKNOWN_EVENT): prova da escolha.
    const legacy = runWorkflowNormalizer({ ...body, event: 'MITIGATION_UNVERIFIED_PHYSICAL' });
    expect(legacy['RC712_VALID']).toBe(false);
    expect(legacy['MOTIVO']).toBe('UNKNOWN_EVENT');
  });

  it('apos UNVERIFIED o escopo fica em quarentena (UNCERTAIN): nenhuma escrita nova ate a reconciliacao', async () => {
    // Mesmo comportamento de qualquer ativacao nao comprovada: nada e desfeito sozinho e nada novo
    // e escrito pela API enquanto o ownership e incerto (a reconciliacao e do operador).
    const h = await activate('wrong-lp');
    const removed = await h.commands.execute({
      requestId: 'human-remove-after-unverified',
      action: 'REMOVE',
      profileId: h.target.profileId,
      origin: 'MANUAL',
    });
    expect(removed.ok).toBe(false);
    expect(removed.status).toBe('MANUAL_RECONCILIATION_REQUIRED');
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.active).toBe(true);
  });

  it('commit OK com read-back divergente: MITIGATION_FAILED, sem verificacao fisica e sem rollback', async () => {
    const h = await createPilotHarness();
    h.ssh.partial = true;
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    expect(h.ssh.writes).toHaveLength(1);
    expect(await events(h)).toEqual(['MITIGATION_FAILED']);
    // A verificacao fisica so roda DEPOIS de um read-back de texto conferido.
    expect(h.ssh.physical.batches.flat().filter((c) => /routing-table 167/.test(c))).toEqual([]);
  });

  it('erro de sessao depois do commit: MITIGATION_FAILED, estado incerto, nenhuma leitura fisica', async () => {
    const h = await createPilotHarness();
    h.ssh.timeout = true;
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    expect(h.ssh.writes).toHaveLength(1);
    expect(await events(h)).not.toContain('MITIGATION_VERIFIED');
    expect(h.ssh.physical.batches.flat().filter((c) => /routing-table 167/.test(c))).toEqual([]);
  });

  it('baseline fora do contrato (node permanente com RT 660): preflight bloqueia, ZERO escrita', async () => {
    const h = await createPilotHarness();
    const config = h.ssh.config.bind(h.ssh);
    h.ssh.config = () =>
      config().replace(
        'apply extcommunity rt 268568:140 additive',
        'apply extcommunity rt 268568:660',
      );
    for (const rate of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(rate);
      await h.lifecycle.tickPilot();
    }
    expect(h.ssh.writes).toHaveLength(0);
  });
});

describe('caminho MANUAL (comando via API) usa o mesmo contrato e a mesma verificacao fisica', () => {
  const manualActivate = async (mode: PhysicalSimMode) => {
    const h = await createPilotHarness();
    h.ssh.physical.mode = mode;
    const result = await h.commands.execute({
      requestId: `manual-${mode}`,
      action: 'ACTIVATE',
      profileId: h.target.profileId,
      origin: 'MANUAL',
    });
    return { h, result };
  };

  it('PASS: ACTIVATED_VERIFIED + MITIGATION_VERIFIED, node 2 estreito', async () => {
    const { h, result } = await manualActivate('ok');
    expect(result).toMatchObject({ ok: true, status: 'ACTIVATED_VERIFIED', verified: true });
    expect(result.physicalVerification?.outcome).toBe('PASS');
    expect(result.commandPreview).toContain(' apply local-preference 1100');
    expect(h.ssh.writes[0]).toContain(' if-match ip-prefix AGLINK-BLOCO-TODO-23');
    expect(await events(h)).toEqual(['MITIGATION_VERIFIED']);
  });

  it.each(['wrong-lp', 'ambiguous-peer'] as const)(
    '%s: ACTIVATED_UNVERIFIED_PHYSICAL (nunca verified) + MITIGATION_FAILED/UNVERIFIED_PHYSICAL',
    async (mode) => {
      const { h, result } = await manualActivate(mode);
      expect(result).toMatchObject({
        ok: false,
        status: 'ACTIVATED_UNVERIFIED_PHYSICAL',
        verified: false,
      });
      expect(result.safeError).toMatch(/^MITIGATION_UNVERIFIED_PHYSICAL: /);
      expect(h.ssh.writes).toHaveLength(1);
      expect(await events(h)).toEqual(['MITIGATION_FAILED']);
    },
  );
});
