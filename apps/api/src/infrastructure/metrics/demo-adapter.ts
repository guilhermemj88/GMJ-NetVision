import {
  createDemoHistory,
  demoDevices,
  type Device,
  type HistoryPeriod,
  type MetricPoint,
  type NetworkInterface,
} from '@gmj/shared';
import type { MetricSourceAdapter } from '../../domain/ports';

export class DemoMetricAdapter implements MetricSourceAdapter {
  readonly kind = 'DEMO' as const;

  async getDevices(): Promise<Device[]> {
    return structuredClone(demoDevices);
  }

  async getDevice(id: string): Promise<Device | null> {
    return structuredClone(demoDevices.find((device) => device.id === id) ?? null);
  }

  async getInterfaces(deviceId: string): Promise<NetworkInterface[]> {
    return structuredClone(demoDevices.find((device) => device.id === deviceId)?.interfaces ?? []);
  }

  async getInterface(id: string): Promise<NetworkInterface | null> {
    return structuredClone(
      demoDevices.flatMap((device) => device.interfaces).find((item) => item.id === id) ?? null,
    );
  }

  async getMetrics(interfaceId: string): Promise<Record<string, number | string>> {
    const item = await this.getInterface(interfaceId);
    if (!item) return {};
    return {
      'interface.rx.bps': item.rxBps,
      'interface.tx.bps': item.txBps,
      'interface.rx.utilization': item.rxUtilization,
      'interface.tx.utilization': item.txUtilization,
      'interface.errors.rx': item.rxErrors,
      'interface.errors.tx': item.txErrors,
      'interface.discards.rx': item.rxDiscards,
      'interface.discards.tx': item.txDiscards,
      'interface.status': item.operStatus,
    };
  }

  async getHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]> {
    return createDemoHistory(interfaceId, period);
  }
}
