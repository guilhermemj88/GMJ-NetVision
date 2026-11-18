import { assertReadOnlyCommand } from '../../worker/mitigation/read-only-command-guard';

/**
 * Comandos de leitura da descoberta VSI/VPLS.
 *
 * Todo comando passa pela allowlist read-only antes de existir. O nome da VSI
 * so pode chegar aqui vindo da configuracao/CLI do proprio equipamento, e ainda
 * assim e validado por padrao estrito — nunca ha interpolacao livre.
 */

const VSI_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;

export function assertVsiName(name: string): string {
  const trimmed = name.trim();
  if (!VSI_NAME_PATTERN.test(trimmed)) {
    throw new Error('Nome de VSI invalido para leitura');
  }
  return trimmed;
}

export const VSI_SUMMARY_COMMAND = assertReadOnlyCommand('display vsi');
export const VSI_VERBOSE_COMMAND = assertReadOnlyCommand('display vsi verbose');
export const LDP_SESSIONS_COMMAND = assertReadOnlyCommand('display mpls ldp session');
export const LDP_REMOTE_PEERS_COMMAND = assertReadOnlyCommand('display mpls ldp remote-peer');
export const L2VC_COMMAND = assertReadOnlyCommand('display mpls l2vc');

export function vsiVerboseByNameCommand(name: string): string {
  return assertReadOnlyCommand(`display vsi name ${assertVsiName(name)} verbose`);
}
