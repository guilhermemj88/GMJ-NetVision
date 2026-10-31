/**
 * ESCOPO VERIFICADO — selecao de prefixos (funcao pura).
 *
 * Regra central: uma lista PARCIAL, ambigua ou de outro escopo nunca vira
 * mensagem. Ou a leitura e completa e coerente, ou `prefixes: null` +
 * `'prefixes'` em `fieldsUnavailable`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  selectMitigationScopePrefixes,
  type MitigationScopePrefixEvidence,
} from './mitigation-scope-prefixes';

const AGREEMENT = JSON.parse(
  readFileSync(
    new URL('../../../../../../docs/evidence/aglink-prefix-scope-fixture.json', import.meta.url),
    'utf8',
  ),
) as {
  profileId: string;
  policy: string;
  peer: string;
  receivedRoutes: string;
};

const AGLINK_PREFIXES = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];

const evidence = (
  over: Partial<MitigationScopePrefixEvidence> = {},
): MitigationScopePrefixEvidence => ({
  profileId: AGREEMENT.profileId,
  policy: AGREEMENT.policy,
  peer: AGREEMENT.peer,
  receivedRoutes: AGREEMENT.receivedRoutes,
  ...over,
});

const expected = (
  over: Partial<{
    profileId: string;
    policy: string;
    peer: string;
    addressFamily: 'IPV4' | 'IPV6';
  }> = {},
) => ({
  profileId: AGREEMENT.profileId,
  policy: AGREEMENT.policy,
  peer: AGREEMENT.peer,
  addressFamily: 'IPV4' as const,
  ...over,
});

const UNAVAILABLE = { prefixes: null, fieldsUnavailable: ['prefixes'] };

describe('escopo verificado: leitura completa gera a lista', () => {
  it('devolve os tres prefixos reais da AGLINK, ordenados', () => {
    const selected = selectMitigationScopePrefixes({ evidence: evidence(), expected: expected() });
    expect(selected.prefixes).toEqual(AGLINK_PREFIXES);
    expect(selected.fieldsUnavailable).toEqual([]);
  });

  it('sem ASN local conhecido a lista ainda e produzida', () => {
    // Producao: `getDeviceLocalAs` pode devolver null (ASN nao identificado).
    // O parser e null-safe e a lista nao pode depender do ASN.
    const selected = selectMitigationScopePrefixes({ evidence: evidence(), expected: expected() });
    expect(selected.prefixes).toEqual(AGLINK_PREFIXES);
  });

  it('deduplica e ordena sem inventar prefixo', () => {
    const duplicated = AGREEMENT.receivedRoutes
      .replace(' Total Number of Routes: 3', ' Total Number of Routes: 4')
      .replace(
        ' *>     167.250.127.0/24',
        ' *>     167.250.127.0/24   10.200.201.2                   0          1100       0      273811 273811i\n *>     167.250.126.0/23',
      );
    const selected = selectMitigationScopePrefixes({
      evidence: evidence({ receivedRoutes: duplicated }),
      expected: expected(),
    });
    expect(selected.prefixes).toEqual(AGLINK_PREFIXES);
  });
});

describe('escopo verificado: sem evidencia completa nao existe lista', () => {
  it('sem leitura (null) => null + campo indisponivel', () => {
    expect(selectMitigationScopePrefixes({ evidence: null, expected: expected() })).toEqual(
      UNAVAILABLE,
    );
  });

  it.each(['profileId', 'policy', 'peer'] as const)('escopo divergente em %s => null', (key) => {
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence({ [key]: 'wrong-scope' }),
        expected: expected(),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('readback parcial (total reportado maior que o interpretado) => null', () => {
    const partial = AGREEMENT.receivedRoutes.replace(
      'Total Number of Routes: 3',
      'Total Number of Routes: 4',
    );
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence({ receivedRoutes: partial }),
        expected: expected(),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('rota vinda de outro peer => null', () => {
    const foreign = AGREEMENT.receivedRoutes.replace(
      '167.250.127.0/24   10.200.201.2',
      '167.250.127.0/24   10.200.201.9',
    );
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence({ receivedRoutes: foreign }),
        expected: expected(),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('escopo vazio (peer sem rotas) => null', () => {
    const empty = [
      ' BGP Local router ID is 45.163.144.1',
      ' Total Number of Routes: 0',
      '        Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn',
      '<BHE-VTA-F1A-BGP-01>',
    ].join('\n');
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence({ receivedRoutes: empty }),
        expected: expected(),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('saida irreconhecivel => null (nunca lista vazia silenciosa)', () => {
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence({ receivedRoutes: 'ERROR: command not found' }),
        expected: expected(),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('notificacao IPv6 nao recebe evidencia IPv4', () => {
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence(),
        expected: expected({ addressFamily: 'IPV6' }),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('familia desconhecida => null', () => {
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence(),
        expected: expected({ addressFamily: null as never }),
      }),
    ).toEqual(UNAVAILABLE);
  });

  it('escopo esperado incompleto => null', () => {
    expect(
      selectMitigationScopePrefixes({
        evidence: evidence(),
        expected: expected({ peer: null as never }),
      }),
    ).toEqual(UNAVAILABLE);
  });
});
