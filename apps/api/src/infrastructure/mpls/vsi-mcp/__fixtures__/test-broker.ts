import { createHash } from 'node:crypto';
import type { HostRecord } from '@gmj/shared';
import { checkVsiMcpScope, matchVsiMcpProfile, type VsiMcpAccessProfile } from '../access-profile';
import type { VsiMcpOperation } from '../command-policy';
import { SshCredentialBrokerError, type SshConnection, type SshCredentialBrokerPort } from '../ssh-credential-broker';

/**
 * SOMENTE PARA TESTES do coletor (parsing, escopo, cadencia): resolve o perfil como o broker real, mas entrega a
 * senha sintetica do duble de host SEM grant, aprovacao nem teto por escopo. NUNCA importar em codigo de producao;
 * as garantias reais do broker sao testadas em `ssh-credential-broker.test.ts` e `.integration.test.ts`.
 */
export function testBroker(
  hosts: {
    getHost: (hostId: string) => Promise<HostRecord | null>;
    getDecryptedSshCredentials: (hostId: string) => Promise<{ password?: string } | null>;
  },
  profiles: readonly VsiMcpAccessProfile[],
): SshCredentialBrokerPort {
  const connect = async (hostId: string, operations: readonly VsiMcpOperation[]): Promise<SshConnection> => {
    const host = await hosts.getHost(hostId);
    if (!host) throw new SshCredentialBrokerError('HOST_NOT_FOUND');
    const profile = matchVsiMcpProfile(profiles, host, ['VERSION', ...operations.map((o) => o.kind)]);
    checkVsiMcpScope(profile, operations);
    return Object.freeze({
      endpoint: profile.endpoint, port: profile.port, username: profile.username, context: profile.context,
      fingerprint: profile.fingerprint, profile,
      digest: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
    });
  };
  return {
    async preflight(request) {
      return connect(request.hostId, request.plan.operations);
    },
    async withCredential(request, use) {
      const connection = await connect(request.hostId, request.plan.operations);
      const credentials = await hosts.getDecryptedSshCredentials(request.hostId);
      if (!credentials?.password) throw new SshCredentialBrokerError('CREDENTIAL_UNAVAILABLE');
      return use({ password: credentials.password }, connection);
    },
  };
}
