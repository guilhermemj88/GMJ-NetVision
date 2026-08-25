export function isRealMplsStateChange(
  previousStatus: string | null | undefined,
  currentStatus: string,
  options: { observed: boolean; complete: boolean },
): boolean {
  return Boolean(
    previousStatus &&
    options.observed &&
    options.complete &&
    currentStatus !== 'UNKNOWN' &&
    previousStatus !== currentStatus,
  );
}
