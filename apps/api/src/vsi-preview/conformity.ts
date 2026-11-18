import type { VsiMcpAccessProfile } from '../infrastructure/mpls/vsi-mcp/access-profile';

/**
 * Conformidade de CADASTRO: compara o perfil de acesso VSI (DEV) com o que o NetVision tem cadastrado para o
 * equipamento, usando SOMENTE metadados. Nao decifra nada e nao conhece o segredo: o relatorio so tem booleanos,
 * contagens e datas. Nao inclui usuario, IP, fingerprint nem qualquer valor de credencial.
 */

export interface DeviceMetadata {
  id: string;
  name: string;
  vendor: string | null;
  sshEnabled: boolean;
  sshHost: string | null;
  sshPort: number;
  sshUsername: string | null;
  sshContextCommand: string | null;
  sshCredentialId: string | null;
}

export interface CredentialMetadata {
  id: string;
  port: number;
  username: string;
  updatedAt: Date;
  /** Quantos equipamentos apontam para este registro (informa o risco de compartilhamento). */
  sharedByDevices: number;
}

export const CONFORMITY_CHECKS = [
  'DEVICE_REGISTERED',
  'SSH_ENABLED',
  'VENDOR_HUAWEI',
  'ENDPOINT_MATCHES',
  'PORT_MATCHES',
  'USERNAME_MATCHES',
  'CONTEXT_MATCHES',
  'CREDENTIAL_REGISTERED',
  'CREDENTIAL_RECORD_FOUND',
  'CREDENTIAL_IDENTITY_CONSISTENT',
  'PROFILE_VALID_NOW',
  'FINGERPRINT_PINNED',
] as const;
export type ConformityCheck = (typeof CONFORMITY_CHECKS)[number];

export interface HostConformity {
  hostId: string;
  hostName: string | null;
  checks: Record<ConformityCheck, boolean>;
  failed: ConformityCheck[];
  credential: { registered: boolean; ageDays: number | null; sharedByDevices: number | null };
  profileExpiresAt: string;
  verdict: 'CONFORME' | 'NAO_CONFORME';
}

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

export function evaluateHost(
  profile: VsiMcpAccessProfile,
  device: DeviceMetadata | null,
  credential: CredentialMetadata | null,
  now: number,
): HostConformity {
  const registered = device?.sshCredentialId != null;
  const checks: Record<ConformityCheck, boolean> = {
    DEVICE_REGISTERED: device !== null,
    SSH_ENABLED: device?.sshEnabled === true,
    VENDOR_HUAWEI:
      device !== null && (device.vendor === null || /^(?:generic|unknown|n\/d)$/i.test(device.vendor) || /huawei/i.test(device.vendor)),
    ENDPOINT_MATCHES: device?.sshHost === profile.endpoint,
    PORT_MATCHES: device?.sshPort === profile.port,
    USERNAME_MATCHES: device?.sshUsername === profile.username,
    CONTEXT_MATCHES: device !== null && (device.sshContextCommand ?? null) === profile.context,
    CREDENTIAL_REGISTERED: registered,
    CREDENTIAL_RECORD_FOUND: registered && credential !== null && credential.id === device?.sshCredentialId,
    CREDENTIAL_IDENTITY_CONSISTENT:
      credential !== null && device !== null && credential.username === device.sshUsername && credential.port === device.sshPort,
    PROFILE_VALID_NOW: Date.parse(profile.validFrom) <= now && Date.parse(profile.expiresAt) > now,
    FINGERPRINT_PINNED: FINGERPRINT.test(profile.fingerprint),
  };
  const failed = CONFORMITY_CHECKS.filter((c) => !checks[c]);
  return {
    hostId: profile.hostId,
    hostName: device?.name ?? null,
    checks,
    failed,
    credential: {
      registered,
      ageDays: credential ? Math.max(0, Math.floor((now - credential.updatedAt.getTime()) / 86_400_000)) : null,
      sharedByDevices: credential ? credential.sharedByDevices : null,
    },
    profileExpiresAt: profile.expiresAt,
    verdict: failed.length === 0 ? 'CONFORME' : 'NAO_CONFORME',
  };
}

export interface ConformityReport {
  preview: 'REPORT';
  schemaVersion: 1;
  generatedAt: string;
  dataSource: 'synthetic' | 'database';
  /** Contrato fixo: este processo nunca descriptografa nem le o payload cifrado. */
  guarantees: { decrypts: false; readsEncryptedPayload: false; writes: false; opensSsh: false };
  reader: { deviceQueries: number; credentialQueries: number; countQueries: number };
  summary: { hosts: number; conforme: number; naoConforme: number };
  hosts: HostConformity[];
}
