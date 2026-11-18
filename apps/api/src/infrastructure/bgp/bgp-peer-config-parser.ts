/**
 * `display current-configuration configuration bgp` e a unica fonte que traz,
 * ao mesmo tempo, o AS remoto e a descricao de cada peer. O `display bgp peer`
 * nao tem descricao, e foi por isso que a tela ficava com "AS -" e nome vazio.
 *
 * Formato real (Huawei NE40E):
 *
 *   peer 172.16.16.7 as-number 28306
 *   peer 172.16.16.7 description VOLUY-MH
 *   peer 172.16.16.7 ebgp-max-hop 4
 *
 * As linhas de um mesmo peer nao sao necessariamente adjacentes, por isso o
 * resultado e indexado pelo endereco.
 */
export interface BgpPeerConfiguration {
  address: string;
  remoteAs: number | null;
  description: string | null;
}

const AS_NUMBER = /^\s*peer\s+(\S+)\s+as-number\s+(\d+)\s*$/;
const DESCRIPTION = /^\s*peer\s+(\S+)\s+description\s+(.+?)\s*$/;

function key(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Normaliza a descricao de um peer como o VRP a escreve: `-` e vazio nao sao
 * nomes, e as aspas que o equipamento usa quando a descricao tem espacos ou
 * caracteres especiais sao sintaxe do comando, nao parte do nome.
 */
export function normalizePeerDescription(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '-') return null;
  const unquoted = /^".*"$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
  return unquoted || null;
}

export function parseBgpPeerConfiguration(output: string): Map<string, BgpPeerConfiguration> {
  const peers = new Map<string, BgpPeerConfiguration>();
  const entry = (address: string): BgpPeerConfiguration => {
    const normalized = key(address);
    const existing = peers.get(normalized);
    if (existing) return existing;
    const created: BgpPeerConfiguration = {
      address: address.trim(),
      remoteAs: null,
      description: null,
    };
    peers.set(normalized, created);
    return created;
  };

  for (const line of output.split(/\r?\n/)) {
    const asNumber = line.match(AS_NUMBER);
    if (asNumber?.[1] && asNumber[2]) {
      const parsed = Number(asNumber[2]);
      if (Number.isSafeInteger(parsed) && parsed > 0) entry(asNumber[1]).remoteAs = parsed;
      continue;
    }
    const description = line.match(DESCRIPTION);
    if (description?.[1] && description[2]) {
      const parsed = normalizePeerDescription(description[2]);
      if (parsed !== null) entry(description[1]).description = parsed;
    }
  }

  return peers;
}
