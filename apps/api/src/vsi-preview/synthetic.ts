import { vsiMcpProfileSchema, type VsiMcpAccessProfile } from '../infrastructure/mpls/vsi-mcp/access-profile';
import type { DeviceMetadata } from './conformity';

/** Dados 100% sinteticos para exercitar o preview sem banco: um equipamento conforme e tres com divergencias. */
const base = (hostId: string, endpoint: string, username: string) =>
  vsiMcpProfileSchema.parse({
    hostId, endpoint, port: 2222, username, context: null, fingerprint: 'SHA256:' + 'A'.repeat(43),
    initialPrompt: '<SYN>', expectedPrompt: '<SYN>', vendor: 'HUAWEI', family: 'S6730_V200', disablePagingTemporary: true,
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', operations: ['VERSION', 'VSI_VERBOSE'],
  });

export const SYNTHETIC_PROFILES: VsiMcpAccessProfile[] = [
  base('syn-ok', '10.255.0.1', 'svc-a'),
  base('syn-usuario-diverge', '10.255.0.2', 'svc-b'),
  base('syn-sem-credencial', '10.255.0.3', 'svc-c'),
  base('syn-nao-cadastrado', '10.255.0.4', 'svc-d'),
];

const device = (over: Partial<DeviceMetadata> & Pick<DeviceMetadata, 'id' | 'name'>): DeviceMetadata => ({
  vendor: 'Huawei', sshEnabled: true, sshHost: null, sshPort: 2222, sshUsername: null, sshContextCommand: null, sshCredentialId: null, ...over,
});

export const SYNTHETIC_DEVICES: DeviceMetadata[] = [
  device({ id: 'syn-ok', name: 'SYN-OK', sshHost: '10.255.0.1', sshUsername: 'svc-a', sshCredentialId: 'cred-ok' }),
  device({ id: 'syn-usuario-diverge', name: 'SYN-USUARIO', sshHost: '10.255.0.2', sshUsername: 'outro-usuario', sshCredentialId: 'cred-usuario' }),
  device({ id: 'syn-sem-credencial', name: 'SYN-SEM-CRED', sshHost: '10.255.0.3', sshUsername: 'svc-c', sshCredentialId: null }),
];

export const SYNTHETIC_CREDENTIALS = [
  { id: 'cred-ok', port: 2222, username: 'svc-a', updatedAt: new Date('2026-10-01T00:00:00.000Z') },
  { id: 'cred-usuario', port: 2222, username: 'outro-usuario', updatedAt: new Date('2026-11-10T00:00:00.000Z') },
];
