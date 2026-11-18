import type { DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type { DeviceIdentity, SshDeviceDriver } from '../../domain/ports';

/**
 * Driver SSH READ-ONLY para Juniper Junos (MX series e afins).
 *
 * Regras que valem para tudo aqui:
 *
 *  - SO leitura. Nenhum comando de configuracao (`configure`, `set`, `delete`,
 *    `commit`, `request`, `clear`) e gerado por este driver.
 *  - Nenhum comando especifico de equipamento: o mesmo driver atende qualquer
 *    Junos, sem regra por IP ou hostname.
 *  - Todo comando termina em `| no-more`. Sem isso o Junos pagina com
 *    `---(more)---` e o transporte enxerga a saida como incompleta.
 *  - Nada e inventado. Sem evidencia no texto, o campo fica ausente/`0`.
 */

/** `show lldp` imprime `LLDP : Disabled` quando o protocolo esta desligado. */
const LLDP_DISABLED = /^[ \t]*LLDP[ \t]*:[ \t]*disabled\b/im;

/** Cabecalho (`Local Interface ... System Name`) e separadores de `show lldp neighbors`. */
const LLDP_HEADER = /\b(local\s+interface|chassis\s+id|system\s+name)\b/i;
const SEPARATOR = /^[-=\s]+$/;

/**
 * `show interfaces terse` / `show interfaces descriptions`:
 *
 * ```
 * Interface               Admin Link Proto    Local                 Remote
 * ae0                     up    up
 * ae0.3                   up    up   inet    10.0.0.1/24
 * ge-0/0/0                up    down
 * ```
 *
 * `show interfaces descriptions` acrescenta a coluna final (alias), por isso o
 * mesmo padrao cobre os dois comandos: o resto da linha e descartado quando
 * nao e alias.
 */
const INTERFACE_LINE = /^([A-Za-z][\w./-]*)\s+(up|down)\s+(up|down)\s*(.*)$/;

/** Cabecalho da secao de descricoes; separa os dois comandos no texto unido. */
const DESCRIPTION_HEADER = /^Interface\s+Admin\s+Link\s+Description\s*$/m;

/** Nome de interface Junos: `ge-0/0/0`, `xe-1/2/3`, `ae0`, `ae0.1101`, `lo0.0`. */
const JUNOS_INTERFACE = /^(?:[a-z]{2,4}-\d+(?:\/\d+){1,3}|(?:ae|lo|irb|vlan|em|fxp)\d+)(?:\.\d+)?$/;

function isLldpDisabled(output: string): boolean {
  return LLDP_DISABLED.test(output);
}

function looksLikeInterface(value: string | undefined): boolean {
  return Boolean(value && JUNOS_INTERFACE.test(value));
}

export class JuniperJunosDriver implements SshDeviceDriver {
  readonly vendor = 'Juniper Junos';

  identityCommands(): string[] {
    return ['show version | no-more', 'show chassis hardware | no-more'];
  }

  interfaceCommands(): string[] {
    return ['show interfaces terse | no-more', 'show interfaces descriptions | no-more'];
  }

  neighborCommands(): string[] {
    return ['show lldp neighbors | no-more'];
  }

  neighborFallbackCommands(): string[] {
    return ['show lldp neighbors detail | no-more'];
  }

  /**
   * LLDP desligado e um estado valido do equipamento, nao falha do transporte:
   * nao vale gastar um segundo comando nem marcar o SSH como degradado.
   */
  shouldFallbackNeighborCommand(output: string): boolean {
    if (isLldpDisabled(output)) return false;
    if (this.parseNeighbors('probe', output).length > 0) return false;
    return !/no\s+lldp\s+neighbou?rs?/i.test(output);
  }

  parseIdentity(output: string): DeviceIdentity {
    const hostname = output.match(/^Hostname:\s*(\S+)/m)?.[1]?.trim();
    const versionModel = output.match(/^Model:\s*(\S+)/m)?.[1]?.trim();
    const junos = output.match(/^Junos:\s*([^\r\n]+)/m)?.[1]?.trim();

    // `show chassis hardware` -> "Chassis   JN122311DAFC   MX240"
    const chassis = output.match(/^Chassis\s+([A-Za-z0-9]{4,})\s+(\S+)\s*$/m);
    const chassisSerial = chassis?.[1]?.trim();
    const chassisModel = chassis?.[2]?.trim();

    // O Junos imprime o modelo em minusculas (`mx240`); o inventario usa a
    // grafia da plataforma. Normalizamos sem inventar: se o comando nao trouxe
    // modelo, o campo fica ausente.
    const model = (versionModel ?? chassisModel)?.toUpperCase();

    return {
      ...(hostname ? { hostname } : {}),
      vendor: 'Juniper',
      ...(model ? { model } : {}),
      ...(junos ? { systemDescription: `Juniper Junos ${junos}` } : {}),
      ...(chassisSerial ? { chassisId: chassisSerial } : {}),
    };
  }

  parseInterfaces(deviceId: string, output: string): NetworkInterface[] {
    const descriptionHeader = DESCRIPTION_HEADER.exec(output);
    const terseSection = descriptionHeader ? output.slice(0, descriptionHeader.index) : output;
    const descriptionSection = descriptionHeader
      ? output.slice(descriptionHeader.index + descriptionHeader[0].length)
      : '';

    const descriptions = this.parseAliases(descriptionSection);

    return terseSection.split(/\r?\n/).flatMap((line) => {
      const match = INTERFACE_LINE.exec(line);
      const name = match?.[1];
      if (!name || !looksLikeInterface(name) || !match?.[2] || !match[3]) return [];

      const adminUp = match[2].toLowerCase() === 'up';
      const linkUp = match[3].toLowerCase() === 'up';
      return [
        {
          // Identidade por NOME, nunca por um ifIndex de SSH: o SNMP e a fonte
          // de ifIndex deste equipamento e o merge correlaciona por nome.
          id: `${deviceId}-junos-${name}`,
          deviceId,
          name,
          alias: descriptions.get(name) ?? '',
          description: '',
          // Explicitamente desconhecido: o Junos nao expoe ifIndex nesses dois
          // comandos e inventar um indice corromperia a correlacao com o SNMP.
          ifIndex: 0,
          mac: '',
          mtu: 1500,
          speedBps: 0,
          adminStatus: adminUp ? 'UP' : 'DOWN',
          operStatus: !adminUp ? 'DISABLED' : linkUp ? 'UP' : 'DOWN',
          rxBps: 0,
          txBps: 0,
          rxUtilization: 0,
          txUtilization: 0,
          rxErrors: 0,
          txErrors: 0,
          rxDiscards: 0,
          txDiscards: 0,
          dataSources: ['SSH'],
        },
      ];
    });
  }

  /** Alias de `show interfaces descriptions` (`ae0  up  up  WAN`). */
  private parseAliases(section: string): Map<string, string> {
    const aliases = new Map<string, string>();
    if (!section) return aliases;
    for (const line of section.split(/\r?\n/)) {
      const match = INTERFACE_LINE.exec(line);
      const name = match?.[1];
      const alias = match?.[4]?.trim();
      if (!name || !alias || !looksLikeInterface(name)) continue;
      aliases.set(name, alias);
    }
    return aliases;
  }

  parseNeighbors(deviceId: string, output: string): DiscoveredNeighbor[] {
    // `LLDP : Disabled` e resposta legitima: zero vizinhos, sem erro.
    if (isLldpDisabled(output)) return [];

    return output.split(/\r?\n/).flatMap((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || SEPARATOR.test(trimmed) || LLDP_HEADER.test(trimmed)) return [];

      const parts = trimmed.split(/\s+/).filter(Boolean);
      // Layout padrao do Junos: Local Interface | Parent Interface |
      // Chassis Id | Port info | System Name. Uma linha com menos colunas esta
      // incompleta: descartar e obrigatorio, porque completar as lacunas aqui
      // seria inventar vizinho.
      if (parts.length < 5) return [];
      const localPort = parts[0];
      const chassisId = parts[2];
      const remotePort = parts[3];
      const remoteSystemName = parts.slice(4).join(' ');

      if (!looksLikeInterface(localPort)) return [];
      if (!remotePort || !remoteSystemName) return [];

      return [
        {
          id: `ssh-${deviceId}-junos-${index}`,
          localDeviceId: deviceId,
          localPort: localPort!,
          ...(chassisId ? { remoteChassisId: chassisId } : {}),
          remoteSystemName,
          remotePort,
          capabilities: [],
          source: 'LLDP_SSH' as const,
          matchStatus: 'UNMATCHED' as const,
        },
      ];
    });
  }
}
