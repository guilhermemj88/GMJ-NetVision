import type { HostRepository } from '../persistence/host-repository';
import type { SnmpService } from './snmp-service';

export class SnmpPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: HostRepository,
    private readonly snmp: SnmpService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const hosts = await this.repository.listHosts();
      for (const host of hosts) {
        if (!host.snmpEnabled || host.snmp?.version !== 'SNMP_V2C') continue;
        try {
          await this.snmp.pollHost(host);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Falha desconhecida no polling SNMP';
          await this.repository.updateSourceHealth(host.id, {
            source: 'SNMP',
            state: 'FAILED',
            message,
            checkedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
