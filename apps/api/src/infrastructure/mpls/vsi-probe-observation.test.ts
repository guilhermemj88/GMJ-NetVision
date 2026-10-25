import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  observeVrpV200Ping,
  observeYunShanV600Ping,
  observeWindowPing,
  traceAuthorizedByObservation,
  classifyUnderlay,
} from './vsi-probe-observation';
import { correlateProbeWindow } from './vsi-probe-correlation';
import type { ProbeDirection } from './vsi-probe-window';
const folder = new URL('./__fixtures__/bhe-vta-probes-20261022/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('metadata.json', folder), 'utf8'));
function ping(d: ProbeDirection) {
  const p = meta.executions.find((p: { direction: string }) => p.direction === d);
  return { ...p, stdout: readFileSync(new URL(p.fixture, folder), 'utf8') };
}
function historical(d: ProbeDirection, k: string) {
  const f = new URL(
    d === 'LOCAL'
      ? './__fixtures__/bhe-vta-local-full-20261022/'
      : './__fixtures__/bhe-vta-remote-20261022/',
    import.meta.url,
  );
  const m = JSON.parse(
    readFileSync(new URL(d === 'LOCAL' ? 'metadata.json' : 'r4-retest-metadata.json', f), 'utf8'),
  );
  const o = m.outputs.find(
    (o: { fixture: string }) =>
      o.fixture === `${d === 'LOCAL' ? '' : 'r4-retest-'}${k}.sanitized.txt`,
  );
  return { ...o, stdout: readFileSync(new URL(o.fixture, f), 'utf8') };
}
function endpoints(d: ProbeDirection) {
  return {
    ldp: historical(d, 'ldp'),
    brief: historical(d, 'brief'),
    vsi: historical(d, 'vsi'),
    ac: historical(d, 'interface'),
  };
}
const input = () => ({
  collectedAt: meta.executions[1].completedAt,
  pings: { LOCAL: ping('LOCAL'), REMOTE: ping('REMOTE') },
  endpoints: { LOCAL: endpoints('LOCAL'), REMOTE: endpoints('REMOTE') },
});
// Synthetic negative examples derived from real captures; never represented as real fixtures.
function loss(d: ProbeDirection, received: number) {
  const p = ping(d);
  let seq = 0;
  p.stdout = p.stdout
    .replace(/^.*Reply from .*\n/gm, (s: string) => (++seq <= received ? s : ''))
    .replace('3 packet(s) received', `${received} packet(s) received`)
    .replace('0.00% packet loss', `${((100 * (3 - received)) / 3).toFixed(2)}% packet loss`);
  if (!received) p.stdout = p.stdout.replace(/^.*round-trip min\/avg\/max.*\n/gm, '');
  return p;
}
describe('real independent firmware probe observations', () => {
  it('retains audit, exact two sends, real key validation, complete outputs and unchanged services', () => {
    expect(meta.processExitCode).toBe(0);
    expect(meta.stderrPresent).toBe(false);
    expect(meta.servicesChanged).toEqual([]);
    expect(meta.commandsSent).toBe(2);
    expect(
      meta.traceCount + meta.automaticRetries + meta.configurationWrites + meta.preparationCommands,
    ).toBe(0);
    expect(meta.precheck).toHaveLength(2);
    expect(
      meta.precheck.every(
        (p: { sshEnabled: boolean; sshContextCommand: null }) =>
          p.sshEnabled && p.sshContextCommand === null,
      ),
    ).toBe(true);
    expect(
      meta.audit
        .filter((a: { event: string }) => a.event === 'BEFORE_SEND')
        .map((a: { command: string }) => a.command),
    ).toEqual([ping('LOCAL').command, ping('REMOTE').command]);
    for (const d of ['LOCAL', 'REMOTE'] as const) {
      const p = ping(d),
        bytes = readFileSync(new URL(p.fixture, folder));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(p.fixtureSha256);
      expect(createHash('sha256').update(p.stdout.replace(/\n/g, '\r\n')).digest('hex')).toBe(
        p.sha256,
      );
      expect(p.roleAAA).toBe('NOT_VERIFIED');
      expect(p.sent).toBe(1);
      expect(p.complete).toBe(true);
      expect(
        meta.audit.find(
          (a: { event: string; direction: string }) =>
            a.event === 'BEFORE_SEND' && a.direction === d,
        ).hostKeyValidatedBeforePassword,
      ).toBe(true);
    }
  });
  it('VRP V200: actual 3/3, 0%, RTT 1/4/7', () => {
    expect(observeVrpV200Ping(ping('LOCAL'), 'LOCAL')).toMatchObject({
      platform: 'VRP_V200',
      transmitted: 3,
      received: 3,
      lossPercent: 0,
      rttMs: { min: 1, avg: 4, max: 7 },
    });
    expect(observeVrpV200Ping(ping('REMOTE'), 'REMOTE')).toBeNull();
  });
  it('YunShan V600: actual 3/3, 0%, RTT 1/1/1', () => {
    expect(observeYunShanV600Ping(ping('REMOTE'), 'REMOTE')).toMatchObject({
      platform: 'YUNSHAN_V600',
      transmitted: 3,
      received: 3,
      lossPercent: 0,
      rttMs: { min: 1, avg: 1, max: 1 },
    });
    expect(observeYunShanV600Ping(ping('LOCAL'), 'LOCAL')).toBeNull();
  });
  for (const d of ['LOCAL', 'REMOTE'] as const) {
    it.each([0, 1, 2, 3])(
      `${d}: authorizes trace only for complete 100%% loss; received %i`,
      (n) => {
        const p = loss(d, n);
        expect(observeWindowPing(p, d)?.received).toBe(n);
        expect(traceAuthorizedByObservation(p, d)).toBe(n === 0);
      },
    );
    it.each([
      ['missing prompt', (s: string) => s.slice(0, s.lastIndexOf('<'))],
      ['wrong endpoint', (s: string) => s.replace(/10\.100\.101\./g, '10.0.0.')],
      [
        'duplicate counter',
        (s: string) =>
          s.replace('3 packet(s) transmitted', '3 packet(s) transmitted\n3 packet(s) transmitted'),
      ],
      ['inconsistent loss', (s: string) => s.replace('0.00% packet loss', '100.00% packet loss')],
      [
        'extra packets',
        (s: string) => s.replace('3 packet(s) transmitted', '9 packet(s) transmitted'),
      ],
      ['no RTT', (s: string) => s.replace(/^.*round-trip min\/avg\/max.*\n/gm, '')],
      [
        'invalid RTT',
        (s: string) =>
          s.replace(/round-trip min\/avg\/max = .* ms/, 'round-trip min/avg/max = 9/1/1 ms'),
      ],
      ['duplicate reply', (s: string) => s.replace('Sequence=2', 'Sequence=1')],
      ['pager', (s: string) => s.replace('ping statistics', '---- More ----\nping statistics')],
      ['CLI error', (s: string) => s.replace('  PING ', 'Error: Command not supported\n  PING ')],
      ['oversize', (s: string) => 'x'.repeat(131072) + s],
    ] as const)(`${d}: rejects %s`, (_n, mutate) => {
      const p = ping(d);
      p.stdout = mutate(p.stdout);
      expect(observeWindowPing(p, d)).toBeNull();
      expect(traceAuthorizedByObservation(p, d)).toBe(false);
    });
    it(`${d}: rejects incomplete metadata, invalid time, command injection and wrong direction`, () => {
      for (const patch of [
        { complete: false },
        { completedAt: 'invalid' },
        { command: ping(d).command + ';save' },
      ])
        expect(observeWindowPing({ ...ping(d), ...patch }, d)).toBeNull();
      expect(observeWindowPing(ping(d), d === 'LOCAL' ? 'REMOTE' : 'LOCAL')).toBeNull();
      expect(traceAuthorizedByObservation({ ...loss(d, 0), complete: false }, d)).toBe(false);
    });
  }
});
describe('offline native evidence integration', () => {
  it.each([
    [3, 3, 'UNDERLAY_REACHABLE'],
    [3, 0, 'ASYMMETRIC_REACHABILITY'],
    [0, 3, 'ASYMMETRIC_REACHABILITY'],
    [0, 0, 'UNDERLAY_UNREACHABLE'],
    [1, 3, 'DEGRADED_REACHABILITY'],
    [3, 2, 'DEGRADED_REACHABILITY'],
    [1, 2, 'DEGRADED_REACHABILITY'],
    [1, 0, 'ASYMMETRIC_REACHABILITY'],
  ] as const)('received %i / %i -> %s', (l, r, result) => {
    expect(
      classifyUnderlay(
        observeWindowPing(loss('LOCAL', l), 'LOCAL'),
        observeWindowPing(loss('REMOTE', r), 'REMOTE'),
      ),
    ).toBe(result);
  });
  it('missing/timeout evidence remains inconclusive, never simulated success or 100% loss', () => {
    expect(classifyUnderlay(null, observeWindowPing(ping('REMOTE'), 'REMOTE'))).toBe(
      'INCONCLUSIVE',
    );
    const data = input();
    data.pings.LOCAL.complete = false;
    data.pings.LOCAL.errorCode = 'SSH_DIAGNOSTIC_TIMEOUT';
    const r = correlateProbeWindow(data);
    expect(r.classification).toBe('INCONCLUSIVE');
    expect(r.probes[0]!.lossPercent).toBeNull();
    expect(r.checks[0]!.certainty).toBe('INCONCLUSIVE');
    expect(r.summary).not.toContain('Nenhuma falha');
    expect(r.evidence.find((e) => e.id === 'LOCAL:ping')).toMatchObject({
      observedAt: null,
      errorCode: 'SSH_DIAGNOSTIC_TIMEOUT',
    });
  });
  it('combines actual VSI/PW/AC/probes with scoped conclusion and preserved historical timestamps', () => {
    const r = correlateProbeWindow(input());
    expect(r.classification).toBe('UNDERLAY_REACHABLE');
    expect(r.serviceConfirmed).toBe(true);
    expect(r.reciprocal.labelComparisons.map((c) => c.classification)).toEqual(['MATCH', 'MATCH']);
    expect(r.summary).toBe(
      'Nenhuma falha foi identificada no underlay entre os PEs, no pseudowire ou nos attachment circuits avaliados.',
    );
    expect(r.evidence).toHaveLength(10);
    expect(r.evidence.every((e) => e.source === 'LIVE_SSH' && e.observedAt)).toBe(true);
    expect(r.evidence.find((e) => e.id === 'LOCAL:vsi')!.observedAt).not.toBe(
      r.evidence.find((e) => e.id === 'LOCAL:ping')!.observedAt,
    );
    expect(r.warnings.join(' ')).toContain('não comprovam estado simultâneo');
    expect(r.probes.every((p) => p.hops.length === 0)).toBe(true);
    expect(r.traceHomologated).toBe(false);
  });
  it.each(['ac', 'vsi', 'ldp', 'brief'] as const)(
    'refuses broad success with incomplete %s',
    (k) => {
      const data = input();
      data.endpoints.REMOTE[k].complete = false;
      const r = correlateProbeWindow(data);
      expect(r.serviceConfirmed).toBe(false);
      expect(r.summary).not.toContain('Nenhuma falha');
      expect(r.classification).toBe('UNDERLAY_REACHABLE');
    },
  );
  it('does not infer an AC from VLAN number or unrelated interface', () => {
    const d = input();
    d.endpoints.REMOTE.ac.command = 'display interface Vlanif900';
    expect(correlateProbeWindow(d).serviceConfirmed).toBe(false);
  });
  it('preserves actual PW/AC failure or label divergence despite successful IP pings', () => {
    for (const k of ['ac', 'vsi'] as const) {
      const d = input();
      d.endpoints.REMOTE[k].stdout =
        k === 'vsi'
          ? d.endpoints.REMOTE.vsi.stdout.replace(/(PW State\s*:\s*)up/i, '$1down')
          : d.endpoints.REMOTE.ac.stdout.replace('UP', 'DOWN');
      expect(correlateProbeWindow(d).serviceConfirmed).toBe(false);
    }
    const d = input();
    d.endpoints.REMOTE.vsi.stdout = d.endpoints.REMOTE.vsi.stdout.replace(
      /(Remote VC Label\s*:\s*)40943/,
      '${1}40944',
    );
    expect(correlateProbeWindow(d).serviceConfirmed).toBe(false);
  });
});
