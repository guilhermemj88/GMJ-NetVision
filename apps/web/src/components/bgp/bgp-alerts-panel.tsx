'use client';

import { useQuery } from '@tanstack/react-query';
import type { BgpAlertDto, BgpScope } from '@gmj/shared';
import { getBgpAlerts } from '@/lib/api';
import { formatClock, formatDurationShort } from '@/lib/bgp-format';

function familyText(alert: BgpAlertDto): string {
  return alert.addressFamily === 'IPV6' ? 'IPv6' : 'IPv4';
}

function familyClass(alert: BgpAlertDto): string {
  return alert.addressFamily === 'IPV6' ? 'ipv6' : 'ipv4';
}

export function BgpAlertsPanel({
  scope,
  onSelectAlert,
}: {
  scope: BgpScope;
  onSelectAlert: (alert: BgpAlertDto) => void;
}) {
  const alerts = useQuery({
    queryKey: ['bgp-alerts', scope],
    queryFn: () => getBgpAlerts({ scope, hours: 48 }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const active = alerts.data?.active ?? [];
  const resolved = alerts.data?.resolved ?? [];

  return (
    <aside className="bgp-alerts" aria-label="Alertas BGP">
      <header className="bgp-alerts__header">
        <strong>ALERTAS BGP · 48H</strong>
        <span className={active.length ? 'is-active' : ''}>{active.length}</span>
      </header>

      <section className="bgp-alerts__section">
        <h3 className="bgp-alerts__section-title bgp-alerts__section-title--active">
          Ativos
        </h3>
        {active.length ? (
          <ul className="bgp-alerts__list">
            {active.map((alert) => (
              <li key={alert.peerId}>
                <button
                  type="button"
                  className="bgp-alerts__item bgp-alerts__item--active"
                  onClick={() => onSelectAlert(alert)}
                >
                  <span className="bgp-alerts__dot" />
                  <span className="bgp-alerts__body">
                    <strong>{alert.deviceName}</strong>
                    <em>{alert.displayName}</em>
                    <small>{alert.peerAddress}</small>
                    <small className={`bgp-family bgp-family--${familyClass(alert)}`}>
                      {familyText(alert)}
                    </small>
                    <small className="bgp-alerts__transition">
                      {alert.previousState ? `${alert.previousState} → ` : ''}
                      {alert.currentState}
                    </small>
                    <small>Down desde {formatClock(alert.startedAt)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bgp-alerts__empty">Nenhum peer BGP fora de ESTABLISHED.</p>
        )}
      </section>

      <section className="bgp-alerts__section">
        <h3 className="bgp-alerts__section-title bgp-alerts__section-title--resolved">
          Resolvidos · 48h
        </h3>
        {resolved.length ? (
          <ul className="bgp-alerts__list">
            {resolved.map((alert) => (
              <li key={`${alert.peerId}-${alert.resolvedAt}`}>
                <button
                  type="button"
                  className="bgp-alerts__item bgp-alerts__item--resolved"
                  onClick={() => onSelectAlert(alert)}
                >
                  <span className="bgp-alerts__dot" />
                  <span className="bgp-alerts__body">
                    <strong>{alert.deviceName}</strong>
                    <em>{alert.displayName}</em>
                    <small>{alert.peerAddress}</small>
                    <small className={`bgp-family bgp-family--${familyClass(alert)}`}>
                      {familyText(alert)}
                    </small>
                    <small className="bgp-alerts__transition">
                      {alert.previousState} → {alert.currentState}
                    </small>
                    <small>
                      Resolvido {formatClock(alert.resolvedAt)}
                      {alert.durationSeconds !== null && alert.durationSeconds !== undefined
                        ? ` · duração ${formatDurationShort(alert.durationSeconds)}`
                        : ''}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="bgp-alerts__empty">Nenhuma resolução nas últimas 48h.</p>
        )}
      </section>
    </aside>
  );
}
