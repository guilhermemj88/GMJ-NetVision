import { isIP } from 'node:net';
import { stripVTControlCharacters } from 'node:util';
export type VsiOperation =
  | { kind: 'VERSION' | 'LSR' | 'LOOPBACKS' }
  | { kind: 'VSI' | 'INTERFACE' | 'TRUNK'; argument: string }
  | { kind: 'PING' | 'TRACE'; source: string; destination: string };
export const VSI_OPERATION_KINDS = [
  'VERSION',
  'LSR',
  'LOOPBACKS',
  'VSI',
  'INTERFACE',
  'TRUNK',
  'PING',
  'TRACE',
] as const;
export function ipv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const first = Number(value.split('.')[0]);
  return first > 0 && first !== 127 && first < 224;
}
export function interfaceName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9-]{0,32}\d(?:[\d/]*\d)?(?:\.\d+)?$/.test(value);
}
export function parentInterface(value: string): string | null {
  return interfaceName(value) && value.includes('.')
    ? value.slice(0, value.lastIndexOf('.'))
    : null;
}
export function vsiCommand(operation: VsiOperation): string {
  switch (operation.kind) {
    case 'VERSION':
      return 'display version';
    case 'LSR':
      return 'display mpls ldp';
    case 'LOOPBACKS':
      return 'display ip interface brief';
    case 'VSI':
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(operation.argument)) throw new Error('UNSAFE_VSI_NAME');
      return `display vsi name ${operation.argument} verbose`;
    case 'INTERFACE':
      if (!interfaceName(operation.argument)) throw new Error('UNSAFE_INTERFACE');
      return `display interface ${operation.argument}`;
    case 'TRUNK':
      if (!/^\d{1,5}$/.test(operation.argument)) throw new Error('UNSAFE_TRUNK');
      return `display eth-trunk ${operation.argument}`;
    case 'PING':
    case 'TRACE':
      if (
        !ipv4(operation.source) ||
        !ipv4(operation.destination) ||
        operation.source === operation.destination
      )
        throw new Error('UNSAFE_PROBE');
      return operation.kind === 'PING'
        ? `ping -a ${operation.source} -c 3 ${operation.destination}`
        : `tracert -a ${operation.source} -m 8 -q 1 ${operation.destination}`;
  }
}
export function safeVsiOutput(value: string): string {
  return stripVTControlCharacters(value).replace(
    /^.*(?:password|passwd|secret|community|private.?key|cipher|DATABASE_URL)\b.*$/gim,
    '[REMOVIDO]',
  );
}
