import type { CredentialMetadata, DeviceMetadata } from './conformity';

/**
 * Leitor de metadados. O unico acesso ao banco do preview: duas consultas `findMany` com `select` fixo e uma
 * contagem por credencial. Nao ha SQL arbitrario, escrita, `queryRaw` nem leitura do payload cifrado.
 */

/** Colunas lidas de Device (lista fechada). */
export const DEVICE_SELECT = {
  id: true, name: true, vendor: true, sshEnabled: true, sshHost: true, sshPort: true, sshUsername: true,
  sshContextCommand: true, sshCredentialId: true,
} as const;

/** Colunas lidas de SshCredential (lista fechada; o payload cifrado NAO esta nela). */
export const CREDENTIAL_SELECT = { id: true, port: true, username: true, updatedAt: true } as const;

export const PREVIEW_MAX_HOSTS = 20;

export interface ReaderStats {
  deviceQueries: number;
  credentialQueries: number;
  countQueries: number;
}

export interface ConformityReader {
  readDevices(ids: readonly string[]): Promise<DeviceMetadata[]>;
  readCredentials(ids: readonly string[]): Promise<CredentialMetadata[]>;
  stats(): ReaderStats;
  close(): Promise<void>;
}

export class PreviewReaderError extends Error {
  constructor(readonly code: 'TOO_MANY_HOSTS' | 'DB_UNREACHABLE' | 'DB_AUTH' | 'DB_PERMISSION_DENIED' | 'DB_ERROR') {
    super(code);
    this.name = 'PreviewReaderError';
  }
}

/** Superficie minima que o leitor exige do cliente de banco (nao recebe o PrismaClient inteiro). */
export interface PreviewDb {
  device: {
    findMany(args: { where: { id: { in: string[] } }; select: typeof DEVICE_SELECT; take: number }): Promise<DeviceMetadata[]>;
    count(args: { where: { sshCredentialId: string } }): Promise<number>;
  };
  sshCredential: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: typeof CREDENTIAL_SELECT;
      take: number;
    }): Promise<Array<Omit<CredentialMetadata, 'sharedByDevices'>>>;
  };
  $disconnect(): Promise<void>;
}

/**
 * Fachada ESTREITA: so os tres metodos que o preview usa. O cliente completo do Prisma (com `$queryRaw`,
 * `$executeRaw`, escritas etc.) nao fica alcancavel a partir do leitor, nem por engano.
 */
export function narrowPreviewDb(client: PreviewDb): PreviewDb {
  return Object.freeze({
    device: Object.freeze({
      findMany: (args: Parameters<PreviewDb['device']['findMany']>[0]) => client.device.findMany(args),
      count: (args: Parameters<PreviewDb['device']['count']>[0]) => client.device.count(args),
    }),
    sshCredential: Object.freeze({
      findMany: (args: Parameters<PreviewDb['sshCredential']['findMany']>[0]) => client.sshCredential.findMany(args),
    }),
    $disconnect: () => client.$disconnect(),
  });
}

/** Converte qualquer erro do banco em um codigo fixo: a mensagem original (pode conter host/usuario) nunca sai. */
export function sanitizeDbError(error: unknown): PreviewReaderError {
  if (error instanceof PreviewReaderError) return error;
  const code = String((error as { code?: unknown })?.code ?? '');
  if (code === 'P1001' || code === 'P1002' || code === 'P1017') return new PreviewReaderError('DB_UNREACHABLE');
  if (code === 'P1000' || code === 'P1010') return new PreviewReaderError('DB_AUTH');
  if (code === 'P2010' || code === '42501' || /permission denied|insufficient privilege/i.test(String((error as Error)?.message ?? '')))
    return new PreviewReaderError('DB_PERMISSION_DENIED');
  return new PreviewReaderError('DB_ERROR');
}

export class PrismaConformityReader implements ConformityReader {
  private readonly counters: ReaderStats = { deviceQueries: 0, credentialQueries: 0, countQueries: 0 };
  constructor(private readonly db: PreviewDb) {}

  async readDevices(ids: readonly string[]): Promise<DeviceMetadata[]> {
    if (ids.length > PREVIEW_MAX_HOSTS) throw new PreviewReaderError('TOO_MANY_HOSTS');
    try {
      this.counters.deviceQueries += 1;
      return await this.db.device.findMany({ where: { id: { in: [...ids] } }, select: DEVICE_SELECT, take: PREVIEW_MAX_HOSTS });
    } catch (error) {
      throw sanitizeDbError(error);
    }
  }

  async readCredentials(ids: readonly string[]): Promise<CredentialMetadata[]> {
    if (ids.length > PREVIEW_MAX_HOSTS) throw new PreviewReaderError('TOO_MANY_HOSTS');
    try {
      this.counters.credentialQueries += 1;
      const rows = await this.db.sshCredential.findMany({
        where: { id: { in: [...ids] } },
        select: CREDENTIAL_SELECT,
        take: PREVIEW_MAX_HOSTS,
      });
      const out: CredentialMetadata[] = [];
      for (const row of rows) {
        this.counters.countQueries += 1;
        out.push({ ...row, sharedByDevices: await this.db.device.count({ where: { sshCredentialId: row.id } }) });
      }
      return out;
    } catch (error) {
      throw sanitizeDbError(error);
    }
  }

  stats(): ReaderStats {
    return { ...this.counters };
  }

  async close(): Promise<void> {
    try {
      await this.db.$disconnect();
    } catch {
      /* encerrar nunca deve mascarar o resultado */
    }
  }
}

/** Fonte sintetica: so memoria, nenhum banco. */
export class SyntheticConformityReader implements ConformityReader {
  private readonly counters: ReaderStats = { deviceQueries: 0, credentialQueries: 0, countQueries: 0 };
  constructor(
    private readonly devices: readonly DeviceMetadata[],
    private readonly credentials: ReadonlyArray<Omit<CredentialMetadata, 'sharedByDevices'>>,
  ) {}

  async readDevices(ids: readonly string[]): Promise<DeviceMetadata[]> {
    if (ids.length > PREVIEW_MAX_HOSTS) throw new PreviewReaderError('TOO_MANY_HOSTS');
    this.counters.deviceQueries += 1;
    return this.devices.filter((d) => ids.includes(d.id));
  }

  async readCredentials(ids: readonly string[]): Promise<CredentialMetadata[]> {
    if (ids.length > PREVIEW_MAX_HOSTS) throw new PreviewReaderError('TOO_MANY_HOSTS');
    this.counters.credentialQueries += 1;
    return this.credentials
      .filter((c) => ids.includes(c.id))
      .map((c) => {
        this.counters.countQueries += 1;
        return { ...c, sharedByDevices: this.devices.filter((d) => d.sshCredentialId === c.id).length };
      });
  }

  stats(): ReaderStats {
    return { ...this.counters };
  }

  async close(): Promise<void> {}
}
