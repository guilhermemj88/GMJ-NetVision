export type MapMode = 'MANUAL' | 'AUTO' | 'HYBRID';
export type PositionSource = 'AUTO' | 'MANUAL';
export type NodeKind = 'DEVICE' | 'GENERIC';
export type DeviceStatus = 'UP' | 'DOWN' | 'WARNING' | 'UNKNOWN';
export type InterfaceStatus = DeviceStatus | 'DISABLED';
export type DeviceType =
  | 'core'
  | 'router'
  | 'switch'
  | 'aggregation'
  | 'edge'
  | 'olt'
  | 'firewall'
  | 'server'
  | 'internet'
  | 'ix'
  | 'customers'
  | 'generic';
export type DiscoverySource = 'MANUAL' | 'LLDP_SNMP' | 'LLDP_SSH';
export type MetricSource = 'DEMO' | 'ZABBIX';
export type DiscoveryMethod = 'AUTO' | 'SNMP' | 'SSH' | 'MANUAL';
export type MatchStatus = 'MATCHED' | 'UNMATCHED' | 'AMBIGUOUS';
export type HistoryPeriod = '15m' | '1h' | '6h' | '24h' | '7d';
export type NodeDisplayMode = 'ICON_2D' | 'ICON_3D' | 'CARD';
export type LinkDisplayStyle = 'FLOW' | 'WEATHERMAP' | 'HYBRID' | 'MINIMAL';
export type LinkMetricDisplay = 'THROUGHPUT' | 'UTILIZATION' | 'BOTH' | 'NONE';
export type TrafficLabelMode = 'CARD' | 'INLINE' | 'HIDDEN';
export type LinkDirection = 'A_TO_B' | 'B_TO_A';
export type LinkTrafficConsistency = 'CONSISTENT' | 'DIVERGENT' | 'UNKNOWN';
export type CapacitySource = 'AUTO' | 'MANUAL';
export type LinkTrafficMode = 'BIDIRECTIONAL' | 'SINGLE_ENDED';
export type LinkAggregationMode = 'NONE' | 'SUM';
export type LinkLayoutMode = 'AUTO' | 'MANUAL';
/**
 * Side of a node where a link attaches. `AUTO` keeps the relative-position
 * heuristic; every other value pins that end of the link to a concrete side of
 * the node. See `link-handles.ts` for the runtime helpers.
 */
export type LinkHandleSide = 'AUTO' | 'TOP' | 'RIGHT' | 'BOTTOM' | 'LEFT';
export type LinkMetricSourceSide = 'SOURCE' | 'TARGET';
export type PppSource = 'SNMP_HUAWEI' | 'SNMP_MIKROTIK';
export type PppDisplayMode = 'AUTO' | 'SHOW' | 'HIDE';
export type PppLabelPosition = 'TOP' | 'BOTTOM' | 'LEFT' | 'RIGHT' | 'CENTER';
export type MapWidgetType = 'PPP_TOTAL';
export type MapWidgetMode = 'AUTO' | 'MANUAL';
export type AlarmType =
  | 'INTERFACE_DOWN'
  | 'INTERFACE_ERRORS'
  | 'INTERFACE_CRC'
  | 'INTERFACE_DISCARDS'
  | 'OPTICAL_RX_DEGRADATION';
/** Tipos metricos que podem ser governados por AlarmRule nesta fase. */
export type MetricAlarmType =
  | 'INTERFACE_ERRORS'
  | 'INTERFACE_CRC'
  | 'INTERFACE_DISCARDS'
  | 'OPTICAL_RX_DEGRADATION';
export type AlarmDirection = 'RX' | 'TX' | 'BOTH';
export const METRIC_ALARM_TYPES = [
  'INTERFACE_ERRORS',
  'INTERFACE_CRC',
  'INTERFACE_DISCARDS',
  'OPTICAL_RX_DEGRADATION',
] as const satisfies readonly MetricAlarmType[];

/**
 * O tipo TEM série histórica para desenhar no PNG do alerta (os demais seguem
 * texto-only). Mesma lista do motor de regras: um tipo só entra aqui quando o
 * histórico correspondente existe de verdade.
 */
export function isChartableAlarmType(type: string): boolean {
  return (METRIC_ALARM_TYPES as readonly string[]).includes(type);
}

export type AlarmSeverity = 'CRITICAL' | 'MAJOR' | 'WARNING' | 'INFO';

/**
 * SIMULADOR do TESTAR ALARME (F9.5.1).
 *
 * Nao existe tipo sintetico paralelo: os eixos abaixo sao exatamente os valores
 * reais do contrato (`AlarmType`, eventos e severidades). A fixture sintetica
 * alimenta o MESMO builder e o MESMO transporte dos alarmes reais.
 */
export const NETWORK_ALARM_TEST_TYPES = [
  'INTERFACE_DOWN',
  'INTERFACE_CRC',
  'INTERFACE_DISCARDS',
  'INTERFACE_ERRORS',
  'OPTICAL_RX_DEGRADATION',
] as const satisfies readonly AlarmType[];
export type NetworkAlarmTestType = (typeof NETWORK_ALARM_TEST_TYPES)[number];

