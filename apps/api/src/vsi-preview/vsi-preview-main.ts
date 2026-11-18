import { readVsiMcpProfiles, type VsiMcpAccessProfile } from '../infrastructure/mpls/vsi-mcp/access-profile';
import { evaluateHost, type ConformityReport } from './conformity';
import { forbiddenEnvNames, parsePreviewConfig, PreviewConfigError, type PreviewConfig } from './config';
import { installLifecycle } from './lifecycle';
import { narrowPreviewDb, PrismaConformityReader, SyntheticConformityReader, sanitizeDbError, type ConformityReader, type PreviewDb } from './reader';
import { SYNTHETIC_CREDENTIALS, SYNTHETIC_DEVICES, SYNTHETIC_PROFILES } from './synthetic';

/**
 * PREVIEW MINIMO DE CONFORMIDADE (VSI/SSH). Processo de EXECUCAO UNICA, independente da API:
 *   - nao sobe servidor HTTP, nao abre porta, nao tem login nem sessao;
 *   - nao importa mitigacao, worker, poller, observador, lease, SNMP, cliente SSH, rotas nem cofre;
 *   - nao tem bootstrap: nada e criado, gravado ou agendado;
 *   - le SOMENTE metadados de Device e SshCredential (colunas fixas), nunca o payload cifrado;
 *   - nao decifra: nao conhece a chave (ambiente com CREDENTIAL_ENCRYPTION_KEY e recusado);
 *   - termina sozinho (limite de tempo + watchdog) e anuncia o encerramento numa linha final.
 * Saida: relatorio JSON sanitizado em stdout (booleanos, contagens e datas; nenhum usuario, IP ou segredo).
 *
 * Codigos de saida: 0 relatorio produzido; 2 configuracao/ambiente recusados; 3 sem perfis; 4 falha na fonte de dados;
 * 124 limite de tempo; 143 SIGTERM.
 */

export interface PreviewDeps {
  now?: () => number;
  emit: (line: Record<string, unknown>) => void;
  readProfiles?: (file: string | undefined) => Promise<VsiMcpAccessProfile[]>;
  createReader?: (config: PreviewConfig) => Promise<ConformityReader>;
}

export interface PreviewOutcome {
  code: number;
  reason: string;
}

async function defaultReader(config: PreviewConfig): Promise<ConformityReader> {
  if (config.source === 'synthetic') return new SyntheticConformityReader(SYNTHETIC_DEVICES, SYNTHETIC_CREDENTIALS);
  // Importado so no modo database: o modo sintetico nao carrega o cliente de banco. A URL ja foi validada (conta dedicada).
  const { PrismaClient } = await import('../generated/prisma');
  if (!config.databaseUrl) throw new PreviewConfigError('NETVISION_PREVIEW_DATABASE_URL ausente');
  const client = new PrismaClient({ datasourceUrl: config.databaseUrl, log: [] });
  return new PrismaConformityReader(narrowPreviewDb(client as unknown as PreviewDb));
}

export async function runPreview(env: NodeJS.ProcessEnv, deps: PreviewDeps): Promise<PreviewOutcome> {
  const now = deps.now ?? Date.now;
  const forbidden = forbiddenEnvNames(env);
  if (forbidden.length > 0) {
    deps.emit({ preview: 'FAILED', reason: 'FORBIDDEN_ENVIRONMENT', variables: forbidden }); // so os NOMES
    return { code: 2, reason: 'FORBIDDEN_ENVIRONMENT' };
  }

  let config: PreviewConfig;
  try {
    config = parsePreviewConfig(env);
  } catch (error) {
    deps.emit({ preview: 'FAILED', reason: 'INVALID_CONFIGURATION', detail: error instanceof PreviewConfigError ? error.reason : 'invalida' });
    return { code: 2, reason: 'INVALID_CONFIGURATION' };
  }

  const profiles =
    config.source === 'synthetic' && !config.profileFile
      ? SYNTHETIC_PROFILES
      : await (deps.readProfiles ?? readVsiMcpProfiles)(config.profileFile);
  if (profiles.length === 0) {
    deps.emit({ preview: 'FAILED', reason: 'NO_PROFILES' });
    return { code: 3, reason: 'NO_PROFILES' };
  }

  let reader: ConformityReader | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async (): Promise<ConformityReport> => {
      reader = await (deps.createReader ?? defaultReader)(config);
      const hostIds = [...new Set(profiles.map((p) => p.hostId))];
      const devices = await reader.readDevices(hostIds);
      const credentialIds = [...new Set(devices.map((d) => d.sshCredentialId).filter((id): id is string => id !== null))];
      const credentials = credentialIds.length ? await reader.readCredentials(credentialIds) : [];
      const at = now();
      const hosts = profiles.map((profile) => {
        const device = devices.find((d) => d.id === profile.hostId) ?? null;
        const credential = credentials.find((c) => c.id === device?.sshCredentialId) ?? null;
        return evaluateHost(profile, device, credential, at);
      });
      const conforme = hosts.filter((h) => h.verdict === 'CONFORME').length;
      return {
        preview: 'REPORT', schemaVersion: 1, generatedAt: new Date(at).toISOString(), dataSource: config.source,
        guarantees: { decrypts: false, readsEncryptedPayload: false, writes: false, opensSsh: false },
        reader: reader.stats(),
        summary: { hosts: hosts.length, conforme, naoConforme: hosts.length - conforme },
        hosts,
      };
    })();
    const limit = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('PREVIEW_TIMEOUT')), config.maxSeconds * 1000);
    });
    const report = await Promise.race([work, limit]);
    deps.emit(report as unknown as Record<string, unknown>);
    return { code: 0, reason: 'DONE' };
  } catch (error) {
    if (error instanceof Error && error.message === 'PREVIEW_TIMEOUT') {
      deps.emit({ preview: 'FAILED', reason: 'TIMEOUT' });
      return { code: 124, reason: 'TIMEOUT' };
    }
    const sanitized = sanitizeDbError(error); // so um codigo fixo; nunca a mensagem original
    deps.emit({ preview: 'FAILED', reason: sanitized.code });
    return { code: 4, reason: sanitized.code };
  } finally {
    if (timer) clearTimeout(timer);
    await reader?.close();
  }
}

/** Ponto de entrada: relatorio em stdout, linha final de encerramento e saida com codigo. */
async function main(): Promise<void> {
  const emit = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(line)}
`);
  // O limite pedido e aplicado aqui tambem (mesma regra de parsePreviewConfig) para o watchdog nunca depender de configuracao valida.
  const requested = Number(process.env.NETVISION_PREVIEW_MAX_SECONDS ?? 60);
  const maxSeconds = Number.isFinite(requested) ? Math.min(80, Math.max(5, Math.trunc(requested))) : 60;
  const life = installLifecycle({ host: process, emit, exit: (code) => process.exit(code) }, maxSeconds);
  const outcome = await runPreview(process.env, { emit });
  life.finish(outcome.code, outcome.reason);
}

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  void main();
}
