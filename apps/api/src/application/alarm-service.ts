import { alarmSuppressionFingerprint } from '@gmj/shared';
import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type { AlarmSuppressionRepository } from '../infrastructure/alarms/alarm-suppression-repository';
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
 *
 * Supressao operacional (F9.1):
 * - interface suprimida nao reabre alarme enquanto a supressao estiver ativa;
 * - o retorno para `UP` libera as supressoes `UNTIL_CLEAR` da interface, entao
 *   uma nova queda futura volta a abrir alarme normalmente (uma janela
 *   `UNTIL_TIME` continua valendo ate o horario combinado).
 */
export class AlarmService {
  constructor(
    private readonly repository: AlarmRepository,
    private readonly suppressions?: AlarmSuppressionRepository | undefined,
  ) {}

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
      let relevant = opened.filter((transition) => linked.has(transition.interfaceId));
      if (relevant.length && this.suppressions) {
        const suppressed = await this.suppressedInterfaceIds(
          relevant.map((transition) => transition.interfaceId),
        );
        relevant = relevant.filter((transition) => !suppressed.has(transition.interfaceId));
      }
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
      if (this.suppressions) {
        // Interface voltou: a supressao cumpriu o papel (nova queda = novo alarme).
        await this.suppressions.clearRecovered(
          resolved.map((transition) =>
            alarmSuppressionFingerprint({
              interfaceId: transition.interfaceId,
              type: 'INTERFACE_DOWN',
            }),
          ),
          new Date(),
        );
      }
    }
  }

  /** Interfaces com supressao INTERFACE_DOWN ativa (nao reabrem alarme). */
  private async suppressedInterfaceIds(interfaceIds: string[]): Promise<Set<string>> {
    if (!this.suppressions) return new Set();
    const fingerprints = interfaceIds.map((interfaceId) =>
      alarmSuppressionFingerprint({ interfaceId, type: 'INTERFACE_DOWN' }),
    );
    const active = await this.suppressions.listActive(new Date(), {
      fingerprints,
      types: ['INTERFACE_DOWN'],
    });
    return new Set(active.map((row) => row.interfaceId));
  }
}