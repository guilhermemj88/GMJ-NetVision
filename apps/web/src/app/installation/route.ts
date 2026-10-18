/**
 * IDENTIDADE DA INSTALAÇÃO EM TEMPO DE EXECUÇÃO — `GET /installation`.
 *
 * Existe para que a disponibilidade de módulos não dependa apenas do que foi
 * inlinado no build: um release gerado em outra máquina (ou sem a flag) ainda
 * descobre corretamente que está rodando na IMPLANTAR.
 *
 * Resposta (sem segredos):
 * {
 *   installation: { id: 'IMPLANTAR' | 'UNKNOWN', source, hostname },
 *   modules: { ddosMitigation: { enabled, reason } }
 * }
 *
 * O hostname é a identidade declarada da instalação (`netvision-implantar`) e
 * `NETVISION_INSTALLATION_ID` pode confirmar/sobrepor. Nada aqui autoriza ação:
 * as rotas de mitigação da API continuam exigindo sessão e o RBAC existente.
 *
 * Rota própria do Web (não passa pelo proxy `/api/*` da API 3333).
 */

import { hostname as osHostname } from 'node:os';
import { NextResponse } from 'next/server';
import { resolveInstallationModuleAvailability } from '@gmj/shared';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET(): NextResponse {
  const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
    hostname: process.env.NETVISION_INSTALLATION_HOSTNAME ?? osHostname(),
    installationId: process.env.NETVISION_INSTALLATION_ID ?? null,
    flag: process.env.NEXT_PUBLIC_DDOS_MITIGATION_UI ?? null,
  });

  return NextResponse.json(
    {
      installation: {
        id: available.identity.id,
        source: available.identity.source,
        hostname: available.identity.hostname,
      },
      modules: {
        ddosMitigation: {
          enabled: available.enabled,
          reason: available.reason,
        },
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
