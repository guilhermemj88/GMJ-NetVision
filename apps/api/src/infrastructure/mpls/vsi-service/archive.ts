import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { VsiServiceDiagnosis } from '@gmj/shared';

/**
 * ARQUIVO de resultados guardados (somente leitura): uma pasta com um JSON `VsiServiceDiagnosis` por
 * resultado, por exemplo a agregacao de uma homologacao (ver homolog-aggregate.test.ts).
 *
 * Esta classe SO LE DISCO. Nao executa diagnostico, nao abre SSH, nao grava nem apaga arquivo: abrir um
 * resultado guardado nunca dispara nova coleta. A pasta vem de `VSI_SERVICE_RESULTS_DIR`; sem ela, nada e lido.
 */
export const VSI_ARCHIVE_LIMITS = { files: 50, bytes: 2 * 1024 * 1024 } as const;
export const VSI_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;

function isDiagnosis(v: unknown): v is VsiServiceDiagnosis {
  if (v === null || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    d.schemaVersion === 1 &&
    typeof d.runId === 'string' &&
    VSI_RUN_ID.test(d.runId) &&
    typeof d.vsiName === 'string' &&
    typeof d.completedAt === 'string' &&
    typeof d.verdict === 'object' &&
    d.verdict !== null &&
    Array.isArray(d.endpoints) &&
    Array.isArray(d.findings) &&
    Array.isArray(d.evidence)
  );
}

/**
 * Diretorio de resultados RESTRITO e somente leitura para a aplicacao (fail-closed, so em sistemas POSIX):
 *  - a pasta e cada arquivo nao podem ser graváveis por grupo/outros (0o022) nem ser symlink;
 *  - dono: root ou o usuario do proprio processo (nunca de terceiros).
 * Violacao da pasta = o arquivo inteiro e ignorado (lista vazia); violacao de um arquivo = so ele e ignorado.
 */
export interface ArchiveOptions {
  /** padrao: so fora do Windows (la o modo POSIX nao existe) */
  enforceModes?: boolean;
  lstat?: (path: string) => Pick<Stats, 'isFile' | 'isDirectory' | 'isSymbolicLink' | 'size' | 'mode' | 'uid'>;
  uid?: number | null;
}

export class VsiServiceResultArchive {
  private readonly enforce: boolean;
  private readonly lstat: NonNullable<ArchiveOptions['lstat']>;
  private readonly uid: number | null;

  constructor(
    private readonly dir: string,
    options: ArchiveOptions = {},
  ) {
    this.enforce = options.enforceModes ?? process.platform !== 'win32';
    this.lstat = options.lstat ?? ((path) => lstatSync(path));
    this.uid = options.uid !== undefined ? options.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  }

  /** Motivo pelo qual um caminho nao e confiavel como fonte de resultados, ou null. */
  private untrusted(path: string, directory: boolean): string | null {
    if (!this.enforce) return null;
    const stat = this.lstat(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (directory ? !stat.isDirectory() : !stat.isFile()) return directory ? 'nao e diretorio' : 'nao e arquivo regular';
    if ((stat.mode & 0o022) !== 0) return 'gravavel por grupo/outros';
    if (stat.uid !== 0 && this.uid !== null && stat.uid !== this.uid) return 'dono inesperado';
    return null;
  }

  /** Auditoria (nao lanca): problemas que fariam a pasta ou algum arquivo ser ignorado. Usada pelo preflight da release. */
  audit(): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    try {
      const reason = this.untrusted(this.dir, true);
      if (reason) issues.push(`pasta: ${reason}`);
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.json')) {
          issues.push(`${name}: nao e um resultado (.json)`);
          continue;
        }
        const path = join(this.dir, name);
        const fileReason = this.untrusted(path, false);
        if (fileReason) {
          issues.push(`${name}: ${fileReason}`);
          continue;
        }
        try {
          if (!isDiagnosis(JSON.parse(readFileSync(path, 'utf8')))) issues.push(`${name}: nao e um resultado VSI valido`);
        } catch {
          issues.push(`${name}: JSON invalido`);
        }
      }
    } catch {
      issues.push('pasta ilegivel');
    }
    return { ok: issues.length === 0, issues };
  }

  /** Le a pasta a cada chamada (poucos arquivos pequenos): um resultado novo aparece sem reiniciar a API. */
  list(): VsiServiceDiagnosis[] {
    let names: string[];
    try {
      if (this.untrusted(this.dir, true) !== null) return [];
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort().slice(0, VSI_ARCHIVE_LIMITS.files);
    } catch {
      return [];
    }
    const out = new Map<string, VsiServiceDiagnosis>();
    for (const name of names) {
      try {
        const path = join(this.dir, name);
        const stat = lstatSync(path);
        // so arquivo regular (sem symlink), de tamanho limitado
        if (!stat.isFile() || stat.size > VSI_ARCHIVE_LIMITS.bytes || this.untrusted(path, false) !== null) continue;
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (isDiagnosis(parsed) && !out.has(parsed.runId)) out.set(parsed.runId, parsed);
      } catch {
        // arquivo ilegivel ou que nao e um resultado: ignorado, nunca derruba a listagem
      }
    }
    return [...out.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  }

  get(runId: string): VsiServiceDiagnosis | null {
    return this.list().find((d) => d.runId === runId) ?? null;
  }
}

export function vsiServiceResultArchive(env: NodeJS.ProcessEnv = process.env): VsiServiceResultArchive | null {
  const dir = (env.VSI_SERVICE_RESULTS_DIR ?? '').trim();
  return dir ? new VsiServiceResultArchive(dir) : null;
}
