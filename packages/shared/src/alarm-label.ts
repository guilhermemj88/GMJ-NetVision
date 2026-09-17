/**
 * Alarm display labels and helpers.
 *
 * The friendly name of an interface follows a fixed priority:
 * `alias` (configured on the equipment, e.g. the remote peer name on Huawei)
 * > `description` (ifDescr) > technical `name` (ifName) > `ifIndex`.
 */
export function alarmInterfaceLabel(
  alias: string | null | undefined,
  description: string | null | undefined,
  name: string | null | undefined,
  ifIndex: number,
): string {
  return (
    alias?.trim() ||
    description?.trim() ||
    name?.trim() ||
    `ifIndex ${ifIndex}`
  );
}

/** Formats an ISO timestamp as a compact NOC clock (`HH:mm:ss`). */
export function formatAlarmDownSince(startedAt: string): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Human-readable type label; every alarm type gets a NOC-friendly caption. */
export function alarmTypeLabel(type: string): string {
  switch (type) {
    case 'INTERFACE_DOWN':
      return 'LINK DOWN';
    default:
      return type;
  }
}
