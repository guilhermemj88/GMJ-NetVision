import type { SshDeviceDriver } from '../../domain/ports';
import { HuaweiVrpDriver } from '../topology/huawei-vrp-driver';
import { JuniperJunosDriver } from '../topology/juniper-junos-driver';

const HUAWEI_VRP = new HuaweiVrpDriver();
const JUNIPER_JUNOS = new JuniperJunosDriver();

export function isJuniperVendor(vendor: string | null | undefined): boolean {
  const value = (vendor ?? '').trim().toLowerCase();
  return value.includes('juniper') || value.includes('junos');
}

/**
 * Driver SSH usado na descoberta/enriquecimento de interfaces de UM host.
 *
 * Juniper recebe o driver Junos; todo o resto mantem o comportamento legado
 * (Huawei VRP), inclusive vendor vazio ou desconhecido — que sempre foi
 * atendido assim e nao deve regredir.
 */
export function sshDiscoveryDriverFor(vendor: string | null | undefined): SshDeviceDriver {
  return isJuniperVendor(vendor) ? JUNIPER_JUNOS : HUAWEI_VRP;
}
