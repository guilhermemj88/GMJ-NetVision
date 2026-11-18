/**
 * M-D (2a auditoria): PRE-DEPLOY read-only do cadastro.
 *
 * Inventaria vendor/model dos dispositivos que hoje estao autorizados para AUTO
 * e para administracao BGP e mostra QUEM PERDERIA a autorizacao com a politica
 * fail-closed (M1/M2/P4). NAO corrige cadastro, NAO altera allowlist, NAO
 * executa comando em equipamento e NAO liga/desliga AUTO-ALL.
 *
 * Uso:
 *   npm run platform:preflight            # tabela legivel
 *   npm run platform:preflight -- --json  # saida para automacao
 *
 * Codigo de saida: 0 = ninguem perde autorizacao; 1 = ha dispositivo a revisar
 * (use como gate antes de publicar); 2 = falha ao ler o banco.
 */
import { PrismaClient } from '../generated/prisma';
import { mitigationExecutionConfigFromEnv } from '../infrastructure/bgp/mitigation/mitigation-execution-config';
import {
  evaluatePlatformInventory,
  type InventoryDeviceInput,
} from '../infrastructure/platform/platform-inventory';
import { SINGLE_AUTO_PILOT } from '../worker/mitigation/single-pilot-trigger';

async function main(): Promise<number> {
  const json = process.argv.includes('--json');
  const prisma = new PrismaClient();

  try {
    const devices = await prisma.device.findMany({
      select: {
        id: true,
        hostname: true,
        vendor: true,
        model: true,
        deviceType: true,
        bgpMonitoringEnabled: true,
      },
      orderBy: { hostname: 'asc' },
    });

    const peerCounts = await prisma.bgpPeer.groupBy({
      by: ['deviceId'],
      _count: { _all: true },
    });
    const peersByDevice = new Map(peerCounts.map((row) => [row.deviceId, row._count._all]));

    // Tabela de policies pode nao existir em banco antigo: leitura tolerante.
    const profiles: { deviceId: string; policyName: string; enabled: boolean }[] = await prisma
      .bgpMitigationProfile.findMany({
        select: { deviceId: true, policyName: true, enabled: true },
      })
      .catch(() => []);

    const allowlist = new Set(mitigationExecutionConfigFromEnv().allowedDeviceIds);

    const input: InventoryDeviceInput[] = devices.map((device) => ({
      id: device.id,
      hostname: device.hostname,
      vendor: device.vendor,
      model: device.model,
      deviceType: device.deviceType,
      bgpMonitoringEnabled: device.bgpMonitoringEnabled,
      bgpPeers: peersByDevice.get(device.id) ?? 0,
      autoPolicies: profiles
        .filter((profile) => profile.deviceId === device.id)
        .map((profile) => `${profile.policyName}${profile.enabled ? '' : ' (desabilitada)'}`),
      inMitigationAllowlist: allowlist.has(device.id),
      // P4-a: o piloto AUTO-ALL entra na checklist mesmo sem profile no banco.
      inSinglePilot:
        device.id === SINGLE_AUTO_PILOT.deviceId ||
        device.hostname.trim().toLowerCase() === SINGLE_AUTO_PILOT.hostname.trim().toLowerCase(),
    }));

    const report = evaluatePlatformInventory(input);

    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('HOST'.padEnd(30), 'PLATAFORMA'.padEnd(15), 'CONTEXTOS'.padEnd(20), 'PERDE'.padEnd(12), 'MOTIVO');
      for (const row of report.rows) {
        console.log(
          row.hostname.slice(0, 29).padEnd(30),
          row.platform.padEnd(15),
          (row.contexts.join(',') || '-').padEnd(20),
          (row.loses.join(',') || '-').padEnd(12),
          row.reason,
        );
      }
      console.log('');
      console.log(
        `RESUMO: ${report.summary.devices} dispositivo(s) com contexto de autorizacao; ` +
          `${report.summary.losing} perderiam autorizacao.`,
      );
      console.log('Plataformas:', JSON.stringify(report.summary.byPlatform));
      if (report.blocking) {
        console.log(
          '\nACAO NECESSARIA: revise o cadastro (vendor/model) dos dispositivos com "PERDE".' +
            '\nEste script NAO corrige nada — a correcao e manual e consciente.',
        );
      }
    }

    return report.blocking ? 1 : 0;
  } catch (error) {
    console.error('Falha ao ler o banco (nenhuma escrita foi tentada):', error instanceof Error ? error.message : error);
    return 2;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code));
