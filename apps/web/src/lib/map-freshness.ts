/**
 * Frescor de COLETA do mapa.
 *
 * `Map.updatedAt` marca a última alteração de estrutura do mapa (posições,
 * enlaces, filtros) — não a última coleta de telemetria. Para falar de dados
 * coletados usamos o carimbo mais recente entre os equipamentos do mapa
 * (`lastPollingAt`, caindo para `updatedAt` do equipamento).
 *
 * Devolve `null` quando nenhum equipamento tem carimbo confiável: nesse caso a
 * UI deve dizer isso, nunca afirmar que está atualizado.
 */
export function newestCollectionStamp(
  devices: ReadonlyArray<{ lastPollingAt?: string | null; updatedAt?: string | null }>,
): string | null {
  let newest: number | null = null;

  for (const device of devices) {
    const raw = device.lastPollingAt ?? device.updatedAt ?? null;
    if (!raw) continue;
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) continue;
    if (newest === null || timestamp > newest) newest = timestamp;
  }

  return newest === null ? null : new Date(newest).toISOString();
}
