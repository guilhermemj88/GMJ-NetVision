/**
 * Inserts the optional per-host SSH context command into an existing command
 * list so it runs in the same shell session, after the preparation commands
 * (e.g. `screen-length 0 temporary`) and before the real command.
 *
 * No context configured → the list is returned unchanged, preserving the
 * behaviour of every host that does not need a virtual system.
 */
export function withSshContext(
  commands: readonly string[],
  contextCommand: string | null | undefined,
): string[] {
  const context = contextCommand?.trim();
  if (!context) return [...commands];
  const screenLengthIndex = commands.findIndex((command) =>
    command.trim().toLowerCase().startsWith('screen-length'),
  );
  const insertAt = screenLengthIndex >= 0 ? screenLengthIndex + 1 : 0;
  return [...commands.slice(0, insertAt), context, ...commands.slice(insertAt)];
}
