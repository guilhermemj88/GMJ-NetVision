/**
 * AGLINK — contrato de prefixos no evento VERIFICADO (runtime real).
 *
 * Cobre o que o prototipo anterior so descrevia e o que a integracao precisa
 * garantir de fato:
 *  - a lista real do escopo (`docs/evidence/aglink-prefix-scope-fixture.json`)
 *    atravessa o payload HTTP sem alterar nenhum campo legado;
 *  - `prefixes` e `eventId` sobrevivem intactos ao codec JSON da outbox e aos
 *    retries (mesma identidade de evento, mesma lista);
 *  - evento ANTIGO, gravado antes deste campo existir, continua sendo lido e
 *    vira `prefixes: null` — nunca uma lista inventada.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHuaweiAdvertisedRoutes } from '../huawei-bgp-advertised-routes-parser';
import { buildMitigationWebhookPayload } from './mitigation-webhook';
import type { MitigationNotification } from './notification-publisher';
import { selectMitigationScopePrefixes } from './mitigation-scope-prefixes';
import { MemoryAutomationStore } from '../../../worker/mitigation/automation-store';
import {
  DurableMitigationOutbox,
  decodeNotification,
  encodeNotification,
} from '../../../worker/mitigation/durable-mitigation-outbox';

const scope = JSON.parse(
  readFileSync(
    new URL('../../../../../../docs/evidence/aglink-prefix-scope-fixture.json', import.meta.url),
    'utf8',
  ),
) as {
  profileId: string;
  deviceId: string;
  policy: string;
  peer: string;
  receivedRoutes: string;
};

const AGLINK_PREFIXES = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];

/** Prova de que a fixture e a CLI crua continua interpretavel pelo parser real. */
const parsedFixture = parseHuaweiAdvertisedRoutes(scope.receivedRoutes, {
  addressFamily: 'IPV4',
  localAs: 268568n,
});

function verifiedNotice(): MitigationNotification {
  return {
    event: 'MITIGATION_VERIFIED',
    eventId: 'AGLINK-CONTRACT-EVENT-1',
    profileId: scope.profileId,
    addressFamily: 'IPV4',
    customer: 'AGLINK',
    device: 'BHE-VTA-F1A-BGP-01',
    policy: scope.policy,
    peer: scope.peer,
    affectedPeers: [scope.peer],
    simulation: false,
    verified: true,
    interfaceName: 'Eth-Trunk1.3058',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: 10_000_000_000n,
    trafficBps: null,
    thresholdBps: 9_000_000_000n,
    node: 2,
    bogonNode: 1,
    mitigationNode: 2,
    rt: '268568:660',
  };
}

/** Notificacao com a lista real, exatamente como o servico a monta. */
function scopedNotice(): MitigationNotification {
  const selection = selectMitigationScopePrefixes({
    evidence: {
      profileId: scope.profileId,
      policy: scope.policy,
      peer: scope.peer,
      receivedRoutes: scope.receivedRoutes,
    },
    expected: {
      profileId: scope.profileId,
      policy: scope.policy,
      peer: scope.peer,
      addressFamily: 'IPV4',
    },
    localAs: 268568n,
  });
  return {
    ...verifiedNotice(),
    prefixes: selection.prefixes,
    fieldsUnavailable: selection.fieldsUnavailable,
  };
}

describe('AGLINK — fixture real do escopo', () => {
  it('a CLI recebida e integral: 3 rotas, sem aviso, todas do peer do escopo', () => {
    expect(parsedFixture.reportedTotal).toBe(3);
    expect(parsedFixture.warnings).toEqual([]);
    expect(parsedFixture.routes.map((route) => route.prefix).sort()).toEqual(AGLINK_PREFIXES);
    expect(parsedFixture.routes.every((route) => route.nextHop === scope.peer)).toBe(true);
  });

  it('o payload do evento verificado transporta os tres prefixos', () => {
    const payload = buildMitigationWebhookPayload(scopedNotice());
    expect(payload.prefixes).toEqual(AGLINK_PREFIXES);
    expect(payload.fieldsUnavailable).toEqual([]);
    expect(payload).toMatchObject({
      event: 'MITIGATION_VERIFIED',
      verified: true,
      simulation: false,
      rt: '268568:660',
      eventId: 'AGLINK-CONTRACT-EVENT-1',
      policy: scope.policy,
      peer: scope.peer,
    });
  });

  it('adicionar `prefixes` nao altera nenhum campo legado do payload', () => {
    const withField = buildMitigationWebhookPayload(scopedNotice());
    const withoutField = buildMitigationWebhookPayload(verifiedNotice());
    const { prefixes, ...rest } = withField;
    expect(prefixes).toEqual(AGLINK_PREFIXES);
    expect(withoutField.prefixes).toBeNull();
    expect({ ...rest, prefixes: null }).toEqual(withoutField);
  });

  it('sem evidencia o payload nao inventa lista e marca o campo', () => {
    const selection = selectMitigationScopePrefixes({
      evidence: null,
      expected: {
        profileId: scope.profileId,
        policy: scope.policy,
        peer: scope.peer,
        addressFamily: 'IPV4',
      },
    });
    const payload = buildMitigationWebhookPayload({
      ...verifiedNotice(),
      prefixes: selection.prefixes,
      fieldsUnavailable: selection.fieldsUnavailable,
    });
    expect(payload.prefixes).toBeNull();
    expect(payload.fieldsUnavailable).toEqual(['prefixes']);
  });
});

describe('AGLINK — outbox duravel e retries', () => {
  it('mesma lista e mesmo eventId em todas as tentativas, sem recalculo', async () => {
    const store = new MemoryAutomationStore();
    let now = 0;
    let acknowledged = false;
    const sent: ReturnType<typeof buildMitigationWebhookPayload>[] = [];
    const transport = {
      publish: async (notification: MitigationNotification) => {
        sent.push(buildMitigationWebhookPayload(notification));
        return { published: acknowledged, skipped: false };
      },
    };
    let outbox = new DurableMitigationOutbox(store, transport, () => now);
    await outbox.publish(scopedNotice());
    await outbox.drain();
    expect(sent).toHaveLength(1);

    // Primeira tentativa sem ACK: nova tentativa depois do backoff.
    now = 30_000;
    acknowledged = true;
    outbox = new DurableMitigationOutbox(store, transport, () => now);
    await outbox.drain();
    await outbox.drain();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[1]?.prefixes).toEqual(AGLINK_PREFIXES);
    expect(sent[1]?.eventId).toBe('AGLINK-CONTRACT-EVENT-1');
  });

  it('evento gravado ANTES do campo continua legivel e vira prefixes: null', () => {
    const legacyRow = encodeNotification(verifiedNotice());
    expect(legacyRow).not.toHaveProperty('prefixes');
    const decoded = decodeNotification(legacyRow);
    const payload = buildMitigationWebhookPayload(decoded);
    expect(payload.prefixes).toBeNull();
    expect(payload.eventId).toBe('AGLINK-CONTRACT-EVENT-1');
    expect(payload.verified).toBe(true);
  });

  it('o codec preserva a lista e os bigint no JSON da outbox', () => {
    const row = encodeNotification(scopedNotice());
    expect(row.prefixes).toEqual(AGLINK_PREFIXES);
    expect(row.effectiveBandwidthBps).toBe('10000000000');
    const decoded = decodeNotification(row);
    expect(decoded.prefixes).toEqual(AGLINK_PREFIXES);
    expect(decoded.effectiveBandwidthBps).toBe(10_000_000_000n);
    expect(decoded.eventId).toBe('AGLINK-CONTRACT-EVENT-1');
  });
});
