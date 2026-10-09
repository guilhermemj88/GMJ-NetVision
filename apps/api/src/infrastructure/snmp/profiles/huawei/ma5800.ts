import type { SnmpProfile } from '../types';
import { huaweiOpticalCapability } from '../../../topology/huawei-optical';
import { huaweiGenericProfile } from './generic';

/**
 * Huawei MA5800-X15 (access, V100R022C11 SPC200) - IIE-VSR-X15-OLT-01.
 *
 * Evidencia de campo 2026-10-09: o agente NAO implementa a subarvore
 * HUAWEI-ENTITY-EXTENT-MIB de optica (`1.3.6.1.4.1.2011.5.25.31.1.1.3` =
 * No Such Object nas duas formas: get e walk) e nao implementa
 * HUAWEI-DEVICE-EXT-MIB. A optica PON/ONT desta familia e dominio da XPON MIB
 * (fase futura) - aqui a declaracao explicita `UNSUPPORTED` garante que nenhum
 * walk de .8-.41 e tentado contra a OLT.
 */
export const huaweiMa5800Profile: SnmpProfile = {
  id: 'huawei-ma5800',
  vendor: 'Huawei',
  family: 'MA5800',
  priority: 260,
  vendorPatterns: [/huawei/i],
  modelPatterns: [/MA5800/i],
  sysDescrPatterns: [/Integrated Access Software/i],
  sysObjectIdPatterns: [/^\.?1\.3\.6\.1\.4\.1\.2011\.2\.316$/],
  optical: huaweiOpticalCapability({
    scalarEncoding: 'UNSUPPORTED',
    scalarSemantics: 'UNKNOWN',
    laneEncoding: 'UNSUPPORTED',
    laneBiasEncoding: 'UNSUPPORTED',
    alarmThresholdEncoding: 'UNSUPPORTED',
    warningThresholdEncoding: 'UNSUPPORTED',
    minMaxEncoding: 'UNSUPPORTED',
  }),
  metrics: huaweiGenericProfile.metrics,
};