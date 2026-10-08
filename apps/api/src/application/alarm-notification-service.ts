import type { Alarm, AlarmSeverity } from '@gmj/shared';
import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type {
  AlarmNotificationTransport,
  NetworkAlarmEvent,
} from '../infrastructure/alarms/n8n-alarm-transport';

/**
 * Notificacao de midia dos alarmes de REDE (purpose NETWORK_ALARMS).
 *
 * Regras de dedupe (todas persistidas no proprio alarme):
 * - OPENED: exatamente 1x por abertura (notifiedAt);
 * - ESCALATED: exatamente 1x por severidade nova (notifiedSeverity);
 * - RESOLVED: exatamente 1x (resolutionNotifiedAt).
 *
 * Falha de entrega NAO marca nada: a proxima avaliacao tenta de novo, respeitando
 * um cooldown por alarme+evento (nada de storm). Canal inexistente e "skip" sao
 * marcados como tratados para nao gerar blast retroativo se o canal aparecer.
 *
 * Nesta fase notificam apenas as transicoes do motor metrico/optico; o fluxo
 * legado INTERFACE_DOWN e o encerramento administrativo (disable/delete de regra)
 * seguem sem evento de midia.
 */

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  INFO: 1,
  WARNING: 2,
  MAJOR: 3,
  CRITICAL: 4,
};

const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60_000;

export interface AlarmNotifier {
  notifyOpened(alarm: Alarm, options: { mediaEnabled: boolean }): Promise<void>;
  notifyEscalated(alarm: Alarm, options: { mediaEnabled: boolean }): Promise<void>;
  notifyResolved(alarm: Alarm, options?: { mediaEnabled: boolean }): Promise<void>;
}

export interface AlarmNotificationServiceDeps {
  alarms: Pick<AlarmRepository, 'markAlarmNotified' | 'markAlarmResolutionNotified'>;
  transport: AlarmNotificationTransport;
  now?: () => Date;
  retryCooldownMs?: number;
}

export class AlarmNotificationService implements AlarmNotifier {
  private readonly now: () => Date;
  private readonly retryCooldownMs: number;
  /** Proxima tentativa permitida por alarme+evento+severidade. */
  private readonly nextAttemptAt = new Map<string, number>();

  constructor(private readonly deps: AlarmNotificationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.retryCooldownMs = deps.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
  }

  async notifyOpened(alarm: Alarm, options: { mediaEnabled: boolean }): Promise<void> {
    if (alarm.notifiedAt) return;
    await this.dispatch('NETWORK_ALARM_OPENED', alarm, options, 'OPENED');
  }

  async notifyEscalated(alarm: Alarm, options: { mediaEnabled: boolean }): Promise<void> {
    if (alarm.endedAt) return;
    const notified = alarm.notifiedSeverity ?? null;
    if (!notified) {
      // Nunca notificado (ex.: midia desligada na abertura): trata como abertura.
      await this.notifyOpened(alarm, options);
      return;
    }
    if (SEVERITY_RANK[alarm.severity] <= SEVERITY_RANK[notified]) return;
    await this.dispatch('NETWORK_ALARM_ESCALATED', alarm, options, 'OPENED');
  }

  async notifyResolved(alarm: Alarm, options: { mediaEnabled: boolean } = { mediaEnabled: true }): Promise<void> {
    if (alarm.resolutionNotifiedAt) return;
    await this.dispatch('NETWORK_ALARM_RESOLVED', alarm, options, 'RESOLVED');
  }

  private async dispatch(
    event: NetworkAlarmEvent,
    alarm: Alarm,
    options: { mediaEnabled: boolean },
    mark: 'OPENED' | 'RESOLVED',
  ): Promise<void> {
    if (!options.mediaEnabled) {
      // Midia desligada na regra: marcado como tratado, sem evento retroativo.
      await this.markHandled(alarm, mark);
      return;
    }
    const key = `${alarm.id}|${event}|${alarm.severity}`;
    const now = this.now().getTime();
    if ((this.nextAttemptAt.get(key) ?? 0) > now) return;

    const outcome = await this.deps.transport.publish(event, alarm);
    if (outcome.ok || outcome.skipped) {
      await this.markHandled(alarm, mark);
      this.nextAttemptAt.delete(key);
      return;
    }
    // Falha real: NAO marca; retry acontece depois do cooldown.
    this.nextAttemptAt.set(key, now + this.retryCooldownMs);
  }

  private async markHandled(alarm: Alarm, mark: 'OPENED' | 'RESOLVED'): Promise<void> {
    if (mark === 'RESOLVED') {
      await this.deps.alarms.markAlarmResolutionNotified(alarm.id, this.now());
      return;
    }
    await this.deps.alarms.markAlarmNotified(alarm.id, {
      notifiedSeverity: alarm.severity,
      notifiedAt: this.now(),
    });
  }
}
