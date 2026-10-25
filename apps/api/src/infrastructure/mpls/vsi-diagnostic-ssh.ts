import { createHash } from 'node:crypto';
import { observeVsi, type CompleteCliObservation } from './vsi-diagnostic-observation';
import type { VsiEndpointCaptures } from './vsi-probe-correlation';
import type { ObservedPing } from './vsi-probe-observation';
import { readFile, lstat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { z } from 'zod';
import { VSI_DIAGNOSTIC_LIMITS, type HostRecord } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { SshClientImpl } from '../ssh/ssh-client-impl';
import { isDiagnosticSshContext } from '../ssh/ssh-context';
import { diagnosticSessionPreparation } from '../ssh/diagnostic-session-preparation';
import {
  vsiCommand,
  safeVsiOutput,
  VSI_OPERATION_KINDS,
  type VsiOperation,
} from './vsi-diagnostic-policy';
export interface EndpointCollection {
  captures: Partial<VsiEndpointCaptures>;
  prompt: string;
  platform: ObservedPing['platform'];
}
export type ObservationSink = (
  observation: CompleteCliObservation & { durationMs: number; sha256: string },
) => void;
export interface VsiDiagnosticRunner {
  validate(host: HostRecord, signal: AbortSignal): Promise<void>;
  collectEndpoint(
    host: HostRecord,
    vsiName: string,
    signal: AbortSignal,
    audit: (command: string) => void,
    observed: ObservationSink,
  ): Promise<EndpointCollection>;
  run(
    host: HostRecord,
    operation: VsiOperation,
    signal: AbortSignal,
    audit: (command: string) => void,
  ): Promise<string>;
}
const profileSchema = z
  .object({
    hostId: z.string(),
    endpoint: z.string(),
    port: z.number().int().min(1).max(65535),
    username: z.string(),
    context: z.string().refine(isDiagnosticSshContext).nullable(),
    fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
    initialPrompt: z.string().regex(/^<[A-Za-z0-9_.:-]{1,120}>$/),
    expectedPrompt: z.string().regex(/^<[A-Za-z0-9_.:-]{1,120}>$/),
    routingContext: z.literal('GLOBAL'),
    platform: z.enum(['VRP_V200', 'YUNSHAN_V600']).optional(),
    approvedProbe: z
      .object({
        source: z.string().refine((v) => isIP(v) === 4),
        destination: z.string().refine((v) => isIP(v) === 4),
      })
      .strict()
      .optional(),
    firmwareEvidence: z.string().min(1).max(240),
    vendor: z.literal('HUAWEI'),
    sessionPreparation: z.literal('screen-length 0 temporary').optional(),
    disablePagingTemporary: z.literal(true).optional(),
    validFrom: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    operations: z.array(z.enum(VSI_OPERATION_KINDS)).min(1).max(8),
  })
  .strict();
export type VsiAccessProfile = z.infer<typeof profileSchema>;
export const parseVsiAccessProfile = (value: unknown): VsiAccessProfile =>
  profileSchema.parse(value);
export async function readVsiAccessProfiles(
  filename: string | undefined,
): Promise<VsiAccessProfile[]> {
  if (!filename) return [];
  try {
    const stat = await lstat(filename);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 65536 ||
      (process.platform !== 'win32' && stat.mode & 0o022)
    )
      return [];
    return z
      .object({ profiles: z.array(profileSchema).max(100) })
      .strict()
      .parse(JSON.parse(await readFile(filename, 'utf8'))).profiles;
  } catch {
    return [];
  }
}
/** Existing server vault and existing SSH client; no parallel inventory or SSH implementation. */
export class InventoryVsiDiagnosticRunner implements VsiDiagnosticRunner {
  constructor(
    private readonly hosts: Pick<HostRepository, 'getDecryptedSshCredentials' | 'getHost'>,
    private readonly profiles: () => Promise<VsiAccessProfile[]> = () =>
      readVsiAccessProfiles(process.env.VSI_DIAGNOSTIC_ACCESS_FILE),
  ) {}
  async run(
    host: HostRecord,
    operation: VsiOperation,
    signal: AbortSignal,
    audit: (command: string) => void,
  ): Promise<string> {
    if (operation.kind === 'TRACE') throw new Error('NOT_HOMOLOGATED');
    const command = vsiCommand(operation);
    const profile = await this.profile(host, [operation.kind]);
    if (
      operation.kind === 'PING' &&
      (profile.context !== null ||
        profile.expectedPrompt !== `<${host.name}>` ||
        (profile.approvedProbe &&
          (operation.source !== profile.approvedProbe.source ||
            operation.destination !== profile.approvedProbe.destination)))
    )
      throw new Error('SSH_DIAGNOSTIC_PROBE_NOT_AUTHORIZED');
    const preparation =
      operation.kind === 'PING' ? undefined : diagnosticSessionPreparation(profile);
    if (profile.context !== null && !isDiagnosticSshContext(profile.context))
      throw new Error('INVALID_CONTEXT_PROFILE');
    if (!profile.context && profile.initialPrompt !== profile.expectedPrompt)
      throw new Error('INVALID_CONTEXT_PROFILE');
    signal.throwIfAborted();
    const credentials = await this.hosts.getDecryptedSshCredentials(host.id);
    if (!credentials?.password) throw new Error('SSH_CREDENTIAL_UNAVAILABLE');
    signal.throwIfAborted();
    if (Date.parse(profile.expiresAt) <= Date.now()) throw new Error('PROFILE_EXPIRED');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? 'OPERATOR_CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const expiry = setTimeout(
      () =>
        controller.abort(
          Date.parse(profile.expiresAt) <= Date.now() ? 'PROFILE_EXPIRED' : 'COMMAND_TIMEOUT',
        ),
      Math.min(
        VSI_DIAGNOSTIC_LIMITS.commandMs,
        Math.max(0, Date.parse(profile.expiresAt) - Date.now()),
      ),
    );
    try {
      const client = new SshClientImpl({
        port: profile.port,
        username: profile.username,
        password: credentials.password,
        contextCommand: profile.context,
        readyTimeout: 8000,
        shellTimeoutMs: VSI_DIAGNOSTIC_LIMITS.commandMs,
        commandIdleMs: VSI_DIAGNOSTIC_LIMITS.commandMs,
        diagnostic: {
          fingerprint: profile.fingerprint,
          initialPrompt: profile.initialPrompt,
          expectedPrompt: profile.expectedPrompt,
          allowedCommands: [command],
          outputBytes: VSI_DIAGNOSTIC_LIMITS.outputBytes,
          signal: controller.signal,
          onCommand: audit,
          ...(preparation ? { sessionPreparation: preparation } : {}),
        },
      });
      const results = await client.execute(profile.endpoint, [command]);
      if (results.some((r) => r.exitCode !== 0 || r.stderr)) throw new Error('SSH_COMMAND_FAILED');
      return safeVsiOutput(results.map((r) => r.stdout).join('\n'))
        .split(credentials.password)
        .join('[REMOVIDO]');
    } finally {
      clearTimeout(expiry);
      signal.removeEventListener('abort', abort);
    }
  }
  async validate(host: HostRecord, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const profile = await this.profile(host, [
      'VERSION',
      'LSR',
      'LOOPBACKS',
      'VSI',
      'INTERFACE',
      'PING',
    ]);
    if (
      !profile.platform ||
      profile.context !== null ||
      profile.expectedPrompt !== `<${host.name}>` ||
      profile.initialPrompt !== profile.expectedPrompt ||
      !diagnosticSessionPreparation(profile)
    )
      throw new Error('INVALID_CONTEXT_PROFILE');
    signal.throwIfAborted();
  }
  private async profile(
    host: HostRecord,
    kinds: VsiOperation['kind'][],
  ): Promise<VsiAccessProfile> {
    const fresh = await this.hosts.getHost(host.id);
    if (
      !fresh ||
      JSON.stringify(fresh.ssh) !== JSON.stringify(host.ssh) ||
      fresh.sshEnabled !== host.sshEnabled ||
      fresh.name !== host.name
    )
      throw new Error('INVENTORY_CHANGED');
    if (
      !host.sshEnabled ||
      !host.ssh?.credentialConfigured ||
      (host.vendor &&
        !/^(?:generic|unknown|n\/d)$/i.test(host.vendor) &&
        !/huawei/i.test(host.vendor)) ||
      !isIP(host.ssh.host)
    )
      throw new Error('SSH_NOT_AVAILABLE');
    const now = Date.now();
    const matches = (await this.profiles()).filter(
      (p) =>
        p.hostId === host.id &&
        p.endpoint === host.ssh!.host &&
        p.port === host.ssh!.port &&
        p.username === host.ssh!.username &&
        p.context === (host.ssh!.contextCommand ?? null) &&
        kinds.every((kind) => p.operations.includes(kind)) &&
        Date.parse(p.validFrom) <= now &&
        Date.parse(p.expiresAt) > now,
    );
    if (matches.length !== 1) throw new Error('VALIDATED_COMMAND_PROFILE_REQUIRED');
    const profile = parseVsiAccessProfile(matches[0]);
    return profile;
  }

  async collectEndpoint(
    host: HostRecord,
    vsiName: string,
    signal: AbortSignal,
    audit: (command: string) => void,
    observed: ObservationSink,
  ): Promise<EndpointCollection> {
    const profile = await this.profile(host, ['VERSION', 'LSR', 'LOOPBACKS', 'VSI', 'INTERFACE']);
    if (
      !profile.platform ||
      profile.context !== null ||
      profile.initialPrompt !== profile.expectedPrompt
    )
      throw new Error('INVALID_CONTEXT_PROFILE');
    const preparation = diagnosticSessionPreparation(profile);
    if (!preparation) throw new Error('SSH_DIAGNOSTIC_PREPARATION_UNCONFIRMED');
    const commands = [
      vsiCommand({ kind: 'VERSION' }),
      vsiCommand({ kind: 'LSR' }),
      vsiCommand({ kind: 'LOOPBACKS' }),
      vsiCommand({ kind: 'VSI', argument: vsiName }),
    ];
    const allowed = [...commands],
      expected = [preparation, ...commands];
    signal.throwIfAborted();
    const credentials = await this.hosts.getDecryptedSshCredentials(host.id);
    if (!credentials?.password) throw new Error('SSH_CREDENTIAL_UNAVAILABLE');
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? 'OPERATOR_CANCELLED');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort(signal.reason);
    const timer = setTimeout(
      () => controller.abort('COMMAND_TIMEOUT'),
      Math.min(12000, Math.max(0, Date.parse(profile.expiresAt) - Date.now())),
    );
    const result: EndpointCollection = {
      captures: {},
      prompt: profile.expectedPrompt,
      platform: profile.platform,
    };
    const completed = new Map<string, CompleteCliObservation>();
    let count = 0;
    let commandStarted = Date.now();
    const sanitize = (v: string) =>
      safeVsiOutput(v).split(credentials.password!).join('[REMOVIDO]');
    try {
      const client = new SshClientImpl({
        port: profile.port,
        username: profile.username,
        password: credentials.password,
        contextCommand: null,
        readyTimeout: 8000,
        shellTimeoutMs: 12000,
        commandIdleMs: 12000,
        diagnostic: {
          fingerprint: profile.fingerprint,
          initialPrompt: profile.initialPrompt,
          expectedPrompt: profile.expectedPrompt,
          allowedCommands: allowed,
          outputBytes: 131072,
          signal: controller.signal,
          sessionPreparation: preparation,
          onCommand: (command) => {
            signal.throwIfAborted();
            if (Date.parse(profile.expiresAt) <= Date.now()) throw new Error('PROFILE_EXPIRED');
            if (command !== expected[count]) throw new Error('UNAUTHORIZED_COMMAND_SEQUENCE');
            if (command === 'display mpls ldp') {
              const version = completed.get('display version')?.stdout ?? '';
              const valid =
                profile.platform === 'VRP_V200'
                  ? /VRP.*Version 5\.170 \(S6730 (?:V200R022C00SPC500|V200R021C00SPC100)\)/i.test(
                      version,
                    )
                  : /Version 1\.24\.0\.1 \(S6700 V600R024C00SPC500\)/i.test(version);
              if (!valid) throw new Error('UNHOMOLOGATED_PLATFORM');
            }
            commandStarted = Date.now();
            audit(command);
            count++;
          },
          onCommandComplete: (item) => {
            const capture = { ...item, stdout: sanitize(item.stdout), complete: true };
            completed.set(item.command, capture);
            const kind =
              item.command === 'display mpls ldp'
                ? 'ldp'
                : item.command === 'display ip interface brief'
                  ? 'brief'
                  : item.command === commands[3]
                    ? 'vsi'
                    : item.command.startsWith('display interface ')
                      ? 'ac'
                      : null;
            if (kind) result.captures[kind] = capture;
            observed({
              ...capture,
              durationMs: Date.now() - commandStarted,
              sha256: createHash('sha256').update(capture.stdout).digest('hex'),
            });
          },
          interfaceAfterVsi: (capture) => {
            if (capture.command !== commands[3]) return null;
            const facts = observeVsi(
              { ...capture, complete: true },
              vsiName,
              profile.expectedPrompt,
            );
            if (!facts || facts.attachments.length !== 1) throw new Error('AC_NOT_PROVEN');
            const next = vsiCommand({
              kind: 'INTERFACE',
              argument: facts.attachments[0]!.interfaceName,
            });
            allowed.push(next);
            expected.push(next);
            return next;
          },
        },
      });
      await client.execute(profile.endpoint, commands);
      if (count !== 6 || Object.keys(result.captures).length !== 4)
        throw new Error('SSH_DIAGNOSTIC_INCOMPLETE');
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
