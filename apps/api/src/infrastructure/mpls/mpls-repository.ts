import type { MplsHostOverview, MplsPw, MplsStateEvent, MplsVsi } from '@gmj/shared';
import type { HuaweiVplsCollection } from './huawei-vpls-snmp';

export interface MplsRepository {
  saveCollection(hostId: string, collection: HuaweiVplsCollection): Promise<void>;
  /**
   * Avanca apenas o carimbo do polling. Usado na rodada em que a CLI ainda esta
   * no intervalo de cadencia: sem evidencia nova, nada de estado e sobrescrito.
   */
  touchPolling(hostId: string, occurredAt: Date): Promise<void>;
  saveFailure(hostId: string, occurredAt: Date, safeMessage: string): Promise<void>;
  getHostOverview(hostId: string): Promise<MplsHostOverview>;
  listVsis(hostId: string): Promise<MplsVsi[]>;
  listPws(hostId: string, vsiId: string): Promise<MplsPw[] | null>;
  listEvents(hostId: string, limit: number): Promise<MplsStateEvent[]>;
  disconnect?(): Promise<void>;
}
