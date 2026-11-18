import type { HostRecord } from '@gmj/shared';
import { bgpPlatformFor, isHuaweiVrpDevice } from '../bgp-vendor';
import type { MitigationSshPort } from './huawei-mitigation-executor';

/**
 * M1 (auditoria): o executor de mitigacao fala Huawei VRP — `system-view`,
 * `route-policy`, `commit`. Nenhuma dessas linhas pode chegar a um Junos, a uma
 * OLT ou a um equipamento cujo fabricante nao foi identificado.
 *
 * O gate fica no UNICO ponto por onde passa todo o SSH do executor (a porta
 * `MitigationSshPort`), entao vale para leitura E escrita — sem depender de
 * flag de UI, de allowlist de worker ou do caminho que chamou.
 */
export function assertMitigationPlatform(device: HostRecord, operation: string): void {
  if (!isHuaweiVrpDevice(device)) {
    throw new Error(
      `MITIGATION_PLATFORM_NOT_SUPPORTED: ${operation} recusada — plataforma ` +
        `${bgpPlatformFor(device?.vendor, device?.model)}${device?.deviceType === 'olt' ? '/OLT' : ''}`,
    );
  }
}

export function createPlatformGuardedMitigationSsh(port: MitigationSshPort): MitigationSshPort {
  return {
    async readMitigationConfiguration(device) {
      assertMitigationPlatform(device, 'leitura de configuracao de mitigacao');
      return port.readMitigationConfiguration(device);
    },
    async readMitigationRoutePolicy(device, policyName) {
      assertMitigationPlatform(device, 'leitura de route-policy');
      return port.readMitigationRoutePolicy(device, policyName);
    },
    async applyMitigationCommands(device, commands) {
      assertMitigationPlatform(device, 'escrita de mitigacao');
      return port.applyMitigationCommands(device, commands);
    },
    async readMitigationDisplays(device, commands) {
      assertMitigationPlatform(device, 'leitura de evidencia fisica');
      return port.readMitigationDisplays(device, commands);
    },
  };
}
