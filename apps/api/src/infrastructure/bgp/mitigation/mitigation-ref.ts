import { createHash } from 'node:crypto';

/**
 * REFERENCIA DA MITIGACAO (vinculo da retirada a UMA ativacao especifica).
 *
 * O evento MITIGATION_VERIFIED identifica a ativacao pelo `eventId` (operacao AUTO ou
 * requestId manual). A referencia e um resumo curto e opaco desse id: cabe no `callback_data`
 * do Telegram (limite de 64 bytes, junto com o comando e o profileId) e nao expoe o id interno.
 * Um botao de retirada carrega a referencia da mitigacao que o gerou; o NetVision so executa o
 * REMOVE se ela for a mitigacao ATIVA do escopo naquele momento.
 */
export const MITIGATION_REF_PATTERN = /^[a-f0-9]{16}$/;

export function mitigationRefOf(activationEventId: string): string {
  return createHash('sha256')
    .update('netvision-mitigation-ref:' + activationEventId)
    .digest('hex')
    .slice(0, 16);
}
