import type { SnmpProfile } from '../types';
import { huaweiGenericProfile } from './generic';

export const huaweiS6730Profile: SnmpProfile = {
  id: 'huawei-s6730',
  vendor: 'Huawei',
  family: 'S6730',
  priority: 220,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/S6730/i],
  sysDescrPatterns: [/S6730/i],
  metrics: huaweiGenericProfile.metrics,
};
