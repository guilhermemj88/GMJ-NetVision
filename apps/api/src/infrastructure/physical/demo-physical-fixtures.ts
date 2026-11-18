import type { PhysicalLldpAdjacencyInput } from './physical-repository';
import type { DemoPhysicalRepository } from './demo-physical-repository';

/**
 * Fixtures do módulo Físico em `DEMO_MODE`.
 *
 * O repositorio demo nasce vazio: sem isso o preview offline mostra apenas
 * "Nenhum POP cadastrado" e nao da para validar rack, inspetor, LLDP, ghost de
 * mapa nem os sheets do celular.
 *
 * Os assets usam `deviceId` de equipamentos que existem no mapa demo, porque e
 * esse vinculo (nunca o nome da porta) que resolve LLDP e o fallback de mapa.
 * Nada aqui roda fora de `DEMO_MODE`.
 */

export const DEMO_PHYSICAL_IDS = {
  siteA: 'demo-site-bhe-vta',
  siteB: 'demo-site-venda-nova',
  rackCore: 'demo-rack-core-01',
  rackAcesso: 'demo-rack-acesso-02',
  rackBorda: 'demo-rack-borda-01',
} as const;

/** Nome longo de proposito: o card e o inspetor precisam truncar sem estourar. */
const LONG_CORE_NAME =
  'CORE-BH-01-NE8000-F1A-CHASSIS-MODULAR-COM-NOME-EXTREMAMENTE-LONGO-DE-PROPOSITO';

