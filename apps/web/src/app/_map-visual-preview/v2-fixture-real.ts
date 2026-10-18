/**
 * MAP-VISUAL-V2 — fixture de GEOMETRIA REAL sanitizada (Fase C).
 *
 * Origem: snapshot SOMENTE-LEITURA do mapa "MPLS - LLDP AUTO TESTE"
 * (produção, 2026-10-16), extraído por SELECT em "MapNode"/"Link".
 *
 * Preservado do original: quantidade de nós (25 = 15 ancorados em device +
 * 10 nós conceituais), posições x/y, pares conectados, comprimentos dos
 * enlaces (145-492 px), curvaturas de visualPaths, distribuição de paralelos
 * (grupos de 3 e de 2) e classes de capacidade (29 enlaces acima de 40G e
 * 2 entre 1G e 10G).
 *
 * Sanitizado: ids viram r01..r25 / r-link-N; nomes, IPs (10.90.x.x), status,
 * telemetria e alarmes são fictícios e determinísticos. Nenhum nome de
 * equipamento, IP, serial ou credencial real está presente.
 *
 * A fixture é estática: nenhuma dependência da API de produção em runtime.
 */

import type { MockScenario } from './v2-scenarios';

export const SCENARIO_REAL: MockScenario = {
  id: 'real',
  title: 'Cenario C - geometria real (sanitizada)',
  description:
    '25 nos e 31 linhas derivados de um mapa real (posicoes, curvaturas e capacidades preservadas; nomes, status e telemetria simulados).',
  nodes: [
  {
    "id": "r01",
    "name": "CLOUD-01",
    "ip": "10.90.0.1",
    "status": "up",
    "legacyType": "CLOUD",
    "x": 570.81,
    "y": -353.72,
    "tag": "no CLOUD"
  },
  {
    "id": "r02",
    "name": "CLOUD-02",
    "ip": "10.90.0.2",
    "status": "up",
    "legacyType": "CLOUD",
    "x": 764.48,
    "y": -353.72,
    "tag": "no CLOUD"
  },
  {
    "id": "r03",
    "name": "CLOUD-03",
    "ip": "10.90.0.3",
    "status": "up",
    "legacyType": "CLOUD",
    "x": 445.53,
    "y": -335.12,
    "alarms": 3,
    "tag": "no CLOUD"
  },
  {
    "id": "r04",
    "name": "CLOUD-CENTRO-VILA-NOVA-04",
    "ip": "10.90.0.4",
    "status": "warning",
    "legacyType": "CLOUD",
    "x": 906.5,
    "y": -335.12,
    "tag": "no CLOUD"
  },
  {
    "id": "r05",
    "name": "CLOUD-05",
    "ip": "10.90.0.5",
    "status": "up",
    "legacyType": "CLOUD",
    "x": 1228.23,
    "y": -335.12,
    "tag": "no CLOUD"
  },
  {
    "id": "r06",
    "name": "CLOUD-06",
    "ip": "10.90.0.6",
    "status": "down",
    "legacyType": "CLOUD",
    "x": 288.18,
    "y": -253.86,
    "tag": "no CLOUD"
  },
  {
    "id": "r07",
    "name": "IX-07",
    "ip": "10.90.0.7",
    "status": "up",
    "legacyType": "IX",
    "x": 1441.05,
    "y": -253.86,
    "tag": "no IX"
  },
  {
    "id": "r08",
    "name": "RT-NORTE-JARDIM-AMPLIADO-08",
    "ip": "10.90.0.8",
    "status": "up",
    "legacyType": "ROUTER",
    "x": 676,
    "y": -175.97
  },
  {
    "id": "r09",
    "name": "CORE-09",
    "ip": "10.90.0.9",
    "status": "up",
    "legacyType": "CORE_ROUTER",
    "x": 1000.85,
    "y": -175.97,
    "alarms": 1
  },
  {
    "id": "r10",
    "name": "SERVICE-10",
    "ip": "10.90.0.10",
    "status": "unknown",
    "legacyType": "SERVICE",
    "x": 1565.5,
    "y": -126.67,
    "tag": "no SERVICE"
  },
  {
    "id": "r11",
    "name": "GEN-11",
    "ip": "10.90.0.11",
    "status": "warning",
    "legacyType": "GENERIC",
    "x": 222.64,
    "y": -30.71
  },
  {
    "id": "r12",
    "name": "CORE-12",
    "ip": "10.90.0.12",
    "status": "up",
    "legacyType": "CORE_ROUTER",
    "x": 676,
    "y": -30.71
  },
  {
    "id": "r13",
    "name": "SW-13",
    "ip": "10.90.0.13",
    "status": "up",
    "legacyType": "SWITCH",
    "x": 1112.5,
    "y": -30.71
  },
  {
    "id": "r14",
    "name": "SW-14",
    "ip": "10.90.0.14",
    "status": "up",
    "legacyType": "SWITCH",
    "x": 1388.28,
    "y": -30.71
  },
  {
    "id": "r15",
    "name": "SERVICE-CENTRO-VILA-NOVA-15",
    "ip": "10.90.0.15",
    "status": "up",
    "legacyType": "SERVICE",
    "x": 1565.5,
    "y": 48.82,
    "alarms": 3,
    "tag": "no SERVICE"
  },
  {
    "id": "r16",
    "name": "SW-16",
    "ip": "10.90.0.16",
    "status": "up",
    "legacyType": "SWITCH",
    "x": 222.64,
    "y": 160.47
  },
  {
    "id": "r17",
    "name": "SW-17",
    "ip": "10.90.0.17",
    "status": "up",
    "legacyType": "SWITCH",
    "x": 472.55,
    "y": 160.47
  },
  {
    "id": "r18",
    "name": "SW-18",
    "ip": "10.90.0.18",
    "status": "warning",
    "legacyType": "SWITCH",
    "x": 676,
    "y": 160.47
  },
  {
    "id": "r19",
    "name": "SW-19",
    "ip": "10.90.0.19",
    "status": "up",
    "legacyType": "SWITCH",
    "x": 1112.5,
    "y": 160.47
  },
  {
    "id": "r20",
    "name": "SERVICE-20",
    "ip": "10.90.0.20",
    "status": "up",
    "legacyType": "SERVICE",
    "x": 1441.05,
    "y": 175.26,
    "tag": "no SERVICE"
  },
  {
    "id": "r21",
    "name": "RT-NORTE-JARDIM-AMPLIADO-21",
    "ip": "10.90.0.21",
    "status": "unknown",
    "legacyType": "ROUTER",
    "x": 472.55,
    "y": 266.52,
    "alarms": 1
  },
  {
    "id": "r22",
    "name": "SW-22",
    "ip": "10.90.0.22",
    "status": "up",
    "legacyType": "SWITCH",
    "x": 891.59,
    "y": 266.52
  },
  {
    "id": "r23",
    "name": "GEN-23",
    "ip": "10.90.0.23",
    "status": "down",
    "legacyType": "GENERIC",
    "x": 222.64,
    "y": 349.88
  },
  {
    "id": "r24",
    "name": "GEN-24",
    "ip": "10.90.0.24",
    "status": "up",
    "legacyType": "GENERIC",
    "x": 676,
    "y": 349.88
  },
  {
    "id": "r25",
    "name": "SW-25",
    "ip": "10.90.0.25",
    "status": "warning",
    "legacyType": "SWITCH",
    "x": 1112.5,
    "y": 349.88
  }
],
  links: [
  {
    "id": "r-link-1",
    "label": "Enlace 1",
    "a": "r23",
    "b": "r16",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 34000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 34
    },
    "bToA": {
      "bps": 28000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 28
    },
    "curvature": 0
  },
  {
    "id": "r-link-2",
    "label": "Enlace 2",
    "a": "r23",
    "b": "r24",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 62000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 62
    },
    "bToA": {
      "bps": 41000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 41
    },
    "curvature": 0
  },
  {
    "id": "r-link-3",
    "label": "Enlace 3",
    "a": "r16",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 94000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 94
    },
    "bToA": {
      "bps": 71000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 71
    },
    "curvature": 0
  },
  {
    "id": "r-link-4",
    "label": "Enlace 4",
    "a": "r16",
    "b": "r11",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 45000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 45
    },
    "bToA": {
      "bps": 46000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 46
    },
    "curvature": 0
  },
  {
    "id": "r-link-5",
    "label": "Enlace 5",
    "a": "r17",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 55000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 55
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "parcial (simulado)"
  },
  {
    "id": "r-link-6",
    "label": "Enlace 6",
    "a": "r18",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "down",
    "aToB": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "DOWN (simulado)"
  },
  {
    "id": "r-link-7",
    "label": "Enlace 7",
    "a": "r08",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 44000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 44
    },
    "bToA": {
      "bps": 39000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 39
    },
    "curvature": 0,
    "tag": "stale (simulado)"
  },
  {
    "id": "r-link-8",
    "label": "Enlace 8",
    "a": "r08",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 12000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 12
    },
    "bToA": {
      "bps": 9000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 9
    },
    "curvature": 0
  },
  {
    "id": "r-link-9",
    "label": "Enlace 9",
    "a": "r08",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 34000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 34
    },
    "bToA": {
      "bps": 28000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 28
    },
    "curvature": 0
  },
  {
    "id": "r-link-10",
    "label": "Enlace 10",
    "a": "r22",
    "b": "r25",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 62000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 62
    },
    "bToA": {
      "bps": 41000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 41
    },
    "curvature": 0
  },
  {
    "id": "r-link-11",
    "label": "Enlace 11",
    "a": "r25",
    "b": "r24",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 94000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 94
    },
    "bToA": {
      "bps": 71000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 71
    },
    "curvature": 0
  },
  {
    "id": "r-link-12",
    "label": "Enlace 12",
    "a": "r25",
    "b": "r19",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 45000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 45
    },
    "bToA": {
      "bps": 46000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 46
    },
    "curvature": 0
  },
  {
    "id": "r-link-13",
    "label": "Enlace 13",
    "a": "r21",
    "b": "r18",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 55000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 55
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "parcial (simulado)"
  },
  {
    "id": "r-link-14",
    "label": "Enlace 14",
    "a": "r08",
    "b": "r01",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "sem telemetria (simulada)"
  },
  {
    "id": "r-link-15",
    "label": "Enlace 15",
    "a": "r08",
    "b": "r02",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": 88000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 44
    },
    "bToA": {
      "bps": 78000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 39
    },
    "curvature": 0,
    "tag": "stale (simulado)"
  },
  {
    "id": "r-link-16",
    "label": "Enlace 16",
    "a": "r14",
    "b": "r10",
    "capacityBps": 10000000000,
    "status": "up",
    "aToB": {
      "bps": 1200000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 12
    },
    "bToA": {
      "bps": 900000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 9
    },
    "curvature": 0
  },
  {
    "id": "r-link-17",
    "label": "Enlace 17",
    "a": "r09",
    "b": "r08",
    "capacityBps": 400000000000,
    "status": "up",
    "aToB": {
      "bps": 136000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 34
    },
    "bToA": {
      "bps": 112000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 28
    },
    "curvature": 0
  },
  {
    "id": "r-link-18",
    "label": "Enlace 18",
    "a": "r12",
    "b": "r13",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": 124000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 62
    },
    "bToA": {
      "bps": 82000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 41
    },
    "curvature": 0
  },
  {
    "id": "r-link-19",
    "label": "Enlace 19",
    "a": "r13",
    "b": "r07",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": 188000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 94
    },
    "bToA": {
      "bps": 142000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 71
    },
    "curvature": 0
  },
  {
    "id": "r-link-20",
    "label": "Enlace 20",
    "a": "r03",
    "b": "r08",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 45000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 45
    },
    "bToA": {
      "bps": 46000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 46
    },
    "curvature": 0
  },
  {
    "id": "r-link-21",
    "label": "Enlace 21",
    "a": "r14",
    "b": "r15",
    "capacityBps": 10000000000,
    "status": "up",
    "aToB": {
      "bps": 5500000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 55
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "parcial (simulado)"
  },
  {
    "id": "r-link-22",
    "label": "Enlace 22",
    "a": "r13",
    "b": "r12",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "sem telemetria (simulada)"
  },
  {
    "id": "r-link-23",
    "label": "Enlace 23",
    "a": "r13",
    "b": "r14",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 44000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 44
    },
    "bToA": {
      "bps": 39000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 39
    },
    "curvature": 0,
    "tag": "stale (simulado)"
  },
  {
    "id": "r-link-24",
    "label": "Enlace 24",
    "a": "r13",
    "b": "r05",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": 24000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 12
    },
    "bToA": {
      "bps": 18000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 9
    },
    "curvature": 0
  },
  {
    "id": "r-link-25",
    "label": "Enlace 25",
    "a": "r08",
    "b": "r04",
    "capacityBps": 60000000000,
    "status": "up",
    "aToB": {
      "bps": 20400000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 34
    },
    "bToA": {
      "bps": 16800000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 28
    },
    "curvature": -31.63
  },
  {
    "id": "r-link-26",
    "label": "Enlace 26",
    "a": "r12",
    "b": "r22",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 62000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 62
    },
    "bToA": {
      "bps": 41000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 41
    },
    "curvature": 0
  },
  {
    "id": "r-link-27",
    "label": "Enlace 27",
    "a": "r12",
    "b": "r19",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 94000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 94
    },
    "bToA": {
      "bps": 71000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 71
    },
    "curvature": 0
  },
  {
    "id": "r-link-28",
    "label": "Enlace 28",
    "a": "r20",
    "b": "r13",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 45000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 45
    },
    "bToA": {
      "bps": 46000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 46
    },
    "curvature": 0
  },
  {
    "id": "r-link-29",
    "label": "Enlace 29",
    "a": "r12",
    "b": "r11",
    "capacityBps": 100000000000,
    "status": "up",
    "aToB": {
      "bps": 55000000000,
      "sampleAgeSeconds": 25,
      "observedRxPercent": 55
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0.43,
    "tag": "parcial (simulado)"
  },
  {
    "id": "r-link-30",
    "label": "Enlace 30",
    "a": "r13",
    "b": "r19",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "bToA": {
      "bps": null,
      "sampleAgeSeconds": null,
      "observedRxPercent": null
    },
    "curvature": 0,
    "tag": "sem telemetria (simulada)"
  },
  {
    "id": "r-link-31",
    "label": "Enlace 31",
    "a": "r12",
    "b": "r06",
    "capacityBps": 200000000000,
    "status": "up",
    "aToB": {
      "bps": 88000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 44
    },
    "bToA": {
      "bps": 78000000000,
      "sampleAgeSeconds": 700,
      "observedRxPercent": 39
    },
    "curvature": -25.38,
    "tag": "stale (simulado)"
  }
],
  demoLinkId: "r-link-1",
  demoLagGroupId: null,
};