/** Eventos publicados no payload (mesmos valores do fluxo real). */
export const NETWORK_ALARM_TEST_EVENTS = ['OPENED', 'ESCALATED', 'RESOLVED'] as const;
export type NetworkAlarmTestEvent = (typeof NETWORK_ALARM_TEST_EVENTS)[number];

export const NETWORK_ALARM_TEST_SEVERITIES = ['WARNING', 'MAJOR', 'CRITICAL'] as const;
export type NetworkAlarmTestSeverity = (typeof NETWORK_ALARM_TEST_SEVERITIES)[number];

/** Severidade inicial sugerida por tipo (a UI pode trocar para testar formato). */
export const NETWORK_ALARM_TEST_DEFAULT_SEVERITY: Record<
  NetworkAlarmTestType,
  NetworkAlarmTestSeverity
> = {
  INTERFACE_DOWN: 'CRITICAL',
  INTERFACE_CRC: 'WARNING',
  INTERFACE_DISCARDS: 'WARNING',
  INTERFACE_ERRORS: 'MAJOR',
  OPTICAL_RX_DEGRADATION: 'MAJOR',
};

/** Rotulo curto de cada tipo no seletor do TESTAR ALARME. */
export const NETWORK_ALARM_TEST_TYPE_LABELS: Record<NetworkAlarmTestType, string> = {
  INTERFACE_DOWN: 'Interface DOWN',
  INTERFACE_CRC: 'CRC/FCS',
  INTERFACE_DISCARDS: 'Discards',
  INTERFACE_ERRORS: 'Erros de interface',
  OPTICAL_RX_DEGRADATION: 'Degradação óptica',
};

export interface NetworkAlarmTestSelection {
  type: NetworkAlarmTestType;
  event: NetworkAlarmTestEvent;
  severity: NetworkAlarmTestSeverity;
}

/**
 * Entrada parcial do simulador. Tipada com `| undefined` explicito porque o
 * projeto usa `exactOptionalPropertyTypes` (o corpo validado pela API chega
 * com chaves opcionais de valor `undefined`).
 */
export interface NetworkAlarmTestSelectionInput {
  type?: NetworkAlarmTestType | undefined;
  event?: NetworkAlarmTestEvent | undefined;
  severity?: NetworkAlarmTestSeverity | undefined;
}

/**
 * Severidade ANTERIOR da escalada sintetica: CRITICAL veio de MAJOR, MAJOR veio
 * de WARNING e WARNING (o menor testavel) veio de INFO.
 */
export function networkAlarmTestPreviousSeverity(
  severity: NetworkAlarmTestSeverity,
): AlarmSeverity {
  if (severity === 'CRITICAL') return 'MAJOR';
  if (severity === 'MAJOR') return 'WARNING';
  return 'INFO';
}

/** Defaults do simulador: INTERFACE_DOWN / OPENED e a severidade do tipo. */
export function resolveNetworkAlarmTestSelection(
  input: NetworkAlarmTestSelectionInput | null | undefined,
): NetworkAlarmTestSelection {
  const type = (NETWORK_ALARM_TEST_TYPES as readonly string[]).includes(input?.type ?? '')
    ? (input?.type as NetworkAlarmTestType)
    : 'INTERFACE_DOWN';
  const event = (NETWORK_ALARM_TEST_EVENTS as readonly string[]).includes(input?.event ?? '')
    ? (input?.event as NetworkAlarmTestEvent)
    : 'OPENED';
  const severity = (NETWORK_ALARM_TEST_SEVERITIES as readonly string[]).includes(
    input?.severity ?? '',
  )
    ? (input?.severity as NetworkAlarmTestSeverity)
    : NETWORK_ALARM_TEST_DEFAULT_SEVERITY[type];
  return { type, event, severity };
}

/**
 * Slots de regra gerenciados pela aba BASICO de Alarmes (F9.6).
 *
 * `AlarmRule.managedKey` garante no máximo UMA regra por slot; regras criadas
 * no AVANÇADO ficam com `managedKey = null` (custom).
 */
export const BASIC_ALARM_RULE_KEYS = [
  'BASIC_INTERFACE_CRC',
  'BASIC_INTERFACE_DISCARDS',
  'BASIC_INTERFACE_ERRORS',
  'BASIC_OPTICAL_RX_DEGRADATION',
] as const;
export type BasicAlarmRuleKey = (typeof BASIC_ALARM_RULE_KEYS)[number];

export function isBasicAlarmRuleKey(value: unknown): value is BasicAlarmRuleKey {
  return typeof value === 'string' && (BASIC_ALARM_RULE_KEYS as readonly string[]).includes(value);
}
export type AlarmPanelPosition = 'LEFT' | 'RIGHT' | 'HIDDEN';
export interface Alarm {
  id: string;
  deviceId: string;
  deviceName: string;
  interfaceId: string;
  interfaceName: string;
  interfaceLabel: string;
  ifIndex: number;
  linkId: string | null;
  linkLabel: string | null;
  type: AlarmType;
  severity: AlarmSeverity;
  startedAt: string;
  endedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  message: string;
  /** Fingerprint do alarme metrico (regra + metrica + direcao). */
  ruleId?: string | null | undefined;
  metricKey?: string | null | undefined;
  currentValue?: number | null | undefined;
  thresholdValue?: number | null | undefined;
  unit?: string | null | undefined;
  /** Dedupe da notificacao de midia (OPENED/ESCALATED exatamente 1x por severidade). */
  notifiedSeverity?: AlarmSeverity | null | undefined;
  notifiedAt?: string | null | undefined;
  /** Dedupe do evento RESOLVED (exatamente 1x). */
  resolutionNotifiedAt?: string | null | undefined;
  /** Whitelist segura por tipo; nunca contem segredo. */
  metadata?: AlarmMetadata | null | undefined;
}

