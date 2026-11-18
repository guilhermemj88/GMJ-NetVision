import type { HostRecord } from '@gmj/shared';

export const HOST_RESULT_LIMIT = 50;

type SearchableHost = Pick<HostRecord, 'id' | 'name'> & Partial<Pick<HostRecord, 'displayName' | 'hostname' | 'detectedHostname' | 'managementIp' | 'ip'>>;

const norm = (value: string | null | undefined): string => (value ?? '').toLowerCase().trim();

/** IP de exibicao: o de gerenciamento, senao o ip do dispositivo. */
export function hostAddress(host: SearchableHost): string {
  return (host.managementIp || host.ip || '').trim();
}

/**
 * Pesquisa por NOME (nome, nome de exibicao, hostname) ou IP (parcial, ex.: "10.20" ou "20.1"), sem diferenciar
 * maiusculas. Varios termos separados por espaco precisam casar todos (ex.: "vta 6730"). Trabalha sobre a lista real
 * ja carregada de /api/hosts: nao inventa equipamentos e nao dispara nenhuma consulta ao equipamento.
 */
export function searchHosts<T extends SearchableHost>(hosts: readonly T[], query: string): { items: T[]; total: number } {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const matched = hosts.filter((host) => {
    if (terms.length === 0) return true;
    const haystack = [host.name, host.displayName, host.hostname, host.detectedHostname, hostAddress(host)].map(norm).join('\n');
    return terms.every((term) => haystack.includes(term));
  });
  const sorted = [...matched].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  return { items: sorted.slice(0, HOST_RESULT_LIMIT), total: sorted.length };
}
