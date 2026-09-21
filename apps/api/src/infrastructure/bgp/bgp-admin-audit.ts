import type { BgpAdminAction, BgpAddressFamily } from '@gmj/shared';

/**
 * Auditable administrative BGP action. Only safe metadata is stored: never
 * credentials, SSH context commands or raw CLI output.
 */
export interface BgpAdminAuditEntry {
  peerId: string;
  deviceId: string;
  userId: string | null;
  username: string | null;
  peerAddress: string;
  addressFamily: BgpAddressFamily;
  localAs: bigint | null;
  remoteAs: bigint | null;
  action: BgpAdminAction;
  success: boolean;
  verified: boolean;
  errorSafe: string | null;
  startedAt: Date;
  completedAt: Date;
}

export interface BgpAdminAuditRepository {
  record(entry: BgpAdminAuditEntry): Promise<void>;
}

/** In-memory audit sink used by demo mode and by tests. */
export class InMemoryBgpAdminAuditRepository implements BgpAdminAuditRepository {
  readonly entries: BgpAdminAuditEntry[] = [];

  async record(entry: BgpAdminAuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
