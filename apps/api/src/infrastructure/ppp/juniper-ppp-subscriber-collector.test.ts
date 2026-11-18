import { describe, expect, it } from 'vitest';
import {
  JuniperPppSubscriberCollector,
  countPppoeActive,
  decodeSnmpInteger,
  decodeUnsignedBigEndian,
  subscriberHandleFromOid,
} from './juniper-ppp-subscriber-collector';
import {
  JUNIPER_CLIENT_TYPE_PPPOE,
  JUNIPER_SUBSCRIBER_CLIENT_TYPE_OID,
  JUNIPER_SUBSCRIBER_STATE_ACTIVE,
  JUNIPER_SUBSCRIBER_STATE_OID,
} from '../snmp/profiles/juniper';

const CAP = {
  source: 'SNMP_JUNIPER' as const,
  clientTypeOid: JUNIPER_SUBSCRIBER_CLIENT_TYPE_OID,
  stateOid: JUNIPER_SUBSCRIBER_STATE_OID,
  clientTypePppoe: JUNIPER_CLIENT_TYPE_PPPOE,
  stateActive: JUNIPER_SUBSCRIBER_STATE_ACTIVE,
  intervalSeconds: 300,
};

/** 65536 = 0x010000 (PPPoE); 4194304 = 0x400000 (DHCP). */
function ct(handle: string, kind: 'PPPOE' | 'DHCP') {
  const hex = kind === 'PPPOE' ? [0x01, 0x00, 0x00] : [0x40, 0x00, 0x00];
  return { oid: CAP.clientTypeOid + '.' + handle, value: Uint8Array.from(hex) };
}
function st(handle: string, state: number) {
  return { oid: CAP.stateOid + '.' + handle, value: state };
}

describe('decoder clientType (OCTET STRING big-endian)', () => {
  it('decodifica 65536 e 4194304 de buffers de 3 bytes', () => {
    expect(decodeUnsignedBigEndian(Uint8Array.from([0x01, 0x00, 0x00]))).toBe(65536);
    expect(decodeUnsignedBigEndian(Uint8Array.from([0x40, 0x00, 0x00]))).toBe(4194304);
  });
  it('aceita Buffer do Node', () => {
    expect(decodeUnsignedBigEndian(Buffer.from([0x01, 0x00, 0x00]))).toBe(65536);
  });
  it('nao assume 3 bytes fixos', () => {
    expect(decodeUnsignedBigEndian(Uint8Array.from([0x01]))).toBe(1);
    expect(decodeUnsignedBigEndian(Uint8Array.from([0x01, 0x00, 0x00, 0x00]))).toBe(16777216);
  });
  it('aceita number', () => {
    expect(decodeUnsignedBigEndian(65536)).toBe(65536);
  });
  it('buffer vazio vira null', () => {
    expect(decodeUnsignedBigEndian(Uint8Array.from([]))).toBeNull();
  });
  it('valor invalido vira null (nunca 0)', () => {
    expect(decodeUnsignedBigEndian(undefined)).toBeNull();
    expect(decodeUnsignedBigEndian('abc')).toBeNull();
    expect(decodeUnsignedBigEndian({})).toBeNull();
  });
});

describe('decoder state (INTEGER)', () => {
  it('le 2 como ACTIVE', () => {
    expect(decodeSnmpInteger(2)).toBe(2);
    expect(decodeSnmpInteger('2')).toBe(2);
  });
  it('invalido vira null', () => {
    expect(decodeSnmpInteger(undefined)).toBeNull();
    expect(decodeSnmpInteger('x')).toBeNull();
  });
});

describe('indice da subscriber table', () => {
  it('extrai <HiWord>.<LoWord>', () => {
    expect(subscriberHandleFromOid(CAP.clientTypeOid + '.0.214314991', CAP.clientTypeOid))
      .toBe('0.214314991');
  });
  it('distingue handles diferentes', () => {
    const a = subscriberHandleFromOid(CAP.stateOid + '.0.111', CAP.stateOid);
    const b = subscriberHandleFromOid(CAP.stateOid + '.1.111', CAP.stateOid);
    expect(a).not.toBe(b);
  });
  it('suffix invalido vira null', () => {
    expect(subscriberHandleFromOid(CAP.stateOid + '.0', CAP.stateOid)).toBeNull();
    expect(subscriberHandleFromOid(CAP.stateOid + '.a.b', CAP.stateOid)).toBeNull();
    expect(subscriberHandleFromOid('1.3.6.1.2.1', CAP.stateOid)).toBeNull();
  });
});