/** Metadados seguros de um alarme metrico (errors/discards/CRC/optica). */
export interface AlarmMetadata {
  /**
   * Direcao avaliada. O motor metrico abre um alarme por direcao (RX/TX), por
   * isso `BOTH` so aparece no simulador do TESTAR ALARME, que reproduz a
   * direcao configurada na regra (ex.: discards RX+TX).
   */
  direction?: AlarmDirection | undefined;
  delta?: string | undefined;
  ratePerMinute?: number | undefined;
  thresholdPerMinute?: number | undefined;
  sampleIntervalSeconds?: number | undefined;
  /** Optica: lane avaliada (ausente = leitura escalar). */
  lane?: number | undefined;
  rxPowerDbm?: number | undefined;
  rxLowAlarmDbm?: number | null | undefined;
  rxHighAlarmDbm?: number | null | undefined;
  /** WARNING (.20-.23) do transceiver; usado na proximidade quando existe. */
  rxLowWarningDbm?: number | null | undefined;
  rxHighWarningDbm?: number | null | undefined;
  /** Janela efetiva da proximidade desta avaliacao (WARNING quando publicada). */
  proximityReference?: OpticalProximityReference | null | undefined;
  marginDb?: number | null | undefined;
  proximityPercent?: number | null | undefined;
  trendDropDb?: number | null | undefined;
  trendWindowMinutes?: number | undefined;
  /**
   * TODOS os motivos aplicaveis da avaliacao optica (o alarme e unico; a
   * severidade e o maximo entre eles), ex.: `["RAPID_DROP","PROXIMITY"]`.
   */
  triggerReasons?: OpticalTriggerReason[] | undefined;
  /** Fonte da potencia ATUAL (SNMP/SSH) — nunca misturada com thresholdSource. */
  currentPowerSource?: 'SNMP' | 'SSH' | null | undefined;
  thresholdSource?: OpticalThresholdSource | null | undefined;
  speedBps?: number | undefined;
  /** Motivo administrativo da resolucao (disable/delete da regra). */
  resolutionReason?: AlarmResolutionReason | undefined;
}

/** Motivo administrativo seguro de uma resolucao sem recuperacao real. */
export type AlarmResolutionReason =
  | 'RULE_DISABLED'
  | 'RULE_DELETED'
  | 'MANUAL_SUPPRESSION'
  | 'INTENTIONAL_SHUTDOWN'
  | 'MAINTENANCE'
  | 'FALSE_POSITIVE';

/**
 * Criterio optico que sustentou o alarme. `RAPID_DROP` e a queda relevante na
 * janela (com o valor ATUAL ainda degradado), `PROXIMITY` e a proximidade
 * percentual do Low Alarm, `MARGIN` a margem em dB quando so existe o Low e
 * `AT_LOW` o RX no/abaixo do Low.
 */
export type OpticalTriggerReason = 'AT_LOW' | 'RAPID_DROP' | 'PROXIMITY' | 'MARGIN';

/** Origem efetiva de um threshold optico (prioridade USER > DEVICE > DEFAULT > MANUAL). */
export type OpticalThresholdSource = 'USER' | 'DEVICE' | 'DEFAULT' | 'MANUAL';

/** Um lado (low/high) de um threshold optico, com a origem do valor efetivo. */
export interface OpticalThresholdSide {
  lowAlarmDbm: number | null;
  highAlarmDbm: number | null;
  /**
   * WARNING do transceiver (.20-.23): faixa em que o link ainda opera, porem
   * degradado. `null` = o equipamento nao publica WARNING (ex.: YunShan/S6750),
   * nunca "igual ao ALARM".
   */
  lowWarningDbm?: number | null | undefined;
  highWarningDbm?: number | null | undefined;
  lowSource: OpticalThresholdSource | null;
  highSource: OpticalThresholdSource | null;
}

/** Janela usada no calculo de proximidade do RX. */
export type OpticalProximityReference = 'WARNING' | 'ALARM';

/** Estrutura canonica (versionada) de thresholds do transceiver por interface. */
export interface OpticalThresholdsV1 {
  version: 1;
  scalar: {
    rx: OpticalThresholdSide;
    tx: OpticalThresholdSide;
  };
  lanes: Array<{
    lane: number;
    rx: OpticalThresholdSide;
    tx: OpticalThresholdSide;
  }>;
}

/** Escopo de uma AlarmRule: lista ausente = todos. */
export interface AlarmRuleScope {
  devices?: string[] | undefined;
  interfaces?: string[] | undefined;
  /** Velocidades exatas em bps (1G/10G/40G/100G ou custom). */
  speedsBps?: number[] | undefined;
}

export interface MetricThresholdRuleConfig {
  thresholdPerMinute: number;
  recoveryThresholdPerMinute: number;
  triggerSamples: number;
  recoverySamples: number;
}

