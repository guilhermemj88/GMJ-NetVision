import type { ConnectionTestResult } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import type { SnmpService } from './snmp-service';

export class SnmpPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: HostRepository,
    private readonly service: SnmpService,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    // A varredura completa pode levar mais que o intervalo configurado.
    // Nunca permita ciclos sobrepostos: eles multiplicam consultas ao banco
    // e requisições SNMP e acabam bloqueando a API de inventário.
    if (this.running) return;
    this.running = true;

    try {
      const hosts = await this.repository.listHosts();
      for (const host of hosts) {
        if (!host.snmpEnabled || !host.snmp?.credentialConfigured) continue;
        try {
          await this.service.pollHost(host);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const result: ConnectionTestResult = {
            source: 'SNMP',
            state: message.toLowerCase().includes('timeout') ? 'TIMEOUT' : 'FAILED',
            message,
            checkedAt: new Date().toISOString(),
          };
          await this.repository.updateSourceHealth(host.id, result);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
