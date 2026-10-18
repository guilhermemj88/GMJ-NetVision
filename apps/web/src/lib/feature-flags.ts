/**
 * Flags de apresentação do NetVision geral.
 *
 * Não alteram banco, migrations, API nem contratos: decidem apenas o que a UI
 * normal expõe. O valor é resolvido em tempo de build (`NEXT_PUBLIC_*`), então
 * o mesmo flag vale para o servidor e para o cliente — mesmo padrão de
 * `lib/preview-mode.ts`.
 */

import {
  resolveInstallationModuleAvailability,
  type InstallationModuleAvailability,
} from '@gmj/shared';

/**
 * Mitigação DDoS na interface — decidida pela IDENTIDADE DA INSTALAÇÃO.
 *
 * Regra do produto (adendo de identificação da IMPLANTAR):
 *  - instalação IMPLANTAR → aba BGP → Mitigação DDoS disponível DE FORMA
 *    PERMANENTE, independentemente de a flag de build ter sido definida;
 *  - demais instalações → módulo oculto, salvo opt-in explícito
 *    (`NEXT_PUBLIC_DDOS_MITIGATION_UI=true`).
 *
 * Por que a identidade e não só a flag: um release construído numa worktree sem
 * `.env` perde a flag e a aba desaparece da produção da IMPLANTAR — regressão
 * que a identidade da instalação (e os testes) impedem de repetir.
 *
 * `next.config.ts` injeta `NEXT_PUBLIC_INSTALLATION_HOSTNAME` (hostname do
 * servidor no build) e `NEXT_PUBLIC_INSTALLATION_ID` (identidade configurada),
 * deixando a decisão disponível no cliente. Em tempo de execução,
 * `GET /installation` confirma a identidade real do servidor.
 *
 * O módulo, a API, as migrations e os testes de backend continuam no
 * repositório — nada é removido; só a exposição normal fica condicionada.
 */
export function resolveDdosMitigationUiAvailability(): InstallationModuleAvailability {
  return resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
    hostname: process.env.NEXT_PUBLIC_INSTALLATION_HOSTNAME ?? null,
    installationId: process.env.NEXT_PUBLIC_INSTALLATION_ID ?? null,
    flag: process.env.NEXT_PUBLIC_DDOS_MITIGATION_UI ?? null,
  });
}

export function isDdosMitigationUiEnabled(): boolean {
  return resolveDdosMitigationUiAvailability().enabled;
}
