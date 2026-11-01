import { derivePreservedClauses, type PreservedClauses } from './mitigation-policy-clauses';

/**
 * TEST-ONLY: `PreservedClauses` deterministico equivalente a um cliente cujo
 * node normal e `permit node 10 if-match ip-prefix <lista autorizada>` sem
 * atributos extras.
 *
 * Existe porque o executor REAL deriva esse objeto do equipamento e o builder
 * se recusa a gerar comandos sem ele. Executores FALSOS dos testes usam este
 * helper para espelhar exatamente esse contrato — nunca para afrouxar o
 * builder.
 */
export function testPreservedClauses(
  policyName: string,
  targetPrefixList: string,
  rt: string,
): PreservedClauses {
  const text = [
    `route-policy ${policyName} permit node 10`,
    ` if-match ip-prefix ${targetPrefixList}`,
  ].join('\n');
  return derivePreservedClauses(text, policyName, targetPrefixList, rt);
}
