import {
  EMPTY_MPLS_SUMMARY,
  type MplsHostOverview,
  type MplsPw,
  type MplsStateEvent,
  type MplsVsi,
} from '@gmj/shared';
import type { HuaweiVplsCollection } from './huawei-vpls-snmp';
import type { MplsRepository } from './mpls-repository';

const unavailable = (): MplsHostOverview => ({
  supported: false,
  source: 'SNMP',
  lastPollingAt: null,
  lastSuccessAt: null,
  lastErrorSafe: null,
  summary: { ...EMPTY_MPLS_SUMMARY },
  vsis: [],
});

export class DemoMplsRepository implements MplsRepository {
  async saveCollection(_hostId: string, _collection: HuaweiVplsCollection): Promise<void> {}
  async saveFailure(_hostId: string, _occurredAt: Date, _safeMessage: string): Promise<void> {}
  async getHostOverview(_hostId: string): Promise<MplsHostOverview> {
    return unavailable();
  }
  async listVsis(_hostId: string): Promise<MplsVsi[]> {
    return [];
  }
  async listPws(_hostId: string, _vsiId: string): Promise<MplsPw[] | null> {
    return [];
  }
  async listEvents(_hostId: string, _limit: number): Promise<MplsStateEvent[]> {
    return [];
  }
}
