/**
 * LABORATORIO: processo-filho com o piloto canonico (lifecycle + comando canonico + executor Huawei real, SO a borda SSH
 * e falsa) sobre o journal/ownership em PostgreSQL REAL. Faz a escrita simulada e TRAVA para sempre logo depois dela
 * (a "morte" acontece com o comando ja no equipamento simulado). O ensaio da SIGKILL e reabre o journal com um processo
 * novo. NENHUM equipamento real.
 */
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaAutomationStore } from '../../worker/mitigation/automation-store';
import { createPilotHarness } from '../single-pilot-harness';

const mark = (m: string) => process.stdout.write(JSON.stringify({ m, t: Date.now() }) + '\n');
const db = new PrismaClient({ datasourceUrl: process.env.SHUTDOWN_LAB_DATABASE_URL! });

async function main() {
  const h = await createPilotHarness(new PrismaAutomationStore(db));
  h.ssh.afterWrite = async () => {
    mark('WRITE_DONE_AWAITING');
    await new Promise(() => undefined); // nunca retorna: o processo sera morto aqui
  };
  for (let i = 0; i < 3; i++) {
    h.sample(9_500_000_000n);
    await h.lifecycle.tickPilot();
  }
  mark('UNEXPECTED_COMPLETION');
}
void main().catch((e) => {
  process.stdout.write(JSON.stringify({ m: 'FATAL', e: String(e) }) + '\n');
  process.exit(2);
});
