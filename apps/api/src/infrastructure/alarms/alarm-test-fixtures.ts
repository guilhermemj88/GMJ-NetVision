import type {
  Alarm,
  AlarmMetadata,
  NetworkAlarmTestSelectionInput,
  NetworkAlarmTestType,
} from '@gmj/shared';
import {
  networkAlarmTestPreviousSeverity,
  resolveNetworkAlarmTestSelection,
} from '@gmj/shared';

/**
 * FIXTURES do TESTAR ALARME (F9.5.1).
 *
 * Cada tipo real de alarme tem uma fixture SINTETICA tipada. Ela produz apenas
 * um objeto `Alarm` em memoria: nada e persistido (nem Alarm, nem
 * OperationalOccurrence, nem suppression) e nenhum equipamento e consultado.
 * O payload continua sendo montado pelo MESMO builder canonico
 * (`buildNetworkAlarmWebhookPayload`) e enviado pelo MESMO transporte.
 */

const TEST_ALARM_ID = 'TEST-NETVISION';
const TEST_DEVICE = { id: 'test-device', name: 'NETVISION-TEST' } as const;
const TEST_INTERFACE_ID = 'test-interface';

interface TestFixture {
  interfaceName: string;
  interfaceAlias: string;
  message: string;
  metricKey: string | null;
  currentValue: number | null;
  thresholdValue: number | null;
  unit: string | null;
  metadata: AlarmMetadata | null;
}

const TEST_FIXTURES: Record<NetworkAlarmTestType, TestFixture> = {
  // Queda de interface: sem valores metricos (o alerta e o evento, nao a metrica).
  INTERFACE_DOWN: {
    interfaceName: '100GE0/0/1',
    interfaceAlias: 'TESTE-WEBHOOK',
    message: 'Teste de queda de interface do GMJ NetVision',
    metricKey: null,
    currentValue: null,
    thresholdValue: null,
    unit: null,
    metadata: null,
  },
  INTERFACE_CRC: {
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'BACKBONE-TEST',
    message: 'Teste de CRC/FCS do GMJ NetVision',
    metricKey: 'crc_rx',
    currentValue: 18,
    thresholdValue: 10,
    unit: 'errors/min',
    metadata: { direction: 'RX' },
  },
  INTERFACE_DISCARDS: {
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'BACKBONE-TEST',
    message: 'Teste de descartes de interface do GMJ NetVision',
    metricKey: 'discards_rx_tx',
    currentValue: 35,
    thresholdValue: 20,
    unit: 'discards/min',
    metadata: { direction: 'BOTH' },
  },
  INTERFACE_ERRORS: {
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'BACKBONE-TEST',
    message: 'Teste de erros de interface do GMJ NetVision',
    metricKey: 'errors_rx',
    currentValue: 24,
    thresholdValue: 10,
    unit: 'errors/min',
    metadata: { direction: 'RX' },
  },
  OPTICAL_RX_DEGRADATION: {
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'BACKBONE-TEST',
    message: 'Teste de degradação óptica do GMJ NetVision',
    metricKey: 'rx_power_dbm',
    currentValue: -18.7,
    thresholdValue: -21.48,
    unit: 'dBm',
    metadata: {
      direction: 'RX',
      lane: 2,
      rxPowerDbm: -18.7,
      rxLowAlarmDbm: -21.48,
      rxHighAlarmDbm: -2.5,
      rxLowWarningDbm: -18.9,
      rxHighWarningDbm: -3.4,
      proximityReference: 'WARNING',
      proximityPercent: 92,
      trendDropDb: 3.4,
      trendWindowMinutes: 30,
      triggerReasons: ['PROXIMITY', 'RAPID_DROP'],
      currentPowerSource: 'SNMP',
      thresholdSource: 'DEVICE',
    },
  },
};

const RESOLVED_MESSAGE = 'Teste de resolução de alarme do GMJ NetVision';

/**
 * Alarme sintetico do TESTAR ALARME: existe SO em memoria, marcado com
 * `test: true` no payload. `ESCALATED` recebe a severidade anterior para o
 * payload trazer `previousSeverity`; `RESOLVED` recebe `endedAt` (resolvedAt) e
 * a mensagem de resolucao, mantendo os demais dados do tipo como contexto.
 */
export function buildNetworkAlarmTestAlarm(
  selection: NetworkAlarmTestSelectionInput | null | undefined,
  now: Date,
): Alarm {
  const resolved = resolveNetworkAlarmTestSelection(selection);
  const fixture = TEST_FIXTURES[resolved.type];
  return {
    id: TEST_ALARM_ID,
    deviceId: TEST_DEVICE.id,
    deviceName: TEST_DEVICE.name,
    interfaceId: TEST_INTERFACE_ID,
    interfaceName: fixture.interfaceName,
    interfaceLabel: fixture.interfaceAlias,
    ifIndex: 1,
    linkId: null,
    linkLabel: null,
    type: resolved.type,
    severity: resolved.severity,
    startedAt: now.toISOString(),
    endedAt: resolved.event === 'RESOLVED' ? now.toISOString() : null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    message: resolved.event === 'RESOLVED' ? RESOLVED_MESSAGE : fixture.message,
    ruleId: null,
    metricKey: fixture.metricKey,
    currentValue: fixture.currentValue,
    thresholdValue: fixture.thresholdValue,
    unit: fixture.unit,
    notifiedSeverity:
      resolved.event === 'ESCALATED' ? networkAlarmTestPreviousSeverity(resolved.severity) : null,
    metadata: fixture.metadata,
  };
}
