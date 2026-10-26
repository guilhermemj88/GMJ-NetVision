import { afterEach, describe, it, expect, vi } from 'vitest';

// Gate default=false: este arquivo exercita o caminho HABILITADO (identidade/autorizacao).
process.env.VSI_DIAGNOSTIC_ENABLED = 'true';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import {
  summarizeMpls,
  type HostRecord,
  type MplsVsi,
  type AuthUser,
  type MplsHostOverview,
} from '@gmj/shared';
import { VsiDiagnosticService, VsiDiagnosticError } from './vsi-diagnostic-service';
import { InventoryVsiDiagnosticRunner, type ObservationSink } from './vsi-diagnostic-ssh';
import { VsiDiagnosticApprovalStore } from './vsi-diagnostic-approval';
import { vsiCommand, type VsiOperation } from './vsi-diagnostic-policy';
import { resolveMplsLoopback, parseVsiFacts, parsePing } from './vsi-diagnostic-parser';
import { registerVsiDiagnosticRoutes } from '../../vsi-diagnostic-routes';
const actor = { id: 'offline-operator', username: 'offline-operator', role: 'OPERATOR' as const };
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of close.splice(0).reverse()) await c();
  vi.useRealTimers();
});
function fixture(
  options: {
    localFail?: boolean;
    remoteFail?: boolean;
    peerMismatch?: boolean;
    acDown?: boolean;
    pwDown?: boolean;
    leftReceived?: number;
    rightReceived?: number;
    differentAddresses?: boolean;
    unknownAcFormat?: boolean;
    unknownPwState?: boolean;
    remotePwMissing?: boolean;
    remoteLabelMismatch?: boolean;
  } = {},
) {
  const a = {
    id: 'A',
    name: 'BHE-VTA-6730-MPLS-01',
    ip: '10.100.101.0',
    managementIp: '10.100.101.0',
    vendor: 'Huawei',
    interfaces: [],
    sshEnabled: true,
    ssh: { host: '10.100.101.0', port: 2222, username: 'reader', credentialConfigured: true },
  } as unknown as HostRecord;
  const b = {
    ...a,
    id: 'B',
    name: 'BHE-VTA-S6750-MPLS-01',
    ip: '10.100.101.255',
    managementIp: '10.100.101.255',
    ssh: { ...a.ssh!, host: '10.100.101.255' },
  };
  if (options.differentAddresses) {
    a.ip = a.managementIp = '192.0.2.1';
    b.ip = b.managementIp = '192.0.2.2';
  }
  const make = (h: HostRecord, other: HostRecord) =>
    ({
      id: h.id + '-vsi',
      hostId: h.id,
      name: '1041-IX-BH-V4',
      rd: '268568:51041',
      signalingType: 'BGP',
      status: 'UP',
      source: 'SNMP',
      lastSeenAt: new Date().toISOString(),
      acs: [{ interfaceName: 'Vlanif900' }],
      pws: [
        {
          hostId: h.id,
          mplsVsiId: h.id + '-vsi',
          vsiName: '1041-IX-BH-V4',
          remoteIp: other.ip,
          remoteHostId: other.id,
          pwId: 25,
          source: 'SNMP',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    }) as unknown as MplsVsi;
  const av = make(a, b),
    bv = make(b, a);
  const reciprocalPw = bv.pws[0]!;
  bv.pws = []; // Remote SNMP misses PW; only live reciprocity proves it.
  const hosts = {
    getHost: vi.fn(async (id: string) => [a, b].find((h) => h.id === id) ?? null),
    listHosts: async () => [a, b],
    getInterfaceHistory: async () => [],
  };
  const overview = (v: MplsVsi, pw: boolean): MplsHostOverview => ({
    supported: true,
    capabilities: { vsi: true, ac: true, pw },
    source: 'SNMP',
    lastPollingAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastErrorSafe: null,
    summary: summarizeMpls([v]),
    vsis: [v],
  });
  const overviews = { A: overview(av, true), B: overview(bv, false) };
  const mpls = {
    listVsis: async (id: string) => (id === a.id ? [av] : [bv]),
    getHostOverview: vi.fn(async (id: string) => overviews[id as 'A' | 'B']),
  };
  const audit: Array<{ host: string; command: string }> = [];
  const wire = (h: HostRecord, command: string, fn: (c: string) => void) => {
    fn(command);
    audit.push({ host: h.id, command });
  };
  const rewrite = (s: string) =>
    options.differentAddresses
      ? s.replaceAll('10.100.101.255', '192.0.2.2').replaceAll('10.100.101.0', '192.0.2.1')
      : s;
  const file = (d: 'LOCAL' | 'REMOTE', kind: string) => {
    const folder = d === 'LOCAL' ? 'bhe-vta-local-full-20261022/' : 'bhe-vta-remote-20261022/';
    return rewrite(
      readFileSync(
        new URL(
          './__fixtures__/' +
            folder +
            (d === 'REMOTE' ? 'r4-retest-' : '') +
            kind +
            '.sanitized.txt',
          import.meta.url,
        ),
        'utf8',
      ),
    );
  };
  const collectEndpoint = vi.fn(
    async (
      h: HostRecord,
      _name: string,
      signal: AbortSignal,
      fn: (c: string) => void,
      sink: ObservationSink,
    ) => {
      const d = h.id === a.id ? 'LOCAL' : 'REMOTE';
      if ((d === 'LOCAL' && options.localFail) || (d === 'REMOTE' && options.remoteFail))
        throw new Error('SSH_DIAGNOSTIC_TIMEOUT');
      const captures: Record<
        string,
        { command: string; stdout: string; complete: boolean; completedAt: string }
      > = {};
      for (const [kind, command] of [
        ['preparation', 'screen-length 0 temporary'],
        ['version', 'display version'],
        ['ldp', 'display mpls ldp'],
        ['brief', 'display ip interface brief'],
        ['vsi', 'display vsi name 1041-IX-BH-V4 verbose'],
        ['interface', 'display interface Vlanif1041'],
      ]) {
        signal.throwIfAborted();
        wire(h, command!, fn);
        let stdout = file(d, kind!);
        if (d === 'REMOTE' && options.peerMismatch && kind === 'vsi')
          stdout = stdout.replace(/(Peer Ip Address\s*:\s*)[\d.]+/, '${1}192.0.2.99');
        if (options.acDown && d === 'LOCAL' && kind === 'interface')
          stdout = stdout.replace('UP', 'DOWN');
        if (options.pwDown && d === 'REMOTE' && kind === 'vsi')
          stdout = stdout.replace(/(PW State\s*:\s*)up/i, '$1down');
        if (options.unknownAcFormat && kind === 'interface')
          stdout = stdout.replace('current state', 'unexpected state');
        if (options.unknownPwState && kind === 'vsi')
          stdout = stdout.replace(/(PW State\s*:\s*)up/i, '$1unknown');
        if (options.remotePwMissing && d === 'REMOTE' && kind === 'vsi')
          stdout =
            stdout.slice(0, stdout.indexOf('**PW Information:')) +
            `**PW Information:\n<${h.name}>\n`;
        if (options.remoteLabelMismatch && d === 'REMOTE' && kind === 'vsi')
          stdout = stdout.replace(
            /(Local VC Label\s*:\s*)\d+/,
            (_match, prefix: string) => prefix + '999999',
          );
        const item = {
          command: command!,
          stdout,
          complete: true,
          completedAt: new Date().toISOString(),
          durationMs: 1,
          sha256: createHash('sha256').update(stdout).digest('hex'),
        };
        sink(item);
        const key = kind === 'interface' ? 'ac' : kind;
        if (['ldp', 'brief', 'vsi', 'ac'].includes(key!)) captures[key!] = item;
      }
      return {
        captures,
        prompt: `<${h.name}>`,
        platform: d === 'LOCAL' ? ('VRP_V200' as const) : ('YUNSHAN_V600' as const),
      };
    },
  );
  const run = vi.fn(
    async (h: HostRecord, op: VsiOperation, signal: AbortSignal, fn: (c: string) => void) => {
      signal.throwIfAborted();
      expect(op.kind).toBe('PING');
      wire(h, vsiCommand(op), fn);
      const local = h.id === a.id;
      let output = rewrite(
        readFileSync(
          new URL(
            './__fixtures__/bhe-vta-probes-20261022/' +
              (local ? 'local' : 'remote') +
              '-ping.sanitized.txt',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      const received = (local ? options.leftReceived : options.rightReceived) ?? 3;
      let seq = 0;
      output = output
        .replace(/^.*Reply from .*\n/gm, (s) => (++seq <= received ? s : ''))
        .replace('3 packet(s) received', `${received} packet(s) received`)
        .replace('0.00% packet loss', `${((100 * (3 - received)) / 3).toFixed(2)}% packet loss`);
      if (!received) output = output.replace(/^.*round-trip min\/avg\/max.*\n/gm, '');
      return output;
    },
  );
  const beforeStart = vi.fn();
  const validate = vi.fn(async () => {});
  const service = new VsiDiagnosticService(
    hosts,
    mpls,
    { run, collectEndpoint, validate },
    () => {},
    beforeStart,
  );
  close.push(() => service.close());
  return {
    service,
    hosts,
    mpls,
    overviews,
    reciprocalPw,
    a,
    b,
    av,
    bv,
    run,
    collectEndpoint,
    audit,
    beforeStart,
    validate,
  };
}
async function finish(f: ReturnType<typeof fixture>) {
  const job = await f.service.start(f.a.id, f.av.id, actor);
  for (let n = 0; n < 300; n++) {
    const r = f.service.get(job.diagnosticId, f.a.id, f.av.id);
    if (r.completedAt) return r;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('Offline job did not finish');
}
describe('native fresh VSI orchestration from real homologated captures, offline transport', () => {
  it('prechecks both indexed hosts before any authenticated CLI; mismatch fails closed', async () => {
    const f = fixture();
    f.validate.mockImplementation(async () => {
      throw new Error('INVENTORY_CHANGED');
    });
    const result = await finish(f);
    expect(result.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(f.collectEndpoint).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('cancel during the read-only precheck never starts SSH', async () => {
    const f = fixture();
    const job = await f.service.start(f.a.id, f.av.id, actor);
    f.service.cancel(job.diagnosticId, f.a.id, f.av.id, actor);
    await new Promise((r) => setTimeout(r, 2));
    expect(f.service.get(job.diagnosticId, f.a.id, f.av.id).state).toBe('CANCELLED');
    expect(f.collectEndpoint).not.toHaveBeenCalled();
  });
  it('collects both PEs before any probe; all live evidence belongs to this run', async () => {
    const f = fixture(),
      r = await finish(f);
    expect(r.overallStatus).toBe('OK');
    expect(r.underlayClassification).toBe('UNDERLAY_REACHABLE');
    expect(r.progress?.some((p) => p.stage.includes('Correlacionando'))).toBe(true);
    expect(r.progress?.at(-1)?.stage).toBe('Concluído');
    expect(r.summary).toBe(
      'Nenhuma falha foi identificada no underlay entre os PEs, no pseudowire ou nos attachment circuits avaliados. O PE remoto não expõe evidência PW pela fonte SNMP utilizada.',
    );
    expect(f.audit).toHaveLength(14);
    expect(f.audit.slice(0, 12).every((a) => !a.command.startsWith('ping'))).toBe(true);
    expect(f.audit.slice(12).map((a) => a.command)).toEqual([
      'ping -a 10.100.101.0 -c 3 10.100.101.255',
      'ping -a 10.100.101.255 -c 3 10.100.101.0',
    ]);
    expect(r.probes).toHaveLength(2);
    expect(
      r.evidence
        .filter((e) => e.source === 'LIVE_SSH')
        .every(
          (e) =>
            e.complete &&
            e.diagnosticId === r.diagnosticId &&
            Date.parse(e.observedAt!) >= Date.parse(r.startedAt),
        ),
    ).toBe(true);
    expect(
      f.audit.some((a) => a.command.includes('Vlanif900') || a.command.startsWith('tracert')),
    ).toBe(false);
    expect(r.remotes[0]?.vsiId).toBe(f.bv.id);
    expect(r.warnings.join(' ')).not.toContain('anteriores não comprovam');
  });
  it('takes probe IPs from current loopbacks, not hardcoded product targets', async () => {
    const f = fixture({ differentAddresses: true }),
      r = await finish(f);
    expect(r.overallStatus).toBe('OK');
    expect(r.probes[0]).toMatchObject({ source: '192.0.2.1', destination: '192.0.2.2' });
    expect(
      f.audit
        .filter((a) => a.command.startsWith('ping'))
        .every((a) => !a.command.includes('10.100.101.')),
    ).toBe(true);
  });
  it.each(['localFail', 'remoteFail'] as const)(
    'continues independent collection on %s, preserving partial results and blocking probes',
    async (k) => {
      const f = fixture({ [k]: true }),
        r = await finish(f);
      expect(r.overallStatus).toBe('INSUFFICIENT_DATA');
      expect(f.collectEndpoint).toHaveBeenCalledTimes(2);
      expect(r.evidence.some((e) => e.source === 'LIVE_SSH')).toBe(true);
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it('blocks probes for live peer mismatch even when persisted index looks healthy', async () => {
    const f = fixture({ peerMismatch: true }),
      r = await finish(f);
    expect(r.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['acDown', 'pwDown'] as const)(
    'keeps confirmed %s visible despite successful IP probes',
    async (k) => {
      const r = await finish(fixture({ [k]: true }));
      expect(r.overallStatus).toBe('FAILED');
      expect(
        r.checks.some(
          (c) => c.category === (k === 'acDown' ? 'AC' : 'PW') && c.status === 'FAILED',
        ),
      ).toBe(true);
      expect(r.summary).not.toContain('Nenhuma falha');
    },
  );
  it.each([
    [3, 0, 'ASYMMETRIC_REACHABILITY'],
    [0, 3, 'ASYMMETRIC_REACHABILITY'],
    [2, 3, 'DEGRADED_REACHABILITY'],
    [0, 0, 'UNDERLAY_UNREACHABLE'],
  ] as const)('received %i/%i yields %s with trace fail-closed', async (l, r, state) => {
    const f = fixture({ leftReceived: l, rightReceived: r }),
      result = await finish(f);
    expect(result.underlayClassification).toBe(state);
    expect(f.audit.some((a) => a.command.startsWith('tracert'))).toBe(false);
    expect(
      result.probes.every(
        (p) => p.tracerouteNotExecutedReason === 'NOT_HOMOLOGATED' && p.hops.length === 0,
      ),
    ).toBe(true);
  });
  it('does not classify a ping timeout as packet loss or simulate success', async () => {
    const f = fixture();
    f.run.mockRejectedValue(new Error('SSH_DIAGNOSTIC_TIMEOUT'));
    const r = await finish(f);
    expect(r.underlayClassification).toBe('INCONCLUSIVE');
    expect(r.probes.every((p) => p.lossPercent === null)).toBe(true);
    expect(r.evidence.filter((e) => e.errorCode === 'SSH_DIAGNOSTIC_TIMEOUT')).toHaveLength(2);
  });
  it('does not accept historical evidence silently inserted by a runner', async () => {
    const f = fixture(),
      original = f.collectEndpoint.getMockImplementation()!;
    f.collectEndpoint.mockImplementation(async (...args) => {
      const data = await original(...args);
      data.captures.ldp!.completedAt = '2026-01-01T00:00:00Z';
      return data;
    });
    const r = await finish(f);
    expect(r.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(r.summary).not.toContain('Nenhuma falha');
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(['unknownAcFormat', 'unknownPwState'] as const)(
    'blocks all probes if current %s is unrecognized',
    async (key) => {
      const f = fixture({ [key]: true });
      const r = await finish(f);
      expect(r.overallStatus).toBe('INSUFFICIENT_DATA');
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it('reserves requests and rejects duplicate concurrent starts', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.service.start(f.a.id, f.av.id, actor),
      f.service.start(f.a.id, f.av.id, actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('cancel stops between stages and never starts a later SSH operation', async () => {
    const f = fixture();
    f.collectEndpoint.mockImplementation(
      async (_h, _n, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('SSH_DIAGNOSTIC_CANCELLED')), {
            once: true,
          });
        }),
    );
    const job = await f.service.start(f.a.id, f.av.id, actor);
    for (let i = 0; i < 20 && f.collectEndpoint.mock.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 1));
    f.service.cancel(job.diagnosticId, f.a.id, f.av.id, actor);
    await new Promise((r) => setTimeout(r, 2));
    expect(f.service.get(job.diagnosticId, f.a.id, f.av.id).state).toBe('CANCELLED');
    expect(f.collectEndpoint).toHaveBeenCalledTimes(1);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('global timeout preserves collected evidence and terminates a stalled next stage', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      original = f.collectEndpoint.getMockImplementation()!;
    f.collectEndpoint.mockImplementation(async (...args) =>
      args[0].id === 'A' ? original(...args) : new Promise(() => {}),
    );
    const job = await f.service.start(f.a.id, f.av.id, actor);
    await vi.advanceTimersByTimeAsync(90001);
    const r = f.service.get(job.diagnosticId, f.a.id, f.av.id);
    expect(r.state).toBe('TIMED_OUT');
    expect(r.evidence.some((e) => e.source === 'LIVE_SSH')).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });
  it('requires explicit arming before starting any device operation', async () => {
    const f = fixture();
    f.beforeStart.mockImplementation(() => {
      throw new VsiDiagnosticError('ACTIVE_APPROVAL_REQUIRED', 423);
    });
    await expect(f.service.start(f.a.id, f.av.id, actor)).rejects.toMatchObject({
      statusCode: 423,
    });
    expect(f.collectEndpoint).not.toHaveBeenCalled();
  });
});
describe('capability-aware native VSI inventory precheck with an offline SSH runner', () => {
  it('false/empty remote passes with a warning and live SSH can independently confirm health', async () => {
    const f = fixture(),
      before = structuredClone(f.bv),
      result = await finish(f);
    expect(result.overallStatus).toBe('OK');
    expect(f.collectEndpoint).toHaveBeenCalledTimes(2);
    expect(result.warnings.some((w) => w.startsWith('REMOTE_PW_SNMP_UNAVAILABLE:'))).toBe(true);
    expect(
      result.evidence.some(
        (e) =>
          e.hostId === f.b.id &&
          e.source === 'PERSISTED_SNMP' &&
          e.output.includes('PW_EVIDENCE_UNAVAILABLE_VIA_SNMP'),
      ),
    ).toBe(true);
    expect(result.remotes[0]!.observedVsi!.peers[0]).toMatchObject({
      inboundLabel: 1016584,
      outboundLabel: 40943,
    });
    expect(f.bv).toEqual(before);
    expect(f.overviews.B.capabilities.pw).toBe(false);
    expect(result.summary).toContain('fonte SNMP utilizada');
  });
  it('true/empty remote blocks before any SSH', async () => {
    const f = fixture();
    f.overviews.B.capabilities.pw = true;
    const result = await finish(f);
    expect(result.checks.some((c) => c.message.includes('PERSISTED_PW_CARDINALITY_MISMATCH'))).toBe(
      true,
    );
    expect(f.collectEndpoint).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each([null, undefined])('unknown %s remote capability blocks before any SSH', async (pw) => {
    const f = fixture();
    (f.overviews.B.capabilities as { pw: unknown }).pw = pw;
    const result = await finish(f);
    expect(result.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(result.checks.some((c) => c.message.includes('PW_SNMP_CAPABILITY_UNKNOWN'))).toBe(true);
    expect(f.collectEndpoint).not.toHaveBeenCalled();
  });
  it('false with missing remote VSI blocks before any SSH', async () => {
    const f = fixture();
    f.overviews.B.vsis = [];
    const result = await finish(f);
    expect(result.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(f.collectEndpoint).not.toHaveBeenCalled();
  });
  it.each(['stale', 'error', 'unfinished'] as const)(
    'false with %s collection blocks before any SSH',
    async (kind) => {
      const f = fixture();
      if (kind === 'stale') f.bv.lastSeenAt = '2026-01-01T00:00:00Z';
      if (kind === 'error') f.overviews.B.lastErrorSafe = 'PARTIAL_WALK_TIMEOUT';
      if (kind === 'unfinished') f.overviews.B.lastSuccessAt = '2026-01-01T00:00:00Z';
      const result = await finish(f);
      expect(result.overallStatus).toBe('INSUFFICIENT_DATA');
      expect(f.collectEndpoint).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it('a conflicting remoteHostId does not fall back to peer IP', async () => {
    const f = fixture();
    f.av.pws[0]!.remoteHostId = 'unknown';
    expect((await finish(f)).overallStatus).toBe('INSUFFICIENT_DATA');
    expect(f.collectEndpoint).not.toHaveBeenCalled();
  });
  it('a duplicated inventory peer IP blocks despite a populated remoteHostId', async () => {
    const f = fixture();
    f.hosts.listHosts = async () => [f.a, f.b, { ...f.b, id: 'duplicate' }];
    expect((await finish(f)).overallStatus).toBe('INSUFFICIENT_DATA');
    expect(f.collectEndpoint).not.toHaveBeenCalled();
  });
  it('live SSH without the expected PW cannot inherit health or labels from the local PE', async () => {
    const f = fixture({ remotePwMissing: true }),
      result = await finish(f);
    expect(result.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(result.remotes[0]!.observedVsi!.peers).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.bv.pws).toEqual([]);
  });
  it('live contradictory labels remain contradictory when SNMP is unavailable', async () => {
    const f = fixture({ remoteLabelMismatch: true }),
      result = await finish(f);
    expect(result.overallStatus).toBe('INSUFFICIENT_DATA');
    expect(result.remotes[0]!.observedVsi!.peers[0]!.inboundLabel).toBe(999999);
    expect(
      result.evidence.some(
        (e) =>
          e.hostId === f.b.id &&
          e.source === 'LIVE_SSH' &&
          /Local VC Label\s*:\s*999999/.test(e.output),
      ),
    ).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.bv.pws).toEqual([]);
  });
  it('true/consistent reciprocal inventory retains its behavior without an unavailable warning', async () => {
    const f = fixture();
    f.overviews.B.capabilities.pw = true;
    f.bv.pws = [f.reciprocalPw];
    const result = await finish(f);
    expect(result.overallStatus).toBe('OK');
    expect(result.warnings.some((w) => w.includes('PW_SNMP_UNAVAILABLE'))).toBe(false);
    expect(f.audit).toHaveLength(14);
  });
  it('keeps AAA unverified and trace not homologated after a successful offline run', async () => {
    const f = fixture(),
      result = await finish(f);
    expect(result.warnings.join(' ')).toContain('AAA = NOT_VERIFIED');
    expect(result.probes.every((p) => p.tracerouteNotExecutedReason === 'NOT_HOMOLOGATED')).toBe(
      true,
    );
    expect(f.audit.some((a) => a.command.startsWith('tracert'))).toBe(false);
  });
});

describe('closed commands and authenticated native API', () => {
  it.each([
    'A;save',
    'A\nsystem-view',
    'A|display current-configuration',
    'A && reboot',
    'A save',
    '"A"',
  ])('blocks unsafe argument %j', (value) => {
    expect(() => vsiCommand({ kind: 'VSI', argument: value })).toThrow();
    expect(() => vsiCommand({ kind: 'INTERFACE', argument: value })).toThrow();
  });
  it('does not guess LoopBack0, management IP, VC-ID or packet statistics', () => {
    expect(
      resolveMplsLoopback('LSR ID : 192.0.2.1', 'LoopBack7 192.0.2.1/32 up up(s)'),
    ).toMatchObject({ interfaceName: 'LoopBack7' });
    expect(resolveMplsLoopback('LSR ID : 192.0.2.1', 'Vlanif7 192.0.2.1/32 up up')).toBeNull();
    expect(parseVsiFacts('VSI Name : X\nVSI Index : 169', 'X').vsiId).toBeNull();
    expect(parsePing('3 packet(s) transmitted\n0 packet(s) received\n0% packet loss')).toBeNull();
  });
  it('checks validated profile before decryption and always rejects real trace', async () => {
    const f = fixture(),
      decrypt = vi.fn();
    const runner = new InventoryVsiDiagnosticRunner(
      { getHost: f.hosts.getHost, getDecryptedSshCredentials: decrypt },
      async () => [],
    );
    await expect(
      runner.run(f.a, { kind: 'LOOPBACKS' }, new AbortController().signal, () => {}),
    ).rejects.toThrow('VALIDATED_COMMAND_PROFILE_REQUIRED');
    await expect(
      runner.run(
        f.a,
        { kind: 'TRACE', source: '192.0.2.1', destination: '192.0.2.2' },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('NOT_HOMOLOGATED');
    expect(decrypt).not.toHaveBeenCalled();
  });
  it('rejects public/readOnly/VIEWER and command strings, accepts authorized identity with typed IDs', async () => {
    const f = fixture(),
      app = Fastify();
    let user: AuthUser | null = null;
    registerVsiDiagnosticRoutes(
      app,
      f.service,
      async () => user,
      new VsiDiagnosticApprovalStore(mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/vsi-routes-`)),
    );
    app.setErrorHandler((e, _q, r) =>
      r.code(e instanceof VsiDiagnosticError ? e.statusCode : 400).send({ message: 'safe' }),
    );
    close.push(() => app.close());
    const url = `/api/hosts/${f.a.id}/mpls/vsis/${f.av.id}/diagnose`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {},
          headers: { authorization: 'Bearer PUBLIC' },
        })
      ).statusCode,
    ).toBe(401);
    user = { ...actor, email: 'test@example.invalid', name: 'offline', role: 'VIEWER' };
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(403);
    user.role = 'OPERATOR';
    for (const payload of [
      { command: 'display version' },
      { source: '192.0.2.1' },
      { readOnly: true },
    ])
      expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: url + '?publicToken=public', payload: {} }))
        .statusCode,
    ).toBe(400);
    expect(f.collectEndpoint).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(202);
  });
});