export async function seedDemoPhysicalFixtures(repository: DemoPhysicalRepository): Promise<void> {
  const siteA = await repository.createSite({
    name: 'BHE VTA',
    code: 'BHE-VTA',
    description: 'POP metropolitano de Vitoria',
  });
  const siteB = await repository.createSite({
    name: 'Venda Nova',
    code: 'VN',
    description: 'POP de acesso Venda Nova',
  });

  const rackCore = await repository.createRack(siteA.id, {
    name: 'Rack Core 01',
    units: 42,
  });
  const rackAcesso = await repository.createRack(siteA.id, {
    name: 'Rack Acesso 02',
    units: 12,
  });
  const rackBorda = await repository.createRack(siteB.id, {
    name: 'Rack Borda 01',
    units: 42,
  });
  if (!rackCore || !rackAcesso || !rackBorda) return;

  // ---- Rack Core 01: chassis modular, switch fixo, OLT fixa e DIO passivo ----
  // Chassis modular Huawei (21U, 8 slots de LPU): exercita slot labels e o
  // modo técnico. Portas de serviço só existem depois de instalar um módulo,
  // então as conexões/LLDP usam os equipamentos de portas fixas abaixo.
  const modular = await repository.createAsset(rackCore.id, {
    name: 'EDGE-01 · NE40E-X8A CHASSIS MODULAR',
    deviceId: 'edge-01',
    catalogKey: 'huawei-ne40e-x8a',
    // U1..U21: a base do rack. Nada pode sobrepor outro asset — o painel do
    // chassis cobre a área inteira e engoliria os cliques dos vizinhos.
    startU: 1,
    heightU: 21,
  });
  const core = await repository.createAsset(rackCore.id, {
    name: LONG_CORE_NAME,
    deviceId: 'core-01',
    catalogKey: 'huawei-ne8000-f1a-8h20q',
    startU: 40,
    heightU: 1,
  });
  const aggCentro = await repository.createAsset(rackCore.id, {
    name: 'AGG-CENTRO-01 · S6730-H48X6C',
    deviceId: 'agg-centro',
    catalogKey: 'huawei-s6730-h48x6c',
    startU: 38,
    heightU: 1,
  });
  const oltCentro = await repository.createAsset(rackCore.id, {
    name: 'OLT-CENTRO-01',
    deviceId: 'olt-centro',
    catalogKey: 'huawei-s6730-h24x6c',
    startU: 36,
    heightU: 1,
  });
  // Passivo: sem template, 48 portas opticas — o "asset com muitas portas".
  const dio = await repository.createAsset(rackCore.id, {
    name: 'DIO Passivo 48FO · BHE-VTA-CORE-01-DIO-48-PORTAS-OPTICAS',
    kind: 'DIO',
    startU: 28,
    heightU: 2,
    genericPorts: { count: 48, prefix: 'FO', side: 'FRONT', type: 'FIBER' },
  });
  // ---- Rack Acesso 02 (12U) ----
  const aggNorte = await repository.createAsset(rackAcesso.id, {
    name: 'AGG-NORTE-01',
    deviceId: 'agg-norte',
    catalogKey: 'huawei-s6730-h48x6c',
    startU: 10,
    heightU: 1,
  });

  // ---- Rack Borda 01 (outro POP) ----
  const aggOeste = await repository.createAsset(rackBorda.id, {
    name: 'AGG-OESTE-01',
    deviceId: 'agg-oeste',
    catalogKey: 'huawei-s6730-h24x6c',
    startU: 40,
    heightU: 1,
  });

  if (!modular || !core || !aggCentro || !oltCentro || !dio || !aggNorte || !aggOeste) return;

  /**
   * Liga uma porta a uma interface do Device pelo índice (ordem), nunca pelo
   * nome: o template do catalogo muda de SKU para SKU.
   */
  const mapPort = async (assetId: string, index: number, interfaceId: string) => {
    const inventory = await repository.getInventory();
    const asset = inventory.sites
      .flatMap((site) => site.racks)
      .flatMap((rack) => rack.assets)
      .find((item) => item.id === assetId);
    const port = [...(asset?.ports ?? [])].sort((left, right) => left.order - right.order)[index];
    if (!port) return null;
    return repository.updatePort(port.id, { mappedInterfaceId: interfaceId });
  };

  await mapPort(core.id, 0, 'core-01-if-1');
  await mapPort(core.id, 1, 'core-01-if-2');
  await mapPort(core.id, 2, 'core-01-if-3');

  await mapPort(aggCentro.id, 0, 'agg-centro-if-1');
  await mapPort(aggCentro.id, 1, 'agg-centro-if-2');
  await mapPort(aggCentro.id, 2, 'agg-centro-if-3');

  await mapPort(oltCentro.id, 0, 'olt-centro-if-2');
  await mapPort(oltCentro.id, 1, 'olt-centro-if-3');

  await mapPort(aggNorte.id, 0, 'agg-norte-if-1');
  await mapPort(aggOeste.id, 0, 'agg-oeste-if-1');

  /** Porta livre do core e da OLT: cabo confirmado visivel dentro do rack. */
  const portAt = async (assetId: string, index: number) => {
    const inventory = await repository.getInventory();
    const asset = inventory.sites
      .flatMap((site) => site.racks)
      .flatMap((rack) => rack.assets)
      .find((item) => item.id === assetId);
    return [...(asset?.ports ?? [])].sort((left, right) => left.order - right.order)[index] ?? null;
  };

  const coreFree = await portAt(core.id, 3);
  const oltFree = await portAt(oltCentro.id, 2);
  if (coreFree && oltFree) {
    await repository.createConnection({
      portAId: coreFree.id,
      portBId: oltFree.id,
      medium: 'FIBER',
      label: 'CABO CONFIRMADO CORE-01 -> OLT-CENTRO-01',
      lengthMeters: 12,
    });
  }

  // ---- LLDP: READY, PARTIAL e UNRESOLVED ----
  const observedAt = new Date(Date.now() - 15 * 60_000);
  const adjacencies: PhysicalLldpAdjacencyInput[] = [
    {
      localDeviceId: 'core-01',
      localInterfaceId: 'core-01-if-1',
      localPortName: '100GE1/0/1',
      remoteDeviceId: 'agg-centro',
      remoteInterfaceId: 'agg-centro-if-2',
      remoteHostname: 'AGG-CENTRO-01',
      remotePortName: '100GE1/0/2',
      remoteChassisId: 'agg-centro',
      confidence: 'CONFIRMED',
      resolved: true,
      ambiguous: false,
      source: 'LLDP_SNMP',
      observedAt,
    },
    {
      localDeviceId: 'agg-centro',
      localInterfaceId: 'agg-centro-if-3',
      localPortName: '10GE1/0/3',
      remoteDeviceId: null,
      remoteInterfaceId: null,
      remoteHostname: 'SW-FORA-DO-INVENTARIO-FISICO',
      remotePortName: 'GigabitEthernet0/0/12',
      remoteChassisId: null,
      confidence: 'PROBABLE',
      resolved: false,
      ambiguous: false,
      source: 'LLDP_SNMP',
      observedAt,
    },
    {
      localDeviceId: 'olt-centro',
      localInterfaceId: 'olt-centro-if-3',
      localPortName: '10GE1/0/3',
      remoteDeviceId: null,
      remoteInterfaceId: null,
      remoteHostname: 'VIZINHO-AMBIGUO',
      remotePortName: 'ge-0/0/1',
      remoteChassisId: null,
      confidence: 'AMBIGUOUS',
      resolved: false,
      ambiguous: true,
      source: 'LLDP_SNMP',
      observedAt,
    },
  ];
  await repository.recordLldpAdjacencies(adjacencies);
}
