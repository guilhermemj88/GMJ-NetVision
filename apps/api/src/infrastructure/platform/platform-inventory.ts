import { bgpPlatformFor, isHuaweiVrpDevice, type BgpPlatform } from '../bgp/bgp-vendor';

/**
 * M-D (2a auditoria): inventario READ-ONLY de cadastro para pre-deploy.
 *
 * A politica nova (M1/M2/P4) exige que fabricante e modelo identifiquem um
 * Huawei VRP antes de qualquer comando Huawei. Este modulo responde, SEM tocar
 * no banco nem no equipamento: quais dispositivos autorizados hoje perderiam a
 * autorizacao depois da atualizacao e por que.
 *
 * Nada aqui corrige cadastro, altera allowlist ou executa comando.
 */
export type AuthorizationContext = 'AUTO' | 'BGP_ADMIN';

export interface InventoryDeviceInput {
  id: string;
  hostname: string;
  vendor: string | null;
  model: string | null;
  deviceType: string | null;
  /** BGP monitorado por este equipamento (polling/discovery). */
  bgpMonitoringEnabled: boolean;
  /** Quantidade de peers BGP persistidos. */
  bgpPeers: number;
  /** Policies AUTO (mitigacao) apontando para este equipamento. */
  autoPolicies: readonly string[];
  /** Presente em MITIGATION_ALLOWED_DEVICE_IDS. */
  inMitigationAllowlist: boolean;
  /**
   * P4-a (3a auditoria): alvo do piloto AUTO-ALL (F1A). Entra como contexto
   * AUTO mesmo sem profile persistido, para a checklist nunca omitir o
   * equipamento onde a mitigacao real roda.
   */
  inSinglePilot?: boolean;
}

export interface InventoryRow {
  id: string;
  hostname: string;
  vendor: string | null;
  model: string | null;
  deviceType: string | null;
  platform: BgpPlatform;
  contexts: AuthorizationContext[];
  /** Regra vigente antes desta rodada de correcoes. */
  authorizedBefore: AuthorizationContext[];
  /** Regra apos M1/M2/P4 (exige Huawei VRP comprovado). */
  authorizedAfter: AuthorizationContext[];
  loses: AuthorizationContext[];
  reason: string;
}

export interface InventoryReport {
  rows: InventoryRow[];
  summary: {
    devices: number;
    losing: number;
    byPlatform: Record<string, number>;
  };
  /** `true` quando algum dispositivo perderia autorizacao (gate de pre-deploy). */
  blocking: boolean;
}

/** Motivo legivel para a classificacao/negacao. */
export function platformReason(device: {
  vendor: string | null;
  model: string | null;
  deviceType: string | null;
}): string {
  const platform = bgpPlatformFor(device.vendor, device.model);
  if (platform === 'HUAWEI_VRP') {
    return isHuaweiVrpDevice(device) ? 'Huawei VRP confirmado' : 'modelo Huawei nao-VRP (OLT/BRAS)';
  }
  if (platform === 'JUNIPER_JUNOS') return 'Juniper (somente leitura)';
  const vendor = (device.vendor ?? '').trim();
  const model = (device.model ?? '').trim();
  if (!vendor && !model) return 'fabricante e modelo ausentes';
  if (!vendor) return 'fabricante ausente';
  if (device.deviceType === 'olt') return 'OLT nao executa VRP';
  return `fabricante/modelo nao suportados (${vendor || '-'} / ${model || '-'})`;
}

export function evaluatePlatformInventory(
  devices: readonly InventoryDeviceInput[],
): InventoryReport {
  const byPlatform: Record<string, number> = {};
  const rows: InventoryRow[] = [];

  for (const device of devices) {
    const platform = bgpPlatformFor(device.vendor, device.model);
    byPlatform[platform] = (byPlatform[platform] ?? 0) + 1;

    const contexts: AuthorizationContext[] = [];
    if (device.autoPolicies.length > 0 || device.inMitigationAllowlist || device.inSinglePilot) {
      contexts.push('AUTO');
    }
    if (device.bgpMonitoringEnabled || device.bgpPeers > 0) contexts.push('BGP_ADMIN');
    if (contexts.length === 0) continue;

    // Antes: AUTO = allowlist (sem plataforma); BGP_ADMIN = sem gate algum.
    const authorizedBefore = [...contexts];
    // Depois: qualquer envio de comando Huawei exige Huawei VRP comprovado.
    const authorizedAfter: AuthorizationContext[] = isHuaweiVrpDevice(device) ? [...contexts] : [];
    const loses = authorizedBefore.filter((context) => !authorizedAfter.includes(context));

    rows.push({
      id: device.id,
      hostname: device.hostname,
      vendor: device.vendor,
      model: device.model,
      deviceType: device.deviceType,
      platform,
      contexts,
      authorizedBefore,
      authorizedAfter,
      loses,
      reason: platformReason(device),
    });
  }

  const losing = rows.filter((row) => row.loses.length > 0).length;
  return {
    rows: rows.sort((a, b) => a.hostname.localeCompare(b.hostname)),
    summary: { devices: rows.length, losing, byPlatform },
    blocking: losing > 0,
  };
}