export interface InterfaceErrorsRuleConfig extends MetricThresholdRuleConfig {
  direction: AlarmDirection;
}

/** FCS/CRC e metrica de recepcao (RX); sem direcao configuravel. */
export type InterfaceCrcRuleConfig = MetricThresholdRuleConfig;
export type InterfaceDiscardsRuleConfig = InterfaceErrorsRuleConfig;

/**
 * Regra do alarme optico (OPTICAL_RX_DEGRADATION). Os tres criterios sao
 * INDEPENDENTES: proximidade percentual do Low Alarm, margem (quando so existe
 * o Low) e tendencia (queda dentro da janela), que funciona sem threshold.
 * `*TriggerSamples` contam AMOSTRAS OPTICAS (poll de 300s), nunca minutos.
 */
export interface OpticalRuleConfig {
  warningProximityPercent: number;
  majorProximityPercent: number;
  criticalAtLowAlarm: boolean;
  warningTriggerSamples: number;
  majorTriggerSamples: number;
  criticalTriggerSamples: number;
  warningMarginDb: number;
  recoveryProximityPercent: number;
  recoverySamples: number;
  /** Queda (dB) na janela que dispara WARNING; funciona sem nenhum threshold. */
  trendDropDb: number;
  /** Queda (dB) na janela que escala para MAJOR. Nunca abre CRITICAL sozinha. */
  trendMajorDropDb: number;
  trendWindowMinutes: number;
  /** Threshold manual usado SOMENTE quando o equipamento nao fornece nenhum. */
  manualRxLowAlarmDbm?: number | null | undefined;
  manualRxHighAlarmDbm?: number | null | undefined;
}

export type AlarmRuleConfig =
  | InterfaceErrorsRuleConfig
  | InterfaceCrcRuleConfig
  | OpticalRuleConfig;

export interface AlarmRuleDto {
  id: string;
  name: string;
  type: MetricAlarmType;
  enabled: boolean;
  severity: AlarmSeverity;
  mapLinkedOnly: boolean;
  mediaEnabled: boolean;
  scope: AlarmRuleScope;
  config: AlarmRuleConfig;
  /** Slot gerenciado pela aba BASICO; `null` em regra custom (Avançado). */
  managedKey: BasicAlarmRuleKey | null;
  createdAt: string;
  updatedAt: string;
}
/** Tipo de ocorrencia recente derivada das amostras de contador persistidas. */
export type InterfaceOccurrenceKind = 'CRC' | 'DISCARDS';

/**
 * Ocorrencia recente de CRC/FCS ou discards: read model do que ACONTECEU, sem
 * criar alarme artificial. Deltas sao bigint serializados como string.
 */
export interface InterfaceOccurrence {
  kind: InterfaceOccurrenceKind;
  deviceId: string;
  deviceName: string;
  interfaceId: string;
  interfaceName: string;
  interfaceLabel: string;
  ifIndex: number;
  /** Delta acumulado na janela por contador (CRC usa apenas `crcDelta`). */
  crcDelta: string;
  rxDelta: string;
  txDelta: string;
  /** Taxa por minuto do contador de maior delta na janela. */
  ratePerMinute: number;
  /** Ultimo intervalo da janela com delta > 0. */
  lastOccurrenceAt: string;
  /** Quantos intervalos de amostra tiveram ocorrencia (>= 1). */
  intervals: number;
  windowMinutes: number;
}

export interface LinkMetricSource {
  interfaceId: string;
  side: LinkMetricSourceSide;
}
export interface LinkVisualPath {
  order: number;
  label: string | null;
  customColor: string | null;
  curvature: number;
  enabled: boolean;
}
export type UtilizationLevel = 'NORMAL' | 'ATTENTION' | 'HIGH' | 'CRITICAL' | 'INCONSISTENT';
export type HostOrigin = 'MANUAL' | 'ZABBIX' | 'DISCOVERY' | 'IMPORTED';
export type SourceKind = 'ZABBIX' | 'SSH' | 'SNMP';
export type SourceConnectionState =
  'DISABLED' | 'CONFIGURED' | 'CONNECTED' | 'FAILED' | 'TIMEOUT' | 'AUTH_INVALID' | 'UNREACHABLE';
export type SnmpVersion = 'SNMP_V2C' | 'SNMP_V3';
export type SnmpSecurityLevel = 'NO_AUTH_NO_PRIV' | 'AUTH_NO_PRIV' | 'AUTH_PRIV';
export type SnmpAuthProtocol = 'MD5' | 'SHA' | 'SHA256';
export type SnmpPrivacyProtocol = 'DES' | 'AES' | 'AES256';

export interface Position {
  x: number;
  y: number;
}

export interface OpticalLaneReading {
  lane: number;
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  biasCurrentMa?: number | null;
}

