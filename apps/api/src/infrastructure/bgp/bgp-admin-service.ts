import type {
  AuthUser,
  BgpAdminAction,
  BgpAdminState,
  BgpPeerAdminStateResponse,
} from '@gmj/shared';
import { ipAddressFamily } from '@gmj/shared';
import type { BgpAdminAuditRepository } from './bgp-admin-audit';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import type { HostRepository } from '../persistence/host-repository';

export class BgpAdminActionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'BgpAdminActionError';
  }
}

export interface BgpAdminDependencies {
  bgp: BgpRepository;
  hosts: HostRepository;
  ssh: HuaweiBgpSshService;
  audit: BgpAdminAuditRepository;
  now?: () => Date;
}

export interface BgpAdminRequest {
  peerId: string;
  action: BgpAdminAction;
  user: AuthUser | null;
}

const ACTION_LABEL: Record<BgpAdminAction, string> = {
  DISABLE: 'desativação',
  ENABLE: 'reabilitação',
};
const EXPECTED_STATE: Record<BgpAdminAction, BgpAdminState> = {
  DISABLE: 'IGNORED',
  ENABLE: 'ENABLED',
};

function safeError(error: unknown): string {
  if (error instanceof BgpAdminActionError) return error.message;
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return 'Falha ao executar a ação administrativa';
}

/**
 * Administrative BGP peer actions (`peer <addr> ignore` / `undo peer ...`).
 *
 * Everything the CLI needs is resolved from the persisted peer: the frontend
 * only sends the action. A human confirmation is required in the UI, and the
 * result is only reported as success after a read-only read-back confirms the
 * new administrative state. Every attempt is audited without secrets.
 */
export class BgpAdminService {
  constructor(private readonly dependencies: BgpAdminDependencies) {}

  async execute(request: BgpAdminRequest): Promise<BgpPeerAdminStateResponse> {
    const now = this.dependencies.now ?? (() => new Date());
    const startedAt = now();
    const peer = await this.dependencies.bgp.getPeerDetail(request.peerId);
    if (!peer) throw new BgpAdminActionError('Peer BGP não encontrado', 404);

    const host = await this.dependencies.hosts.getHost(peer.deviceId);
    if (!host) throw new BgpAdminActionError('Equipamento não encontrado', 404);

    // The stored address must be valid for the stored family; the request never
    // carries an address, so this also blocks corrupted rows.
    const family = ipAddressFamily(peer.peerAddress);
    if (family === null || family !== peer.addressFamily) {
      throw new BgpAdminActionError(
        'Endereço do peer é inválido para a família persistida; execute o discovery novamente.',
        409,
      );
    }
    if (!host.sshEnabled || !host.ssh?.host || !host.ssh.username) {
      throw new BgpAdminActionError('SSH não está habilitado para este equipamento', 409);
    }
    const localAs = await this.dependencies.bgp.getDeviceLocalAs(host.id);
    if (localAs === null) {
      throw new BgpAdminActionError(
        'ASN local do processo BGP ainda não foi identificado. Execute "Atualizar agora" para fazer o discovery SSH.',
        409,
      );
    }

    const remoteAs = peer.remoteAs === null ? null : BigInt(peer.remoteAs);
    let cliError: string | null = null;
    try {
      const applied = await this.dependencies.ssh.applyAdminState(host, {
        peerAddress: peer.peerAddress,
        localAs,
        action: request.action,
      });
      if (!applied.success) cliError = applied.errorSafe ?? 'SSH command failed';
    } catch (error) {
      cliError = safeError(error);
    }

    // Read-back is mandatory: state is only persisted when the device confirms it.
    let adminState: BgpAdminState = 'UNKNOWN';
    try {
      const reading = await this.dependencies.ssh.readAdminState(host, {
        peerAddress: peer.peerAddress,
        addressFamily: peer.addressFamily,
      });
      adminState = reading.state;
    } catch {
      adminState = 'UNKNOWN';
    }

    const completedAt = now();
    const verified = adminState !== 'UNKNOWN';
    if (verified) {
      await this.dependencies.bgp.setPeerAdminState(peer.id, adminState, completedAt);
    }
    const success = cliError === null && adminState === EXPECTED_STATE[request.action];

    const message = this.buildMessage(request.action, success, verified, adminState, cliError);
    const response: BgpPeerAdminStateResponse = {
      peerId: peer.id,
      deviceId: peer.deviceId,
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily,
      action: request.action,
      success,
      adminState,
      verified,
      message,
      executedAt: completedAt.toISOString(),
    };

    await this.dependencies.audit.record({
      peerId: peer.id,
      deviceId: peer.deviceId,
      userId: request.user?.id ?? null,
      username: request.user?.username ?? null,
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily,
      localAs,
      remoteAs,
      action: request.action,
      success,
      verified,
      errorSafe: cliError,
      startedAt,
      completedAt,
    });

    return response;
  }

  private buildMessage(
    action: BgpAdminAction,
    success: boolean,
    verified: boolean,
    adminState: BgpAdminState,
    cliError: string | null,
  ): string {
    const expected = EXPECTED_STATE[action];
    if (success) {
      return action === 'DISABLE'
        ? 'Sessão BGP desabilitada e confirmada por read-back (ADMIN: IGNORADO).'
        : 'Sessão BGP reabilitada e confirmada por read-back (ADMIN: HABILITADO).';
    }
    if (!verified) {
      return cliError === null
        ? `Comando executado, mas o read-back não pôde confirmar o estado administrativo da ${ACTION_LABEL[action]}.`
        : `Falha na ${ACTION_LABEL[action]} (${cliError}) e read-back inconclusivo.`;
    }
    if (adminState === expected) {
      return `O comando reportou erro (${cliError ?? 'SSH command failed'}), mas o read-back confirmou ADMIN: ${
        adminState === 'IGNORED' ? 'IGNORADO' : 'HABILITADO'
      }.`;
    }
    return cliError === null
      ? `O read-back não confirmou a ${ACTION_LABEL[action]} (ADMIN: ${
          adminState === 'IGNORED' ? 'IGNORADO' : 'HABILITADO'
        }).`
      : `Falha na ${ACTION_LABEL[action]}: ${cliError}.`;
  }
}
