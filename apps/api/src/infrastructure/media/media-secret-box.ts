import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CredentialVault } from '../../application/credential-vault';

/**
 * Guarda de segredos da camada de midias.
 *
 * Reusa exatamente a mesma criptografia das credenciais SSH/SNMP
 * (AES-256-GCM via `CredentialVault`). O token de saida PRECISA ser reversivel
 * (ele e enviado ao n8n no header); o de entrada tambem e comparado em tempo
 * constante contra o valor decifrado. Em nenhum caso o texto claro e
 * persistido, logado ou devolvido pela API depois de salvo.
 */
export interface MediaSecretBox {
  /** `false` quando nao ha chave de criptografia configurada no ambiente. */
  readonly available: boolean;
  encrypt(plain: string): Uint8Array;
  decrypt(payload: Uint8Array | null): string | null;
}

export function createMediaSecretBox(vault: CredentialVault | null): MediaSecretBox {
  if (!vault) {
    const missing = (): never => {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY nao configurada: segredos indisponiveis');
    };
    return {
      available: false,
      encrypt: missing,
      decrypt: () => null,
    };
  }
  return {
    available: true,
    encrypt: (plain) => new Uint8Array(vault.encrypt({ token: plain })),
    decrypt: (payload) => {
      if (!payload) return null;
      try {
        const decoded = vault.decrypt(payload);
        const token = decoded.token;
        return typeof token === 'string' && token.length > 0 ? token : null;
      } catch {
        // Payload corrompido/chave trocada: trata como "sem segredo".
        return null;
      }
    },
  };
}

/**
 * Token de integracao: 32 bytes aleatorios em base64url.
 * Mostrado UMA vez na UI e nunca mais recuperado em texto claro por ela.
 */
export function generateIntegrationToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Comparacao em tempo constante, sem vazar tamanho/posicao. */
export function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Destino seguro para log: apenas `scheme://host`.
 *
 * URLs de webhook do n8n costumam carregar o proprio segredo no path/query;
 * por isso nem path nem query entram no log operacional.
 */
export function safeDestination(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}
