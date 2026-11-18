import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { VsiDiagnosticError } from './vsi-diagnostic-service';

export const VSI_APPROVAL_DEFAULT_TTL_SECONDS = 600;
export const VSI_APPROVAL_MAX_TTL_SECONDS = 900;
export const VSI_APPROVAL_MIN_TTL_SECONDS = 30;

const approvalSchema = z
  .object({
    approvalId: z.uuid(),
    hostId: z.string().min(1).max(100),
    vsiId: z.string().min(1).max(100),
    createdBy: z.string().min(1).max(200),
    createdAt: z.string().min(20).max(40),
    expiresAt: z.string().min(20).max(40),
  })
  .strict();

export type VsiDiagnosticApproval = z.infer<typeof approvalSchema>;

export function vsiApprovalDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.VSI_DIAGNOSTIC_APPROVAL_DIR ?? '').trim();
  return configured || '/etc/netvision/vsi-diagnostic-approvals';
}

function approvalRequired(message = 'Aprovacao de diagnostico ausente, expirada ou ja utilizada'): VsiDiagnosticError {
  return new VsiDiagnosticError(message, 423);
}

/**
 * Aprovacao ONE-SHOT por execucao. O consumo e atomico (`openSync('wx')`), portanto duas
 * requisicoes concorrentes nunca conseguem usar a mesma aprovacao.
 */
export class VsiDiagnosticApprovalStore {
  constructor(private readonly dir: string = vsiApprovalDir()) {}

  create(input: {
    hostId: string;
    vsiId: string;
    createdBy: string;
    ttlSeconds?: number | undefined;
    now?: number | undefined;
  }): VsiDiagnosticApproval {
    const ttl = Math.min(
      Math.max(Math.trunc(input.ttlSeconds ?? VSI_APPROVAL_DEFAULT_TTL_SECONDS), VSI_APPROVAL_MIN_TTL_SECONDS),
      VSI_APPROVAL_MAX_TTL_SECONDS,
    );
    const now = input.now ?? Date.now();
    const approval: VsiDiagnosticApproval = {
      approvalId: randomUUID(),
      hostId: input.hostId,
      vsiId: input.vsiId,
      createdBy: input.createdBy,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
    };
    this.ensureDir();
    const fd = openSync(join(this.dir, `${approval.approvalId}.json`), 'wx', 0o600);
    try {
      writeSync(fd, JSON.stringify(approval));
    } finally {
      closeSync(fd);
    }
    this.purge(now);
    return approval;
  }

  /**
   * Valida SEM consumir: existe, e do host/escopo, nao expirou, ainda nao foi usada e (se `executor`) nao foi criada por
   * ele. E o que se exige ANTES de qualquer acao quando a aprovacao tem de estar "previamente consumivel".
   */
  peek(
    approvalId: string | undefined,
    hostId: string,
    vsiId: string,
    now = Date.now(),
    executor?: string,
  ): VsiDiagnosticApproval {
    const approval = this.validate(approvalId, hostId, vsiId, now, executor);
    if (existsSync(join(this.dir, `${approval.approvalId}.consumed`))) throw approvalRequired('Aprovacao ja utilizada');
    return approval;
  }

  private validate(
    approvalId: string | undefined,
    hostId: string,
    vsiId: string,
    now: number,
    executor: string | undefined,
  ): VsiDiagnosticApproval {
    if (!approvalId) throw approvalRequired('Aprovacao one-shot obrigatoria para executar o diagnostico');
    const approval = this.read(approvalId);
    if (!approval) throw approvalRequired();
    if (approval.hostId !== hostId || approval.vsiId !== vsiId)
      throw approvalRequired('Aprovacao nao autoriza este host/VSI');
    if (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= now)
      throw approvalRequired('Aprovacao expirada');
    // ANTES de marcar como consumida: quem aprovou nao pode executar, e a aprovacao continua utilizavel por outro.
    if (executor !== undefined && executor === approval.createdBy)
      throw approvalRequired('Aprovacao nao pode ser usada por quem a criou');
    return approval;
  }

  consume(
    approvalId: string | undefined,
    hostId: string,
    vsiId: string,
    now = Date.now(),
    /** Identidade de quem EXECUTA. Se informada, nao pode ser quem criou a aprovacao (separacao de funcoes). */
    executor?: string,
  ): VsiDiagnosticApproval {
    const approval = this.validate(approvalId, hostId, vsiId, now, executor);
    try {
      closeSync(openSync(join(this.dir, `${approval.approvalId}.consumed`), 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw approvalRequired('Aprovacao ja utilizada');
      throw approvalRequired('Aprovacao indisponivel');
    }
    return approval;
  }

  private read(approvalId: string): VsiDiagnosticApproval | null {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(approvalId))
      throw approvalRequired();
    try {
      return approvalSchema.parse(JSON.parse(readFileSync(join(this.dir, `${approvalId}.json`), 'utf8')));
    } catch {
      return null;
    }
  }

  private ensureDir() {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      throw approvalRequired('Diretorio de aprovacoes indisponivel');
    }
  }

  /** Best-effort: remove aprovacoes expiradas ha mais de 24 h. Nunca bloqueia a criacao. */
  private purge(now: number) {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const approval = approvalSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
        if (Date.parse(approval.expiresAt) + 86_400_000 > now) continue;
        rmSync(join(this.dir, `${approval.approvalId}.consumed`), { force: true });
        rmSync(join(this.dir, name), { force: true });
      } catch {
        /* arquivo invalido ou ilegivel: nao remove */
      }
    }
  }
}
