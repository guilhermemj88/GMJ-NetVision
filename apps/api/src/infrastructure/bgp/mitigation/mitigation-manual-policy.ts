/**
 * Politica de escrita MANUAL por perfil (RBAC de escopo). Variavel: MITIGATION_MANUAL_ALLOWED_PROFILE_IDS
 * (lista separada por virgula). Fail-closed: com a escrita fisica LIGADA a lista e OBRIGATORIA — o processo
 * nao sobe sem ela (um VIEWER ou um token vazado nunca alcanca perfis fora da lista). Com a escrita desligada
 * (HOLD) a lista e opcional.
 */
export interface ManualProfilePolicy {
  allowedProfileIds: readonly string[];
}

export function manualProfilePolicyFromEnv(
  env: NodeJS.ProcessEnv,
  liveWriteEnabled: boolean,
): ManualProfilePolicy | undefined {
  const list = (env['MITIGATION_MANUAL_ALLOWED_PROFILE_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (list.length === 0) {
    if (liveWriteEnabled)
      throw Error('MITIGATION_MANUAL_ALLOWED_PROFILE_IDS_REQUIRED_WITH_LIVE_WRITE');
    return undefined;
  }
  if (list.some((id) => !/^[A-Za-z0-9_.:-]{1,160}$/.test(id)))
    throw Error('MITIGATION_MANUAL_ALLOWED_PROFILE_IDS_INVALID');
  return { allowedProfileIds: [...new Set(list)] };
}