export interface NetworkInterface {
  id: string;
  deviceId: string;
  name: string;
  alias: string;
  description: string;
  ifIndex: number;
  mac: string;
  mtu: number;
  speedBps: number;
  adminStatus: 'UP' | 'DOWN';
  operStatus: InterfaceStatus;
  rxBps: number;
  txBps: number;
  rxUtilization: number;
  txUtilization: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
  rxErrorsTotal?: number;
  txErrorsTotal?: number;
  rxDiscardsTotal?: number;
  txDiscardsTotal?: number;
  telemetryAvailable?: boolean;
  telemetryUpdatedAt?: string | null;
  rxPowerDbm?: number | null | undefined;
  txPowerDbm?: number | null | undefined;
  opticalLanes?: OpticalLaneReading[] | null | undefined;
  opticalLaneSource?: 'SNMP' | 'SSH' | null;
  opticalLanesUpdatedAt?: string | null;
  opticalSource?: 'SNMP' | 'SSH' | null;
  opticalUpdatedAt?: string | null;
  /**
   * Thresholds efetivos do transceiver (JSON canonico v1, MESMA coluna que o
   * Alarm Engine le). Preenchido pelo coletor (SNMP primario, SSH fallback).
   */
  opticalThresholds?: OpticalThresholdsV1 | null | undefined;
  opticalThresholdSource?: OpticalThresholdSource | null | undefined;
  opticalThresholdsUpdatedAt?: string | null | undefined;
  rxItemId?: string | null;
  txItemId?: string | null;
  statusItemId?: string | null;
  inErrorsItemId?: string | null;
  outErrorsItemId?: string | null;
  inDiscardsItemId?: string | null;
  outDiscardsItemId?: string | null;
  dataSources?: Array<'ZABBIX' | 'SNMP' | 'SSH' | 'DEMO'>;
}

export interface SourceHealth {
  state: SourceConnectionState;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastErrorSafe: string | null;
}
export interface ZabbixHostBinding {
  hostId: string;
  hostName: string;
  primaryInterfaceId: string;
  ip: string;
}
export interface SshAccessSummary {
  host: string;
  port: number;
  username: string;
  credentialConfigured: boolean;
  authenticationType: 'PASSWORD' | 'PRIVATE_KEY';
  /**
   * Optional Huawei VRP context command executed in the same shell session
   * before the real commands, e.g. "switch virtual-system IMPLANTAR-IXBR".
   */
  contextCommand?: string | null;
}
export interface SnmpAccessSummary {
  version: SnmpVersion;
  host: string;
  port: number;
  username: string;
  securityLevel: SnmpSecurityLevel;
  authProtocol: SnmpAuthProtocol | null;
  privacyProtocol: SnmpPrivacyProtocol | null;
  credentialConfigured: boolean;
}

export interface Device {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  vendor: string;
  model: string;
  status: DeviceStatus;
  deviceType: DeviceType;
  site: string;
  source: MetricSource | DiscoverySource;
  discoveryMethod: DiscoveryMethod;
  uptimeSeconds: number;
  cpuPercent?: number;
  memoryPercent?: number;
  pppSupported: boolean;
  pppOnline: number;
  pppUpdatedAt: string | null;
  pppSource: PppSource | null;
  bgpMonitoringEnabled?: boolean;
  /**
   * Local ASN of the BGP process on this device, learned by SSH discovery.
   * Each device/context owns its own value; it is never sent by the frontend
   * and never derived from a peer remote AS.
   */
  bgpLocalAs?: string | null;
  updatedAt: string;
  interfaces: NetworkInterface[];
}

export interface HostRecord extends Device {
  displayName: string;
  managementIp: string;
  description: string;
  notes: string;
  origin: HostOrigin;
  useZabbix: boolean;
  zabbix: ZabbixHostBinding | null;
  sshEnabled: boolean;
  ssh: SshAccessSummary | null;
  snmpEnabled: boolean;
  snmp: SnmpAccessSummary | null;
  sourceHealth: Record<SourceKind, SourceHealth>;
  lastPollingAt: string | null;
  lastDiscoveryAt: string | null;
  detectedHostname?: string | null;
  mapIds: string[];
  mapCount: number;
  createdAt: string;
}

export interface InterfaceSearchMap {
  id: string;
  name: string;
}

export interface InterfaceSearchResult {
  interfaceId: string;
  deviceId: string;
  hostname: string;
  deviceName: string;
  interfaceName: string;
  alias: string;
  description: string;
  ifIndex: number;
  status: InterfaceStatus;
  ip: string | null;
  vlan: number | null;
  maps: InterfaceSearchMap[];
}

export interface MapNode {
  id: string;
  mapId: string;
  deviceId: string | null;
  nodeKind: NodeKind;
  genericType: string | null;
  label: string | null;
  position: Position;
  locked: boolean;
  positionSource: PositionSource;
  pppDisplayMode: PppDisplayMode;
  pppPosition: PppLabelPosition;
  pppColor: string | null;
  pppFontSize: number;
}

export interface PppTotalWidgetSettings {
  mode: MapWidgetMode;
  selectedHostIds: string[];
  title: string;
  fontColor: string | null;
  fontSize: number;
  backgroundColor: string | null;
  backgroundOpacity: number;
  showHostCount: boolean;
  showFreshness: boolean;
}

