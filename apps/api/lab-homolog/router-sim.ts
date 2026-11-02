import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { HostRecord } from '@gmj/shared';
import type { MitigationSshPort } from '../src/infrastructure/bgp/mitigation/huawei-mitigation-executor';

/**
 * Simulador de equipamento Huawei (VRP8) — LABORATORIO.
 *
 * A configuracao fica FORA do processo da API (arquivo JSON), exatamente como o
 * roteador guarda a configuracao fora da API: um restart da API nao altera o
 * estado do equipamento. Sem rede, sem credenciais, sem Huawei real.
 */

export interface SimNode {
  node: number;
  action: 'permit' | 'deny';
  ifMatch: string[];
  applies: string[];
}

export interface SimDevice {
  policyName: string;
  nodes: SimNode[];
  /** Prova de que o `commit` foi aplicado (nunca apos erro de CLI). */
  commits: number;
}

const PREFIX_LISTS = [
  'ip ip-prefix BOGONS index 10 permit 10.0.0.0 8',
  'ip ip-prefix PREFIX8to24 index 10 permit 0.0.0.0 0 greater-equal 8 less-equal 24',
].join('\n');

export function seedDevice(policyName: string): SimDevice {
  return {
    policyName,
    nodes: [
      {
        node: 10,
        action: 'permit',
        ifMatch: ['PREFIX8to24'],
        applies: ['apply local-preference 1100', 'apply extcommunity rt 268568:140 additive'],
      },
      { node: 1000, action: 'deny', ifMatch: [], applies: [] },
    ],
    commits: 0,
  };
}

export type SimFault = 'none' | 'reject-node2' | 'unreachable';

export class SimulatedRouter implements MitigationSshPort {
  private readonly writes: string[][] = [];

  constructor(
    private readonly statePath: string,
    private readonly fault: SimFault = 'none',
  ) {}

  static reset(statePath: string, policyName: string): void {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(seedDevice(policyName), null, 2), 'utf8');
  }

  get appliedCommands(): string[][] {
    return this.writes;
  }

  private read(): SimDevice {
    if (!existsSync(this.statePath)) throw new Error('SIM: estado do equipamento inexistente');
    return JSON.parse(readFileSync(this.statePath, 'utf8')) as SimDevice;
  }

  private write(state: SimDevice): void {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  /** Formato de CONFIGURACAO (`display current-configuration`). */
  renderConfig(state: SimDevice): string {
    const lines: string[] = [];
    for (const node of [...state.nodes].sort((a, b) => a.node - b.node)) {
      lines.push(`route-policy ${state.policyName} ${node.action} node ${node.node}`);
      for (const clause of node.ifMatch) lines.push(` if-match ip-prefix ${clause}`);
      for (const clause of node.applies) lines.push(` ${clause}`);
    }
    return lines.join('\n');
  }

  async readMitigationConfiguration(_device: HostRecord) {
    if (this.fault === 'unreachable') throw new Error('SIM: SSH inalcancavel');
    const state = this.read();
    return {
      routePolicyConfiguration: this.renderConfig(state),
      prefixListConfiguration: PREFIX_LISTS,
      warnings: [] as string[],
    };
  }

  async readMitigationRoutePolicy(_device: HostRecord, _policy: string): Promise<string> {
    if (this.fault === 'unreachable') throw new Error('SIM: SSH inalcancavel');
    return this.renderConfig(this.read());
  }

  /**
   * Aplica a lista canonica como o VRP: erro em qualquer comando impede o
   * `commit` — a candidata NAO e aplicada.
   */
  async applyMitigationCommands(
    _device: HostRecord,
    commands: readonly string[],
  ): Promise<{ ok: boolean; output: string | null }> {
    if (this.fault === 'unreachable') throw new Error('SIM: SSH caiu durante a escrita');
    this.writes.push([...commands]);
    const state = this.read();
    const pending = state.nodes.map((node) => ({ ...node, ifMatch: [...node.ifMatch], applies: [...node.applies] }));
    let error: string | null = null;

    for (const raw of commands) {
      const line = raw.trim().replace(/\s+/g, ' ');
      if (line === 'system-view' || line === 'commit' || line === 'return' || line === 'quit')
        continue;
      const undo = /^undo route-policy (\S+) node (\d+)$/.exec(line);
      if (undo) {
        const index = pending.findIndex((node) => node.node === Number(undo[2]));
        if (index < 0) error = `Error: The specified node ${undo[2]} does not exist.`;
        else pending.splice(index, 1);
        continue;
      }
      const header = /^route-policy (\S+) (permit|deny) node (\d+)$/.exec(line);
      if (header) {
        if (this.fault === 'reject-node2' && Number(header[3]) === 2) {
          error = 'Error: Unrecognized command found at "^" position.';
          continue;
        }
        const node: SimNode = {
          node: Number(header[3]),
          action: header[2] as 'permit' | 'deny',
          ifMatch: [],
          applies: [],
        };
        const existing = pending.findIndex((entry) => entry.node === node.node);
        if (existing >= 0) pending[existing] = node;
        else pending.push(node);
        continue;
      }
      const last = pending[pending.length - 1];
      if (!last) {
        error = 'Error: Unrecognized command found at "^" position.';
        continue;
      }
      const prefix = /^if-match ip-prefix (\S+)$/.exec(line);
      if (prefix) last.ifMatch.push(prefix[1]!);
      else if (/^(apply|goto)\b/.test(line)) last.applies.push(line);
      else error = 'Error: Unrecognized command found at "^" position.';
    }

    if (error !== null) {
      // Candidata descartada, como no VRP. O dispositivo NAO muda.
      this.write(state);
      return { ok: false, output: `${error}\n` };
    }
    state.nodes = pending;
    if (commands.some((command) => command.trim() === 'commit')) state.commits += 1;
    this.write(state);
    return { ok: true, output: 'simulated transport: committed' };
  }
}
