/**
 * Disponibilidade da mitigação DDoS decidida pela IDENTIDADE DA INSTALAÇÃO.
 *
 * Estes testes são a proteção contra a regressão que desligou a aba na
 * produção: um build da IMPLANTAR feito SEM `NEXT_PUBLIC_DDOS_MITIGATION_UI`
 * continua habilitando BGP → Mitigação DDoS. Nas demais instalações o módulo
 * permanece oculto, salvo opt-in explícito.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isDdosMitigationUiEnabled,
  resolveDdosMitigationUiAvailability,
} from './feature-flags';

const ENV_KEYS = [
  'NEXT_PUBLIC_INSTALLATION_HOSTNAME',
  'NEXT_PUBLIC_INSTALLATION_ID',
  'NEXT_PUBLIC_DDOS_MITIGATION_UI',
] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('mitigação DDoS × identidade da instalação', () => {
  afterEach(() => {
    setEnv({});
    vi.unstubAllEnvs();
  });

  it('IMPLANTAR habilita a aba mesmo SEM a flag de build (regressão da produção)', () => {
    // Cenário exato do release quebrado: worktree sem .env, build sem a flag.
    setEnv({ NEXT_PUBLIC_INSTALLATION_HOSTNAME: 'netvision-implantar' });
    expect(isDdosMitigationUiEnabled()).toBe(true);
    expect(resolveDdosMitigationUiAvailability().reason).toBe('installation-implantar');
  });

  it('IMPLANTAR continua habilitada com a flag explicitamente em false', () => {
    setEnv({
      NEXT_PUBLIC_INSTALLATION_HOSTNAME: 'netvision-implantar',
      NEXT_PUBLIC_DDOS_MITIGATION_UI: 'false',
    });
    expect(isDdosMitigationUiEnabled()).toBe(true);
  });

  it('IMPLANTAR pode ser reconhecida pela identidade configurada', () => {
    setEnv({
      NEXT_PUBLIC_INSTALLATION_HOSTNAME: 'qualquer-host',
      NEXT_PUBLIC_INSTALLATION_ID: 'implantar',
    });
    const available = resolveDdosMitigationUiAvailability();
    expect(available.enabled).toBe(true);
    expect(available.identity.source).toBe('installation-id');
  });

  it('outras instalações seguem sem a aba', () => {
    for (const hostname of ['fibinet', 'netvision-vnt', 'localhost']) {
      setEnv({ NEXT_PUBLIC_INSTALLATION_HOSTNAME: hostname });
      expect(isDdosMitigationUiEnabled()).toBe(false);
      expect(resolveDdosMitigationUiAvailability().reason).toBe('installation-not-implantar');
    }
    setEnv({});
    expect(isDdosMitigationUiEnabled()).toBe(false);
  });

  it('outras instalações só habilitam com opt-in explícito', () => {
    setEnv({
      NEXT_PUBLIC_INSTALLATION_HOSTNAME: 'fibinet',
      NEXT_PUBLIC_DDOS_MITIGATION_UI: 'true',
    });
    const available = resolveDdosMitigationUiAvailability();
    expect(available.enabled).toBe(true);
    expect(available.reason).toBe('explicit-flag');
  });

  it('hostname com domínio/caixa não engana a decisão', () => {
    setEnv({ NEXT_PUBLIC_INSTALLATION_HOSTNAME: 'NetVision-IMPLANTAR.localdomain' });
    expect(isDdosMitigationUiEnabled()).toBe(true);
  });

  it('a decisão não depende de hostname parecido por prefixo', () => {
    for (const hostname of ['netvision-implantar-2', 'netvision-implantarx', 'implantar']) {
      setEnv({ NEXT_PUBLIC_INSTALLATION_HOSTNAME: hostname });
      expect(isDdosMitigationUiEnabled()).toBe(false);
    }
  });

  it('diagnóstico não expõe segredos', () => {
    setEnv({ NEXT_PUBLIC_INSTALLATION_HOSTNAME: 'netvision-implantar' });
    const serialized = JSON.stringify(resolveDdosMitigationUiAvailability());
    expect(serialized).not.toMatch(/password|token|secret/i);
    expect(serialized).toContain('netvision-implantar');
  });
});
