import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type { InterfaceStatusTransition } from '../infrastructure/persistence/host-repository';

/**
 * Turns interface operStatus transitions into map alarms.
 *
 * Rules (MVP):
 * - `UP -> DOWN` opens one INTERFACE_DOWN/CRITICAL alarm per interface, only
 *   for interfaces that belong to at least one map link.
 * - A transition to `UP` resolves any open alarm for the interface.
 * - `DOWN -> DOWN` (or any non-transition) never creates duplicates: the
 *   repository guards each open against an already-open alarm.
 * - Interfaces that were already DOWN before the first poll (previous status
 *   UNKNOWN or a brand-new row) never transition from UP, so they are ignored.
 */
export class AlarmService {
  constructor(private readonly repository: AlarmRepository) {}

  async processTransitions(transitions: InterfaceStatusTransition[]): Promise<void> {
    if (!transitions.length) return;

    const opened = transitions.filter(
      (transition) => transition.previousStatus === 'UP' && transition.newStatus === 'DOWN',
    );
    const resolved = transitions.filter((transition) => transition.newStatus === 'UP');

    if (opened.length) {
      const linked = await this.repository.findLinkedInterfaceIds(
        opened.map((transition) => transition.interfaceId),
      );
      const relevant = opened.filter((transition) => linked.has(transition.interfaceId));
      if (relevant.length) {
        const startedAt = new Date();
        await this.repository.openInterfaceDownAlarms(
          relevant.map((transition) => ({
            deviceId: transition.deviceId,
            interfaceId: transition.interfaceId,
            ifIndex: transition.ifIndex,
            startedAt,
          })),
        );
      }
    }

    if (resolved.length) {
      await this.repository.resolveInterfaceDownAlarms(
        resolved.map((transition) => transition.interfaceId),
        new Date(),
      );
    }
  }
}
