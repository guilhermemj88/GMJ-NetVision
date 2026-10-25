import { stripVTControlCharacters } from 'node:util';

export const TEMPORARY_DIAGNOSTIC_PAGING = 'screen-length 0 temporary' as const;
export interface DiagnosticPreparationProfile {
  disablePagingTemporary?: true | undefined;
  /** Compatibility with already defined private profiles; still a literal, never a command parameter. */
  sessionPreparation?: typeof TEMPORARY_DIAGNOSTIC_PAGING | undefined;
}
export function diagnosticSessionPreparation(
  profile: DiagnosticPreparationProfile,
): typeof TEMPORARY_DIAGNOSTIC_PAGING | undefined {
  if (
    (profile.disablePagingTemporary !== undefined && profile.disablePagingTemporary !== true) ||
    (profile.sessionPreparation !== undefined &&
      profile.sessionPreparation !== TEMPORARY_DIAGNOSTIC_PAGING)
  )
    throw new Error('SSH_DIAGNOSTIC_POLICY_BLOCKED');
  return profile.disablePagingTemporary || profile.sessionPreparation
    ? TEMPORARY_DIAGNOSTIC_PAGING
    : undefined;
}

/** No wildcard Info/OK acceptance: unknown output must stop before the first display. */
export function confirmedDiagnosticPreparation(output: string, expectedPrompt: string): boolean {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.at(-1) !== expectedPrompt) return false;
  lines.pop();
  if (lines.shift() !== TEMPORARY_DIAGNOSTIC_PAGING) return false;
  return (
    lines.length === 0 ||
    (lines.length === 1 &&
      lines[0] ===
        'Info: The configuration takes effect on the current user terminal interface only.')
  );
}
