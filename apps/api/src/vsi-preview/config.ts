/**
 * Configuracao do preview de conformidade. Fail-closed: qualquer ambiente que traga segredo ou recurso
 * operacional da producao faz o processo recusar a iniciar, ANTES de ler dados.
 *
 * O ambiente e uma LISTA DE PERMITIDOS (nao de proibidos): variavel desconhecida, com qualquer nome, recusa a
 * execucao. A lista de proibidos continua existindo so para nomear o motivo da recusa nos casos conhecidos.
 *
 * O preview nao usa DATABASE_URL (que e a conta dona/gravadora da producao): so aceita
 * NETVISION_PREVIEW_DATABASE_URL, e apenas para a conta dedicada e somente leitura (camada D), por socket Unix
 * ou loopback, lendo o schema `vsi_preview` (views com metadados).
 */

/** Variaveis que o processo pode ter. Qualquer outra recusa a execucao. */
export const ALLOWED_ENV_NAMES: ReadonlySet<string> = new Set([
  // processo/sistema operacional
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'TZ', 'PWD', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'TERM',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', // Windows (testes locais)
  'NODE_ENV', // NODE_OPTIONS e NODE_PATH NAO: poderiam injetar codigo
  // injetadas pelo systemd
  'INVOCATION_ID', 'JOURNAL_STREAM', 'SYSTEMD_EXEC_PID', 'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE', 'NOTIFY_SOCKET',
  // do preview
  'PRISMA_QUERY_ENGINE_LIBRARY', // caminho (somente leitura) da engine do Prisma para Linux
  'VSI_MCP_ACCESS_FILE', // arquivo de perfis de acesso (sem credencial)
]);
export const ALLOWED_ENV_PATTERNS: readonly RegExp[] = [/^LC_[A-Z_]+$/, /^NETVISION_PREVIEW_[A-Z_]+$/];

/** Nomes (nunca valores) com motivo conhecido de recusa; so para a mensagem. */
export const FORBIDDEN_ENV_PATTERNS: readonly RegExp[] = [
  /^CREDENTIAL_ENCRYPTION_KEY$/, // sem a chave o processo e incapaz de decifrar
  /^DATABASE_URL$/, // credencial de producao (dona/gravadora)
  /^MITIGATION_/, // mitigacao BGP, AUTO-ALL, fast-observer
  /^TELEGRAM/,
  /^ZABBIX_/,
  /^SNMP_/,
  /^VSI_MCP_ENABLED$/, // sem motor VSI e sem broker
  /^VSI_DIAGNOSTIC_/,
  /^VSI_SERVICE_/,
];

function isAllowedEnvName(name: string): boolean {
  const upper = name.toUpperCase(); // Windows nao diferencia maiusculas; no Linux os nomes permitidos ja sao maiusculos
  return ALLOWED_ENV_NAMES.has(upper) || ALLOWED_ENV_PATTERNS.some((p) => p.test(upper));
}

/** Nomes presentes no ambiente que NAO sao permitidos (ordenados). Nunca devolve valores. */
export function forbiddenEnvNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => env[name] !== undefined)
    .filter((name) => FORBIDDEN_ENV_PATTERNS.some((p) => p.test(name)) || !isAllowedEnvName(name))
    .sort();
}

/** Conta dedicada somente leitura: nome EXATO (sem sufixos). */
export const PREVIEW_ROLE = /^nvvsipreview$/;
export const PREVIEW_SCHEMA = 'vsi_preview';
const SAFE_URL_PARAMS = new Set(['host', 'schema', 'connection_limit', 'pool_timeout', 'connect_timeout', 'socket_timeout']);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '']);

export class PreviewConfigError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PreviewConfigError';
  }
}

export interface PreviewConfig {
  source: 'synthetic' | 'database';
  maxSeconds: number;
  profileFile: string | undefined;
  /** URL ja validada e endurecida (connection_limit=1, connect_timeout curto). Nunca e impressa. */
  databaseUrl: string | undefined;
}

/** Valida a URL do banco do preview sem jamais devolver ou registrar seu conteudo no erro. */
export function validatePreviewDatabaseUrl(raw: string | undefined): string {
  if (!raw) throw new PreviewConfigError('NETVISION_PREVIEW_DATABASE_URL ausente');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreviewConfigError('NETVISION_PREVIEW_DATABASE_URL invalida');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new PreviewConfigError('protocolo do banco invalido');
  if (!PREVIEW_ROLE.test(decodeURIComponent(url.username)))
    throw new PreviewConfigError('o banco do preview exige a conta dedicada somente leitura (nvvsipreview)');
  for (const key of url.searchParams.keys())
    if (!SAFE_URL_PARAMS.has(key)) throw new PreviewConfigError('parametro de conexao nao permitido');
  // O host da URL e SEMPRE local, tambem quando ha `host=` (socket): nada de apontar o nome para outra maquina.
  if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) throw new PreviewConfigError('o banco do preview so pode ser local (socket Unix ou loopback)');
  const socket = url.searchParams.get('host');
  if (socket !== null && !socket.startsWith('/')) throw new PreviewConfigError('host= so aceita diretorio de socket Unix');
  // Le somente as views dedicadas: sem `schema` (ou com outro) o Prisma leria `public`, que a conta nao pode ler.
  if (url.searchParams.get('schema') !== PREVIEW_SCHEMA) throw new PreviewConfigError(`a URL do banco exige schema=${PREVIEW_SCHEMA}`);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '5');
  url.searchParams.set('pool_timeout', '5');
  return url.toString();
}

export function parsePreviewConfig(env: NodeJS.ProcessEnv): PreviewConfig {
  const source = (env.NETVISION_PREVIEW_SOURCE ?? 'synthetic').trim().toLowerCase();
  if (source !== 'synthetic' && source !== 'database') throw new PreviewConfigError('NETVISION_PREVIEW_SOURCE invalida');
  const raw = Number(env.NETVISION_PREVIEW_MAX_SECONDS ?? 60);
  if (!Number.isFinite(raw)) throw new PreviewConfigError('NETVISION_PREVIEW_MAX_SECONDS invalida');
  // Teto de 80 s: abaixo do TimeoutStartSec=90 da unidade systemd (a unidade e a rede de seguranca final).
  const maxSeconds = Math.min(80, Math.max(5, Math.trunc(raw)));
  return {
    source,
    maxSeconds,
    profileFile: env.VSI_MCP_ACCESS_FILE?.trim() || undefined,
    databaseUrl: source === 'database' ? validatePreviewDatabaseUrl(env.NETVISION_PREVIEW_DATABASE_URL) : undefined,
  };
}
