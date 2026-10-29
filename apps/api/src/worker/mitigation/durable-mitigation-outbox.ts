import { randomUUID } from 'node:crypto';
import type {
  MitigationNotification,
  NotificationPublisher,
} from '../../infrastructure/bgp/mitigation/notification-publisher';
import type { AutomationStore, AutomationTx } from './automation-store';

export interface OutboxEntry {
  id: string;
  profileId: string | null;
  event: string;
  payload: Record<string, unknown>;
  state: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
  attempts: number;
  nextAt: number;
  lease: string | null;
  leaseUntil: number;
  deliveredAt: number | null;
  error: string | null;
}
export function encodeNotification(n: MitigationNotification): Record<string, unknown> {
  return JSON.parse(JSON.stringify(n, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
export function decodeNotification(n: Record<string, unknown>): MitigationNotification {
  const copy = { ...n };
  for (const key of [
    'detectedBandwidthBps',
    'bandwidthOverrideBps',
    'effectiveBandwidthBps',
    'trafficBps',
    'thresholdBps',
  ])
    if (copy[key] != null) copy[key] = BigInt(String(copy[key]));
  return copy as unknown as MitigationNotification;
}
export async function enqueueNotification(
  tx: AutomationTx,
  n: MitigationNotification,
  now: number,
): Promise<boolean> {
  if (!n.eventId) throw Error('DURABLE_EVENT_ID_REQUIRED');
  const id = `outbox:${n.event}:${n.eventId}`;
  const old = await tx.get<OutboxEntry>(id);
  if (old) return old.state === 'SENT';
  const row: OutboxEntry = {
    id,
    profileId: n.profileId ?? null,
    event: n.event,
    payload: encodeNotification(n),
    state: 'PENDING',
    attempts: 0,
    nextAt: now,
    lease: null,
    leaseUntil: 0,
    deliveredAt: null,
    error: null,
  };
  await tx.put(id, 'outbox', row.state, row);
  return false;
}

/** ACK is recorded only after the actual transport confirms delivery. */
export class DurableMitigationOutbox implements NotificationPublisher {
  constructor(
    private readonly store: AutomationStore,
    private readonly transport: NotificationPublisher,
    private readonly now: () => number = Date.now,
    private readonly detectionIntervalMs = 30 * 60_000,
  ) {}
  async publish(n: MitigationNotification) {
    const sent = await this.store.transaction((tx) => enqueueNotification(tx, n, this.now()));
    return { published: sent, skipped: false };
  }
  async drain(limit = 10): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const row = await this.store.transaction(async (tx) => {
        const now = this.now();
        const pending = await tx.dueOutbox<OutboxEntry>(now, 1000);
        const sending = await tx.list<OutboxEntry>('outbox', ['SENDING'], 1000);
        for (const item of pending) {
          if (item.nextAt > now || item.leaseUntil > now) continue;
          if (
            sending.some(
              (other) =>
                other.id !== item.id &&
                other.profileId === item.profileId &&
                other.leaseUntil > now,
            )
          )
            continue;
          if (item.event === 'MITIGATION_DETECTION_BLOCKED') {
            const last = await tx.get<{ at: number }>(`delivery-limit:${item.profileId}`);
            if (last && last.at + this.detectionIntervalMs > now) {
              item.nextAt = last.at + this.detectionIntervalMs;
              await tx.put(item.id, 'outbox', item.state, item);
              continue;
            }
          }
          item.state = 'SENDING';
          item.lease = randomUUID();
          item.leaseUntil = now + 60_000;
          item.attempts++;
          await tx.put(item.id, 'outbox', item.state, item);
          return item;
        }
        return null;
      });
      if (!row) break;
      let delivered = false,
        error = 'transport did not acknowledge delivery';
      try {
        const r = await this.transport.publish(decodeNotification(row.payload));
        delivered = r.published === true && r.skipped !== true;
      } catch {
        error = 'transport error; retry scheduled';
      }
      await this.store.transaction(async (tx) => {
        const current = await tx.get<OutboxEntry>(row.id);
        if (!current || current.lease !== row.lease) return;
        current.lease = null;
        current.leaseUntil = 0;
        if (delivered) {
          current.state = 'SENT';
          current.deliveredAt = this.now();
          current.error = null;
          if (current.event === 'MITIGATION_DETECTION_BLOCKED')
            await tx.put(`delivery-limit:${current.profileId}`, 'delivery-limit', 'SENT', {
              at: this.now(),
            });
        } else {
          current.state = current.attempts >= 12 ? 'FAILED' : 'PENDING';
          current.error = error;
          current.nextAt =
            this.now() + Math.min(600_000, 30_000 * 2 ** Math.min(5, current.attempts - 1));
        }
        await tx.put(current.id, 'outbox', current.state, current);
      });
      processed++;
    }
    return processed;
  }
}
