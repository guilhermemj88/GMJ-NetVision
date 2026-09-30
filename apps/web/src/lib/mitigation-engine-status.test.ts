import { describe, expect, it } from 'vitest';
import { mitigationEngineStatus } from './mitigation-labels';

describe('banner do motor de mitigacao', () => {
  it('sem health => MOTOR EM MODO DE SIMULACAO', () => {
    const status = mitigationEngineStatus(null);
    expect(status.title).toBe('🧪 MOTOR EM MODO DE SIMULAÇÃO');
    expect(status.simulationOnly).toBe(true);
    expect(status.autoActive).toBe(false);
    expect(status.liveWriteLabel).toBe('NÃO');
    expect(status.executorLabel).toBe('MOCK');
  });

  it('AUTO mas liveWrite=false => AUTO ARMADO (nunca "ativo")', () => {
    const status = mitigationEngineStatus({
      mode: 'AUTO',
      executor: 'HUAWEI',
      liveWriteEnabled: false,
    });
    expect(status.title).toBe('⏸ AUTO ARMADO — ESCRITA DESABILITADA');
    expect(status.autoArmed).toBe(true);
    expect(status.autoActive).toBe(false);
    expect(status.tone).toBe('warning');
    expect(status.liveWriteLabel).toBe('NÃO');
  });

  it('AUTO + MOCK + liveWrite=true continua ARMADO (executor nao e HUAWEI)', () => {
    const status = mitigationEngineStatus({
      mode: 'AUTO',
      executor: 'MOCK',
      liveWriteEnabled: true,
    });
    expect(status.autoArmed).toBe(true);
    expect(status.autoActive).toBe(false);
  });

  it('AUTO + HUAWEI + liveWrite=true => MOTOR AUTOMATICO ATIVO', () => {
    const status = mitigationEngineStatus({
      mode: 'AUTO',
      executor: 'HUAWEI',
      liveWriteEnabled: true,
    });
    expect(status.title).toBe('🤖 MOTOR AUTOMÁTICO ATIVO');
    expect(status.autoActive).toBe(true);
    expect(status.simulationOnly).toBe(false);
    expect(status.tone).toBe('success');
    expect(status.liveWriteLabel).toBe('SIM');
  });
});