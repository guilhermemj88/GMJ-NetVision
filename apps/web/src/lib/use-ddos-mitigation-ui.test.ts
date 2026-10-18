/**
 * Hook de disponibilidade da aba de mitigação (cliente).
 *
 * O hook combina a decisão do BUILD (identidade inlinada) com a confirmação de
 * `GET /installation`. Regras verificadas aqui:
 *  - runtime respondeu → manda;
 *  - runtime não respondeu (sem rede/erro) → mantém o build;
 *  - payload inválido nunca liga o módulo;
 *  - a rota é consultada no máximo uma vez e nunca quando o build já habilitou.
 */

import { describe, expect, it } from 'vitest';
import {
  ddosMitigationFromPayload,
  resolveDdosMitigationUiEnabled,
} from './use-ddos-mitigation-ui';

describe('payload de /installation', () => {
  it('lê somente o booleano do módulo', () => {
    expect(
      ddosMitigationFromPayload({ modules: { ddosMitigation: { enabled: true } } }),
    ).toBe(true);
    expect(
      ddosMitigationFromPayload({ modules: { ddosMitigation: { enabled: false } } }),
    ).toBe(false);
  });

  it('payload inválido não habilita nada', () => {
    for (const payload of [
      null,
      undefined,
      'texto',
      42,
      {},
      { modules: {} },
      { modules: { ddosMitigation: {} } },
      { modules: { ddosMitigation: { enabled: 'true' } } },
      { modules: { ddosMitigation: { enabled: 1 } } },
    ]) {
      expect(ddosMitigationFromPayload(payload)).toBeNull();
    }
  });
});

describe('modo efetivo', () => {
  it('runtime confirmado vence o build', () => {
    expect(resolveDdosMitigationUiEnabled(false, true)).toBe(true);
    expect(resolveDdosMitigationUiEnabled(true, false)).toBe(false);
  });

  it('sem resposta de runtime fica o que o build decidiu', () => {
    expect(resolveDdosMitigationUiEnabled(true, null)).toBe(true);
    expect(resolveDdosMitigationUiEnabled(false, null)).toBe(false);
  });
});
