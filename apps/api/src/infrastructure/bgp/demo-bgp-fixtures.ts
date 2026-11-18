import type { BgpPeerState } from './bgp4-peer-parser';
import type { BgpDiscoveryPeerInput } from './bgp-repository';
import type { HuaweiBgpCollection } from './huawei-bgp-snmp';
import type { DemoBgpRepository } from './demo-bgp-repository';

/**
 * Fixtures do BGP em `DEMO_MODE`.
 *
 * O repositorio demo nasce vazio: sem isso a tela de BGP do preview offline
 * so mostra "Nenhum peer BGP descoberto" e nao da para validar cards, agrupa-
 * mento por equipamento, IPv6, DOWN e quedas sem depender de equipamento real.
 *
 * Os cenarios cobrem exatamente o que a camada mobile precisa provar:
 *   A) Huawei IPv4 ESTABLISHED com muitas rotas
 *   B) Juniper IPv4 ESTABLISHED
 *   C) Juniper IPv6 ESTABLISHED
 *   D) peer DOWN (com inicio de indisponibilidade datado)
 *   E) peer com contagem de rotas grande
 *   F) peer com RX/TX de interface
 *   G) peer sem interface/RX/TX
 *   H) equipamento aguardando a primeira coleta
 *
 * Tudo passa pelos mesmos metodos que o fluxo real usa (`saveCollection` para
 * estado SNMP/IPv4 e `saveDiscovery` para enriquecer AS, interface e IPv6),
 * entao as regras de transicao, amostras e alertas continuam sendo as do
 * dominio — nada aqui inventa estado.
 */

/**
 * `id` precisa existir no inventario demo: `/api/bgp` resolve as capabilities
 * (vendor/model) pelo host do equipamento, e um id orfao faria todo peer cair
 * em UNSUPPORTED — escondendo admin actions e a aba de anuncios no preview.
 */
export const DEMO_BGP_DEVICES = {
  huawei: {
    id: 'core-01',
    hostname: 'ne8000-core',
    displayName: 'NE-8K POP CENTRO',
    bgpMonitoringEnabled: true,
    bgpLocalAs: '265185',
  },
  juniperV4: {
    id: 'edge-01',
    hostname: 'mx240-op',
    displayName: 'VIANET-OUROPRETO',
    bgpMonitoringEnabled: true,
    bgpLocalAs: '265185',
  },
  juniperV6: {
    id: 'core-02',
    hostname: 'mx240-nl',
    displayName: 'BORDA-VIANET-NOVA-LIMA',
    bgpMonitoringEnabled: true,
    bgpLocalAs: '52575',
  },
} as const;