describe('join PPPoE + ACTIVE', () => {
  it('conta somente PPPoE ACTIVE', () => {
    const ctRows = [ct('0.1', 'PPPOE'), ct('0.2', 'PPPOE'), ct('0.3', 'DHCP'), ct('0.4', 'DHCP')];
    const stRows = [st('0.1', 2), st('0.2', 0), st('0.3', 2), st('0.4', 1)];
    const { online, diagnostics } = countPppoeActive(ctRows, stRows, CAP);
    expect(online).toBe(1);
    expect(diagnostics.matchedRows).toBe(4);
    expect(diagnostics.pppoeRows).toBe(2);
    expect(diagnostics.activeRows).toBe(2);
    expect(diagnostics.pppoeActiveRows).toBe(1);
  });
  it('PPPoE TERMINATING nao entra', () => {
    const { online } = countPppoeActive([ct('0.1', 'PPPOE')], [st('0.1', 4)], CAP);
    expect(online).toBe(0);
  });
  it('orphan de clientType nao entra', () => {
    const { online, diagnostics } = countPppoeActive([ct('0.1', 'PPPOE'), ct('0.9', 'PPPOE')], [st('0.1', 2)], CAP);
    expect(online).toBe(1);
    expect(diagnostics.clientTypeOnly).toBe(1);
  });
  it('orphan de state nao entra', () => {
    const { online, diagnostics } = countPppoeActive([ct('0.1', 'PPPOE')], [st('0.1', 2), st('0.9', 2)], CAP);
    expect(online).toBe(1);
    expect(diagnostics.stateOnly).toBe(1);
  });
  it('valor invalido de clientType nao vira PPPoE', () => {
    const bad = { oid: CAP.clientTypeOid + '.0.1', value: Uint8Array.from([]) };
    const { online } = countPppoeActive([bad], [st('0.1', 2)], CAP);
    expect(online).toBe(0);
  });
});

class FakeWalk {
  calls: string[] = [];
  constructor(private readonly rows: Record<string, Array<{ oid: string; value: unknown }>>) {}
  async walk(_host: string, oid: string): Promise<Array<{ oid: string; value: never }>> {
    this.calls.push(oid);
    if (!(oid in this.rows)) throw new Error('SNMP timeout');
    return this.rows[oid] as never;
  }
}

const DEV = { deviceId: 'dev-1', host: '167.250.0.254', port: 161 };

describe('JuniperPppSubscriberCollector', () => {
  it('faz exatamente os dois walks declarados e nunca o ActiveCount', async () => {
    const client = new FakeWalk({
      [CAP.clientTypeOid]: [ct('0.1', 'PPPOE')],
      [CAP.stateOid]: [st('0.1', 2)],
    });
    const collector = new JuniperPppSubscriberCollector(client);
    const result = await collector.collect(DEV, 'c', CAP);
    expect(result?.online).toBe(1);
    expect(client.calls).toEqual([CAP.clientTypeOid, CAP.stateOid]);
    expect(client.calls.join(',')).not.toContain('2636.3.64.1.1.1.2');
  });

  it('pula antes de 300 s e coleta depois', async () => {
    const client = new FakeWalk({
      [CAP.clientTypeOid]: [ct('0.1', 'PPPOE')],
      [CAP.stateOid]: [st('0.1', 2)],
    });
    const collector = new JuniperPppSubscriberCollector(client);
    const t0 = 1_000_000;
    expect(await collector.collect(DEV, 'c', CAP, t0)).not.toBeNull();
    expect(await collector.collect(DEV, 'c', CAP, t0 + 299_000)).toBeNull();
    expect(await collector.collect(DEV, 'c', CAP, t0 + 300_000)).not.toBeNull();
    expect(client.calls).toHaveLength(4);
  });

  it('nao inicia coleta sobreposta para o mesmo device', async () => {
    const client = new FakeWalk({
      [CAP.clientTypeOid]: [ct('0.1', 'PPPOE')],
      [CAP.stateOid]: [st('0.1', 2)],
    });
    const collector = new JuniperPppSubscriberCollector(client);
    const [a, b] = await Promise.all([
      collector.collect(DEV, 'c', CAP, 0),
      collector.collect(DEV, 'c', CAP, 0),
    ]);
    expect(a).toBe(b);
    expect(client.calls).toHaveLength(2);
  });

  it('timeout devolve online null e preserva decisao para o chamador', async () => {
    const client = new FakeWalk({});
    const collector = new JuniperPppSubscriberCollector(client);
    const result = await collector.collect(DEV, 'c', CAP);
    expect(result?.online).toBeNull();
    expect(result?.error).toBe('SNMP timeout');
  });
});