export interface MapWidget {
  id: string;
  mapId: string;
  type: MapWidgetType;
  positionX: number;
  positionY: number;
  enabled: boolean;
  settings: PppTotalWidgetSettings;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateMapNodePppInput {
  pppDisplayMode?: PppDisplayMode;
  pppPosition?: PppLabelPosition;
  pppColor?: string | null;
  pppFontSize?: number;
}

/**
 * Editable surface of an existing conceptual (GENERIC) map node. Deliberately
 * narrow: identity (`id`/`mapId`), `deviceId`, `nodeKind`, `position` and the
 * PPP label options are owned by other flows and can never be changed here.
 */
export interface UpdateConceptualNodeInput {
  label?: string;
  genericType?: string;
  locked?: boolean;
}

export interface UpsertMapWidgetInput {
  type: MapWidgetType;
  positionX?: number;
  positionY?: number;
  enabled?: boolean;
  settings?: Partial<PppTotalWidgetSettings>;
}

export interface UpdateMapWidgetInput {
  positionX?: number;
  positionY?: number;
  enabled?: boolean;
  settings?: Partial<PppTotalWidgetSettings>;
}
export interface AddDeviceResult {
  device: HostRecord;
  node: MapNode;
}
export interface DirectionalLinkMetric {
  bps: number;
  utilization: number;
  txBps: number | null;
  observedRxBps: number | null;
  deltaPercent: number | null;
  consistency: LinkTrafficConsistency;
}
export interface LinkThresholds {
  attention: number;
  high: number;
  critical: number;
  maximum: number;
}

export interface NetworkLink {
  id: string;
  mapId: string;
  sourceDeviceId: string | null;
  sourceInterfaceId: string | null;
  targetDeviceId: string | null;
  targetInterfaceId: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  capacityBps: number;
  autoCapacityBps: number;
  capacitySource: CapacitySource;
  trafficMode: LinkTrafficMode;
  customColor: string | null;
  trafficColorAToB: string | null;
  trafficColorBToA: string | null;
  inlineLabelPositionAToB: number | null;
  inlineLabelPositionBToA: number | null;
  animationEnabled: boolean | null;
  label: string;
  status: DeviceStatus;
  discoverySource: DiscoverySource;
  metricSource: MetricSource;
  visualStyle: LinkDisplayStyle | null;
  metricDisplay: LinkMetricDisplay | null;
  aggregationMode: LinkAggregationMode;
  metricSources: LinkMetricSource[];
  visualPaths: LinkVisualPath[];
  linkLayoutMode: LinkLayoutMode;
  sourceHandleSide: LinkHandleSide;
  targetHandleSide: LinkHandleSide;
  directions: Record<LinkDirection, DirectionalLinkMetric>;
  rxBps: number;
  txBps: number;
  rxUtilization: number;
  txUtilization: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkMap {
  id: string;
  name: string;
  description: string;
  mode: MapMode;
  isDefault: boolean;
  settings: MapSettings;
  nodes: MapNode[];
  devices: HostRecord[];
  links: NetworkLink[];
  widgets: MapWidget[];
  createdAt: string;
  updatedAt: string;
}
export interface MapViewport {
  x: number;
  y: number;
  zoom: number;
}
export interface MapSettings {
  nodeDisplayMode: NodeDisplayMode;
  linkDisplayStyle: LinkDisplayStyle;
  linkMetricDisplay: LinkMetricDisplay;
  trafficLabelMode: TrafficLabelMode;
  filters: MapPreferences;
  viewport: MapViewport;
  nodeScale: number;
  linkScale: number;
  labelScale: number;
}
export interface MapSummary {
  id: string;
  name: string;
  description: string;
  mode: MapMode;
  isDefault: boolean;
  nodeCount: number;
  linkCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateMapInput {
  name: string;
  description: string;
  mode: MapMode;
  sourceMapId: string | null;
}
export interface UpdateMapInput {
  name?: string;
  description?: string;
  mode?: MapMode;
  isDefault?: boolean;
  settings?: MapSettingsUpdate;
}
export interface MapSettingsUpdate {
  nodeDisplayMode?: NodeDisplayMode;
  linkDisplayStyle?: LinkDisplayStyle;
  linkMetricDisplay?: LinkMetricDisplay;
  trafficLabelMode?: TrafficLabelMode;
  filters?: Partial<MapPreferences>;
  viewport?: Partial<MapViewport>;
  nodeScale?: number;
  linkScale?: number;
  labelScale?: number;
}

export interface HostBasicInput {
  hostname: string;
  displayName: string;
  managementIp: string;
  vendor: string;
  model: string;
  deviceType: DeviceType;
  site: string;
  description: string;
  notes: string;
  origin: HostOrigin;
}
export interface ZabbixHostInput {
  enabled: boolean;
  hostId: string;
  hostName: string;
  primaryInterfaceId: string;
  ip: string;
}
export interface SshHostInput {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password?: string;
  clearCredential?: boolean;
  contextCommand?: string | null;
}
export interface SnmpHostInput {
  enabled: boolean;
  version: SnmpVersion;
  host: string;
  port: number;
  community?: string;
  username: string;
  securityLevel: SnmpSecurityLevel;
  authProtocol: SnmpAuthProtocol | null;
  authPassword?: string;
  privacyProtocol: SnmpPrivacyProtocol | null;
  privacyPassword?: string;
  clearCredential?: boolean;
}
export interface CreateHostInput extends HostBasicInput {
  zabbix: ZabbixHostInput;
  ssh: SshHostInput;
  snmp: SnmpHostInput;
}
export type UpdateHostInput = Partial<HostBasicInput> & {
  zabbix?: ZabbixHostInput;
  ssh?: SshHostInput;
  snmp?: SnmpHostInput;
  bgpMonitoringEnabled?: boolean;
};
export interface ConnectionTestResult {
  source: SourceKind;
  state: Exclude<SourceConnectionState, 'CONFIGURED'>;
  message: string;
  checkedAt: string;
  version?: string;
}

export interface ZabbixHostCandidate {
  hostId: string;
  hostname: string;
  displayName: string;
  managementIp: string;
  primaryInterfaceId: string;
  vendor: string;
  model: string;
  status: DeviceStatus;
  alreadyRegistered: boolean;
  matchedHostId: string | null;
  interfaceCount: number;
  /**
   * Metadados públicos da interface SNMP do Zabbix para o preview. A community
   * NUNCA entra no candidato — ela existe apenas em estrutura interna do
   * backend durante a importação. A versão também só é resolvida na importação
   * privada (o preview não solicita `details`) e por isso vem null aqui.
   */
  snmpAvailable?: boolean;
  snmpVersion?: SnmpVersion | null;
  snmpPort?: number | null;
}
export interface ZabbixImportPreview {
  id: string;
  version: string;
  demoMode: boolean;
  hosts: ZabbixHostCandidate[];
  createdAt: string;
}
export interface ZabbixImportResult {
  imported: HostRecord[];
  skippedHostIds: string[];
}
export type NeighborInventoryState =
  'PRESENT_IN_MAP' | 'REGISTERED' | 'NOT_REGISTERED' | 'AMBIGUOUS';
export type NeighborZabbixState = 'FOUND' | 'NOT_FOUND' | 'AMBIGUOUS';
export interface AssistedDiscoveredNeighbor extends DiscoveredNeighbor {
  inventoryState: NeighborInventoryState;
  zabbixState: NeighborZabbixState;
  mapPresent: boolean;
  linkExists: boolean;
  candidateDeviceIds: string[];
  zabbixCandidate: ZabbixHostCandidate | null;
}
export interface AssistedDiscoveryPreview {
  id: string;
  hostId: string;
  mapId: string;
  method: DiscoveryMethod;
  neighbors: AssistedDiscoveredNeighbor[];
  warnings: string[];
  createdAt: string;
}
export type DiscoveryApplyAction = 'ADD' | 'ADD_UNMONITORED' | 'LINK_ONLY' | 'IGNORE';
export interface DiscoveryApplySelection {
  neighborId: string;
  action: DiscoveryApplyAction;
  selectedDeviceId?: string;
}
export interface DiscoveryApplyResult {
  map: NetworkMap;
  createdHosts: string[];
  addedNodes: string[];
  createdLinks: string[];
  skipped: string[];
}
export interface MapPlaylistItem {
  mapId: string;
  order: number;
}
export interface MapPlaylist {
  id: string;
  name: string;
  rotationIntervalSeconds: number;
  isDefault: boolean;
  items: MapPlaylistItem[];
  createdAt: string;
  updatedAt: string;
}
export interface MetricPoint {
  timestamp: string;
  rxBps: number;
  txBps: number;
  rxBpsMax?: number;
  txBpsMax?: number;
  sampleCount?: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
}

export interface InterfaceOpticalSample {
  timestamp: string;
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  opticalLanes: OpticalLaneReading[];
}

export interface OpticalLaneHistoryPoint {
  lane: number;
  sampleCount: number;
  rxAvg: number | null;
  rxMin: number | null;
  rxMax: number | null;
  txAvg: number | null;
  txMin: number | null;
  txMax: number | null;
}

export interface OpticalHistoryPoint {
  timestamp: string;
  sampleCount: number;
  rxAvg: number | null;
  rxMin: number | null;
  rxMax: number | null;
  txAvg: number | null;
  txMin: number | null;
  txMax: number | null;
  lanes: OpticalLaneHistoryPoint[];
}

export interface DiscoveredNeighbor {
  id: string;
  localDeviceId: string;
  localPort: string;
  localIfIndex?: number;
  localPortSubtype?: number;
  localMac?: string;
  remoteSystemName: string;
  remoteChassisId?: string;
  remoteManagementAddress?: string;
  remotePort: string;
  remotePortDescription?: string;
  systemDescription?: string;
  capabilities: string[];
  source: Exclude<DiscoverySource, 'MANUAL'>;
  matchStatus: MatchStatus;
  matchedDeviceId?: string;
}
export interface DiscoveryReview {
  deviceId: string;
  method: DiscoveryMethod;
  neighbors: DiscoveredNeighbor[];
  warnings: string[];
}
export interface CreateLinkInput {
  sourceDeviceId?: string | null;
  sourceInterfaceId?: string | null;
  targetDeviceId?: string | null;
  targetInterfaceId?: string | null;
  sourceNodeId?: string | null;
  targetNodeId?: string | null;
  capacityBps: number;
  autoCapacityBps: number;
  capacitySource: CapacitySource;
  trafficMode: LinkTrafficMode;
  customColor: string | null;
  trafficColorAToB?: string | null;
  trafficColorBToA?: string | null;
  inlineLabelPositionAToB?: number | null;
  inlineLabelPositionBToA?: number | null;
  animationEnabled: boolean | null;
  label: string;
  metricSource: MetricSource;
  visualStyle: LinkDisplayStyle | null;
  metricDisplay: LinkMetricDisplay | null;
  aggregationMode?: LinkAggregationMode;
  metricSources?: LinkMetricSource[];
  visualPaths?: LinkVisualPath[];
  linkLayoutMode?: LinkLayoutMode;
  sourceHandleSide?: LinkHandleSide;
  targetHandleSide?: LinkHandleSide;
}
export type UpdateLinkInput = Pick<
  CreateLinkInput,
  | 'capacityBps'
  | 'autoCapacityBps'
  | 'capacitySource'
  | 'label'
  | 'metricSource'
  | 'visualStyle'
  | 'metricDisplay'
> &
  Pick<CreateLinkInput, 'sourceInterfaceId' | 'targetInterfaceId'> &
  Partial<
    Pick<
      CreateLinkInput,
      'trafficMode'
      | 'customColor'
      | 'trafficColorAToB'
      | 'trafficColorBToA'
      | 'inlineLabelPositionAToB'
      | 'inlineLabelPositionBToA'
      | 'animationEnabled'
      | 'aggregationMode'
      | 'metricSources'
      | 'linkLayoutMode'
      | 'visualPaths'
      | 'sourceHandleSide'
      | 'targetHandleSide'
    >
  >;
export interface CreateGenericNodeInput {
  type: string;
  label: string;
  position: Position;
}
export interface MapPreferences {
  showTraffic: boolean;
  showUtilization: boolean;
  showLabels: boolean;
  showOffline: boolean;
  showInterfaces: boolean;
  showTrafficAnimation: boolean;
  /**
   * MAP-VISUAL-V2 — modo visual do mapa. OPCIONAL e ADITIVO: mapas antigos não
   * têm o campo e continuam na V1. Nada é escrito aqui pelo laboratório; o
   * padrão do produto é sempre V1.
   */
  visualMode?: MapVisualMode;
}

export type MapVisualMode = 'V1' | 'V2';

export type LldpConfidence = 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNKNOWN_NEIGHBOR';
export type LldpApplyAction = 'CREATE_LINK' | 'IGNORE';

export interface LldpCorrelationSignal {
  kind:
    | 'MANAGEMENT_IP'
    | 'CHASSIS_ID'
    | 'SYSTEM_NAME'
    | 'REMOTE_INTERFACE'
    | 'PORT_ID'
    | 'PORT_DESCRIPTION'
    | 'MAC';
  value: string;
}

export interface LldpAdjacencyProposal {
  id: string;
  sourceHostId: string;
  sourceHostname: string;
  sourcePort: string;
  sourceIfIndex: number | null;
  sourceInterfaceId: string | null;
  sourceSpeedBps: number | null;
  targetHostId: string | null;
  targetHostname: string;
  targetManagementAddress: string | null;
  targetChassisId: string | null;
  targetPort: string;
  targetPortDescription: string | null;
  targetInterfaceId: string | null;
  targetSpeedBps: number | null;
  confidence: LldpConfidence;
  signals: LldpCorrelationSignal[];
  reasons: string[];
  duplicate: boolean;
  existingLinkId: string | null;
  source: Exclude<DiscoverySource, 'MANUAL'>;
}

export interface LldpTopologyStats {
  hostsQueried: number;
  hostsFailed: number;
  adjacencies: number;
  confirmed: number;
  probable: number;
  ambiguous: number;
  unknownNeighbor: number;
}

export interface LldpTopologyPreview {
  id: string;
  mapId: string;
  createdAt: string;
  stats: LldpTopologyStats;
  adjacencies: LldpAdjacencyProposal[];
  warnings: string[];
}

export interface LldpApplySelection {
  adjacencyId: string;
  action: LldpApplyAction;
}

export interface LldpApplyResult {
  mapId: string;
  createdLinks: string[];
  skipped: string[];
}

export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
export type PublicViewType = 'MAP' | 'NOC';

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
}

export interface AuthStatus {
  required: boolean;
  user: AuthUser | null;
}

export interface LoginInput {
  usernameOrEmail: string;
  password: string;
}

export interface UserAccount {
  id: string;
  username: string;
  email: string;
  name: string;
  role: Role;
  enabled: boolean;
}

export interface CreateUserInput {
  username: string;
  email: string;
  name: string;
  password: string;
  role: Role;
}

export interface UpdateUserInput {
  email?: string;
  name?: string;
  role?: Role;
  enabled?: boolean;
  password?: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface PublicView {
  id: string;
  token: string;
  name: string;
  type: PublicViewType;
  mapId: string | null;
  playlistId: string | null;
  enabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PublicMapView {
  id: string;
  name: string;
  description: string;
  mode: MapMode;
  settings: MapSettings;
  nodes: MapNode[];
  devices: Device[];
  links: NetworkLink[];
  widgets: MapWidget[];
  updatedAt: string;
}

export interface PublicPlaylistView {
  id: string;
  name: string;
  rotationIntervalSeconds: number;
  maps: PublicMapView[];
}

export interface PublicViewResponse {
  type: PublicViewType;
  map?: PublicMapView;
  playlist?: PublicPlaylistView;
}

export interface CreatePublicViewInput {
  name: string;
  type: PublicViewType;
  mapId?: string | null;
  playlistId?: string | null;
  expiresAt?: string | null;
}

export interface UpdatePublicViewInput {
  name?: string;
  enabled?: boolean;
  expiresAt?: string | null;
}
