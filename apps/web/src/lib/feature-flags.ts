/**
 * Flags de apresentação do NetVision geral.
 *
 * Não alteram banco, migrations, API nem contratos: decidem apenas o que a UI
 * normal expõe. O valor é resolvido em tempo de build (`NEXT_PUBLIC_*`), então
 * o mesmo flag vale para o servidor e para o cliente — mesmo padrão de
 * `lib/preview-mode.ts`.
 *
 * Somente o valor exato `"true"` LIGA a funcionalidade. Ausente, `"false"` ou
 * `"1"` mantêm o NetVision geral exatamente como está.
 */

/**
 * Mitigação DDoS na interface.
 *
 * Desligada (padrão) no NetVision geral: a aba/workspace de mitigação e os
 * controles operacionais de mitigação não aparecem. Ligada
 * (`NEXT_PUBLIC_DDOS_MITIGATION_UI=true`) no ambiente do projeto IMPLANTAR.
 *
 * O módulo, a API, as migrations e os testes de backend continuam no
 * repositório — nada é removido; só a exposição normal fica desligada.
 */
export function isDdosMitigationUiEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DDOS_MITIGATION_UI === 'true';
}