const STATE_BY_CODE: Record<number, BgpPeerState> = {
  1: 'IDLE',
  2: 'CONNECT',
  3: 'ACTIVE',
  4: 'OPENSENT',
  5: 'OPENCONFIRM',
  6: 'ESTABLISHED',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function collection(
  collectedAt: Date,
  peers: Array<{ peerAddress: string; stateCode: number; receivedPrefixes: number | null }>,
): HuaweiBgpCollection {
  return {
    collectedAt,
    errors: [],
    peers: peers.map((peer) => ({
      peerAddress: peer.peerAddress,
      addressFamily: 'IPV4',
      stateCode: peer.stateCode,
      state: STATE_BY_CODE[peer.stateCode] ?? 'UNKNOWN',
      established: peer.stateCode === 6,
      receivedPrefixes: peer.receivedPrefixes,
    })),
  };
}

function discovery(peer: Partial<BgpDiscoveryPeerInput> & { peerAddress: string }): BgpDiscoveryPeerInput {
  return {
    addressFamily: 'IPV4',
    remoteAs: null,
    stateCode: null,
    state: null,
    sessionUptimeSeconds: null,
    cliReceivedPrefixes: null,
    bgpPeerDescription: null,
    interfaceId: null,
    correlationStatus: 'NO_ROUTE',
    ...peer,
  };
}

export function seedDemoBgpFixtures(repository: DemoBgpRepository, now: Date = new Date()): void {
  const at = (offsetMs: number) => new Date(now.getTime() - offsetMs);

  for (const device of Object.values(DEMO_BGP_DEVICES)) {
    repository.setDevice(device);
  }

  repository.setInterface({
    id: 'demo-if-et1-0-1',
    name: 'Eth-Trunk1',
    alias: 'TRANSITO-LEVEL3',
    description: null,
    rxBps: 532_000_000,
    txBps: 224_000_000,
  });
  repository.setInterface({
    id: 'demo-if-et1-0-2',
    name: 'Eth-Trunk2',
    alias: 'TRANSITO-COGENT',
    description: null,
    rxBps: 81_400_000,
    txBps: 63_200_000,
  });
  repository.setInterface({
    id: 'demo-if-ae0-2800',
    name: 'ae0.2800',
    alias: 'VIANET-TRANSITO',
    description: null,
    rxBps: 1_240_000_000,
    txBps: 815_000_000,
  });

  // ---- A/E/F: Huawei IPv4 estabelecido, rotas grandes e RX/TX ----
  repository.saveCollection(
    DEMO_BGP_DEVICES.huawei.id,
    collection(at(32 * DAY), [
      { peerAddress: '200.219.0.1', stateCode: 6, receivedPrefixes: 1_102_345 },
    ]),
  );

  // ---- G: estabelecido, sem interface e sem RX/TX ----
  repository.saveCollection(
    DEMO_BGP_DEVICES.huawei.id,
    collection(at(3 * HOUR), [{ peerAddress: '200.219.0.9', stateCode: 6, receivedPrefixes: 842 }]),
  );

  // ---- D + quedas: duas transicoes reais em 48h, a ultima ainda aberta ----
  repository.saveCollection(
    DEMO_BGP_DEVICES.huawei.id,
    collection(at(26 * HOUR), [
      { peerAddress: '200.219.0.5', stateCode: 6, receivedPrefixes: 1_310 },
    ]),
  );
  repository.saveCollection(
    DEMO_BGP_DEVICES.huawei.id,
    collection(at(25 * HOUR), [{ peerAddress: '200.219.0.5', stateCode: 3, receivedPrefixes: null }]),
  );
  repository.saveCollection(
    DEMO_BGP_DEVICES.huawei.id,
    collection(at(24 * HOUR), [
      { peerAddress: '200.219.0.5', stateCode: 6, receivedPrefixes: 1_288 },
    ]),
  );
  repository.saveCollection(
    DEMO_BGP_DEVICES.huawei.id,
    collection(at(4 * MINUTE), [
      { peerAddress: '200.219.0.5', stateCode: 3, receivedPrefixes: null },
    ]),
  );

  // ---- B: Juniper IPv4 estabelecido ----
  repository.saveCollection(
    DEMO_BGP_DEVICES.juniperV4.id,
    collection(at(12 * DAY), [
      { peerAddress: '167.250.0.1', stateCode: 6, receivedPrefixes: 920_412 },
    ]),
  );

  // Descoberta: enriquece AS remoto, descricao e interface dos peers IPv4.
  void repository.saveDiscovery(
    DEMO_BGP_DEVICES.huawei.id,
    [
      discovery({
        peerAddress: '200.219.0.1',
        remoteAs: 16735n,
        localAs: 265185n,
        bgpPeerDescription: 'TRANSITO LEVEL3',
        interfaceId: 'demo-if-et1-0-1',
        correlationStatus: 'MATCHED',
      }),
      discovery({
        peerAddress: '200.219.0.5',
        remoteAs: 6939n,
        localAs: 265185n,
        bgpPeerDescription: 'TRANSITO COGENT',
        interfaceId: 'demo-if-et1-0-2',
        correlationStatus: 'MATCHED',
      }),
      discovery({
        peerAddress: '200.219.0.9',
        remoteAs: 12956n,
        localAs: 265185n,
        bgpPeerDescription: 'TELXIUS',
        correlationStatus: 'COMMAND_FAILED',
      }),
    ],
    at(30 * MINUTE),
  );

  void repository.saveDiscovery(
    DEMO_BGP_DEVICES.juniperV4.id,
    [
      discovery({
        peerAddress: '167.250.0.1',
        remoteAs: 16735n,
        localAs: 265185n,
        bgpPeerDescription: 'VIANET TRANSITO',
        interfaceId: 'demo-if-ae0-2800',
        correlationStatus: 'MATCHED',
      }),
    ],
    at(30 * MINUTE),
  );

  // ---- C: Juniper IPv6 estabelecido (rota IPv6 e somente via SSH) ----
  void repository.saveDiscovery(
    DEMO_BGP_DEVICES.juniperV6.id,
    [
      discovery({
        peerAddress: '2804:1f0:1:2::1',
        addressFamily: 'IPV6',
        remoteAs: 6939n,
        localAs: 52575n,
        stateCode: 6,
        state: 'ESTABLISHED',
        sessionUptimeSeconds: 6 * 24 * 3600,
        cliReceivedPrefixes: 190_233n,
        bgpPeerDescription: 'HURRICANE IPv6',
      }),
    ],
    at(20 * MINUTE),
  );
}
