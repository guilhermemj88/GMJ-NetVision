/**
 * Identidade da instalação e disponibilidade do módulo de mitigação DDoS.
 *
 * O foco destes testes é a regra do operador: a IMPLANTAR disponibiliza a aba
 * BGP → Mitigação DDoS de forma PERMANENTE, inclusive em builds feitos sem a
 * flag `NEXT_PUBLIC_DDOS_MITIGATION_UI` — que foi exatamente a regressão que
 * desligou a aba na produção. As demais instalações seguem desabilitadas.
 */

import { describe, expect, it } from 'vitest';
import {
  IMPLANTAR_HOSTNAME,
  IMPLANTAR_INSTALLATION_ID,
  isDdosMitigationModuleEnabled,
  normalizeInstallationToken,
  parseInstallationId,
  resolveInstallationIdentity,
  resolveInstallationModuleAvailability,
} from './installation-identity';

describe('normalização da identidade', () => {
  it('aceita caixa e domínio, rejeita vazio e não-string', () => {
    expect(normalizeInstallationToken('netvision-implantar')).toBe('netvision-implantar');
    expect(normalizeInstallationToken('  NetVision-IMPLANTAR  ')).toBe('netvision-implantar');
    expect(normalizeInstallationToken('netvision-implantar.localdomain')).toBe(
      'netvision-implantar',
    );
    expect(normalizeInstallationToken('')).toBeNull();
    expect(normalizeInstallationToken('   ')).toBeNull();
    expect(normalizeInstallationToken(null)).toBeNull();
    expect(normalizeInstallationToken(undefined)).toBeNull();
    expect(normalizeInstallationToken(42)).toBeNull();
  });

  it('reconhece a identidade configurada nos formatos usuais', () => {
    expect(parseInstallationId('implantar')).toBe('IMPLANTAR');
    expect(parseInstallationId('IMPLANTAR')).toBe('IMPLANTAR');
    expect(parseInstallationId(' Implantar ')).toBe('IMPLANTAR');
    expect(parseInstallationId('fibinet')).toBe('UNKNOWN');
    expect(parseInstallationId('')).toBe('UNKNOWN');
    expect(parseInstallationId(null)).toBe('UNKNOWN');
  });
});

describe('identidade da instalação', () => {
  it('o hostname canônico identifica a IMPLANTAR', () => {
    expect(IMPLANTAR_HOSTNAME).toBe('netvision-implantar');
    expect(IMPLANTAR_INSTALLATION_ID).toBe('implantar');
    const identity = resolveInstallationIdentity({ hostname: 'netvision-implantar' });
    expect(identity).toEqual({
      id: 'IMPLANTAR',
      source: 'hostname',
      hostname: 'netvision-implantar',
    });
  });

  it('identidade configurada vence o hostname', () => {
    const identity = resolveInstallationIdentity({
      hostname: 'algum-servidor',
      installationId: 'implantar',
    });
    expect(identity.id).toBe('IMPLANTAR');
    expect(identity.source).toBe('installation-id');
  });

  it('qualquer outro hostname é instalação desconhecida', () => {
    for (const hostname of ['fibinet', 'netvision-vnt', 'netvision-implantar-2', 'localhost', '']) {
      const identity = resolveInstallationIdentity({ hostname });
      expect(identity.id).toBe('UNKNOWN');
      expect(identity.source).toBe('none');
    }
    expect(resolveInstallationIdentity({}).id).toBe('UNKNOWN');
  });

  it('identidade configurada desconhecida não bloqueia a identificação por hostname', () => {
    const identity = resolveInstallationIdentity({
      hostname: 'netvision-implantar',
      installationId: 'outra-coisa',
    });
    expect(identity.id).toBe('IMPLANTAR');
    expect(identity.source).toBe('hostname');
  });
});

describe('disponibilidade do módulo de mitigação DDoS', () => {
  it('IMPLANTAR: habilitado SEM a flag de build (regressão que desligou a aba)', () => {
    const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
      hostname: 'netvision-implantar',
    });
    expect(available.enabled).toBe(true);
    expect(available.reason).toBe('installation-implantar');
    expect(available.inputs).toEqual({
      hostname: 'netvision-implantar',
      installationId: null,
      flag: null,
    });
  });

  it('IMPLANTAR: habilitado mesmo com a flag explícita em false', () => {
    for (const flag of ['false', '', null, undefined, false, '0']) {
      const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
        hostname: 'netvision-implantar',
        flag,
      });
      expect(available.enabled).toBe(true);
      expect(available.reason).toBe('installation-implantar');
    }
  });

  it('IMPLANTAR: habilitado pela identidade configurada, com qualquer hostname', () => {
    const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
      hostname: 'qualquer-host',
      installationId: 'implantar',
    });
    expect(available.enabled).toBe(true);
    expect(available.reason).toBe('installation-implantar');
  });

  it('outra instalação: desabilitado sem opt-in explícito', () => {
    for (const hostname of ['fibinet', 'netvision-vnt', 'localhost', null]) {
      const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
        hostname,
      });
      expect(available.enabled).toBe(false);
      expect(available.reason).toBe('installation-not-implantar');
    }
  });

  it('outra instalação: habilitado apenas com opt-in explícito `true`', () => {
    for (const flag of ['true', ' TRUE ', true]) {
      const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
        hostname: 'fibinet',
        flag,
      });
      expect(available.enabled).toBe(true);
      expect(available.reason).toBe('explicit-flag');
    }
    // Qualquer outro valor não liga o módulo.
    for (const flag of ['1', 'yes', 'sim', 'false', '', false]) {
      expect(
        resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', { hostname: 'fibinet', flag })
          .enabled,
      ).toBe(false);
    }
  });

  it('atalho booleano concorda com a resolução completa', () => {
    expect(isDdosMitigationModuleEnabled({ hostname: 'netvision-implantar' })).toBe(true);
    expect(isDdosMitigationModuleEnabled({ hostname: 'fibinet' })).toBe(false);
    expect(isDdosMitigationModuleEnabled({ hostname: 'fibinet', flag: 'true' })).toBe(true);
  });

  it('não vaza dados sensíveis na estrutura de diagnóstico', () => {
    const available = resolveInstallationModuleAvailability('DDOS_MITIGATION_UI', {
      hostname: 'netvision-implantar',
      installationId: 'implantar',
      flag: 'true',
    });
    expect(Object.keys(available.inputs).sort()).toEqual(['flag', 'hostname', 'installationId']);
    expect(JSON.stringify(available)).not.toContain('password');
    expect(JSON.stringify(available)).not.toContain('token');
  });
});
