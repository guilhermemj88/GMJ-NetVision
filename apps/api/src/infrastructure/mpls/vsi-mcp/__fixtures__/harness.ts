import { createHash } from 'node:crypto';
import type { HostRecord } from '@gmj/shared';
import { safeVsiMcpCommand, type VsiMcpOperation } from '../command-policy';
import { resolveCapability, classifyHuaweiVersion, type HuaweiFamily } from '../platform';
import type { LiveSessionResult, VsiMcpLiveCollector } from '../live-collector';
import * as S from './synthetic';

export const host = (id: string, name: string): HostRecord =>
  ({
    id, name, vendor: 'Huawei', sshEnabled: true,
    ssh: { host: id === 'h-a' ? '10.100.1.1' : '10.100.1.2', port: 2222, username: 'svc', contextCommand: null, credentialConfigured: true },
  }) as unknown as HostRecord;

/** Coletor falso que aplica a MESMA politica/matriz que o real. */
export function fakeCollector(outputs: Record<string, Record<string, string>>, family: HuaweiFamily = 'NE8000_V800') {
  const sessions: Array<{ hostId: string; commands: string[] }> = [];
  const collector: VsiMcpLiveCollector = {
    async collect(h, operations, opts) {
      const planned: VsiMcpOperation[] = [{ kind: 'VERSION' }, ...operations];
      const captures: LiveSessionResult['captures'] = [];
      const skipped: LiveSessionResult['skipped'] = [];
      const sent: string[] = [];
      for (const operation of planned) {
        const d = resolveCapability(family, operation.kind, opts.homologation === true);
        if (!d.allowed) {
          skipped.push({ operation, reason: d.reason === 'NOT_SUPPORTED' ? 'NOT_SUPPORTED' : 'CANDIDATE_NOT_HOMOLOGATED', note: d.note });
          continue;
        }
        const command = safeVsiMcpCommand(operation);
        opts.audit(command);
        sent.push(command);
        const stdout = outputs[h.id]?.[command] ?? `<${h.name}>${command}\nError: Unrecognized command\n<${h.name}>`;
        captures.push({ operation, command, stdout, completedAt: '2026-11-09T12:00:00.000Z', durationMs: 5, sha256: createHash('sha256').update(stdout).digest('hex'), complete: stdout.trimEnd().endsWith('>') });
      }
      sessions.push({ hostId: h.id, commands: sent });
      return { platform: classifyHuaweiVersion(S.NE_VERSION), prompt: `<${h.name}>`, captures, skipped };
    },
  };
  return { collector, sessions };
}

