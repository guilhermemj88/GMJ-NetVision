/**
 * Optional per-host SSH context command.
 *
 * Some hosts are only reachable through another physical device that exposes a
 * virtual system on the same shell session (e.g. Huawei `switch virtual-system`).
 * The command is administrative, persisted on the host and executed in the same
 * SSH shell session right after the preparation commands and before the real one.
 *
 * Only the tightly-scoped Huawei VRP pattern is accepted so the value can never
 * inject additional commands (`;`, `&&`, `||`, newlines, backticks, `$()` are all
 * rejected because the pattern only allows `[A-Za-z0-9._-]` after the keywords).
 */
export const SSH_CONTEXT_COMMAND_PATTERN = /^switch\s+virtual-system\s+[A-Za-z0-9._-]+$/;

export function isValidSshContextCommand(value: string): boolean {
  return SSH_CONTEXT_COMMAND_PATTERN.test(value.trim());
}

/**
 * Trims the value and converts empty/blank input to `null` so the caller can
 * persist a clean value. Validation is intentionally separate.
 */
export function normalizeSshContextCommand(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
