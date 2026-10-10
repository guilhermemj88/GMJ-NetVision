import type { HostRecord } from '@gmj/shared';

/**
 * Porta do refresh de METADATA das interfaces para o discovery MANUAL.
 *
 * O DESCOBRIR CLIENTES classifica clientes pela descricao da interface, entao
 * precisa do dado fresco do equipamento (SNMP IF-MIB + `display interface
 * description`). O refresh e um comando por device (nunca um SSH por peer) e
 * NAO coleta optica: a implementacao real vive fora desta camada.
 */
export interface MitigationInterfaceMetadataRefresh {
  /** Quantidade de interfaces persistidas apos o refresh. */
  interfaces: number;
}

export interface MitigationInterfaceMetadataRefresher {
  refresh(device: HostRecord): Promise<MitigationInterfaceMetadataRefresh>;
}
