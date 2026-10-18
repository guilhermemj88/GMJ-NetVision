/**
 * `GET /installation` — identidade em tempo de execução.
 *
 * Garante que o release publicado descubra a instalação real mesmo quando foi
 * construído em outra máquina/sem a flag, e que o payload não exponha segredos.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const hostnameMock = vi.hoisted(() => ({ value: 'netvision-implantar' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, hostname: () => hostnameMock.value };
});

import { GET } from './route';

async function payload(): Promise<{
  installation: { id: string; source: string; hostname: string | null };
  modules: { ddosMitigation: { enabled: boolean; reason: string } };
}> {
  const response = GET();
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json()) as never;
}

describe('GET /installation', () => {
  afterEach(() => {
    hostnameMock.value = 'netvision-implantar';
    delete process.env.NETVISION_INSTALLATION_ID;
    delete process.env.NETVISION_INSTALLATION_HOSTNAME;
    delete process.env.NEXT_PUBLIC_DDOS_MITIGATION_UI;
  });

  it('na IMPLANTAR (hostname real) habilita a mitigação sem flag', async () => {
    const body = await payload();
    expect(body.installation).toEqual({
      id: 'IMPLANTAR',
      source: 'hostname',
      hostname: 'netvision-implantar',
    });
    expect(body.modules.ddosMitigation).toEqual({
      enabled: true,
      reason: 'installation-implantar',
    });
  });

  it('em outra instalação mantém o módulo desabilitado', async () => {
    hostnameMock.value = 'fibinet';
    const body = await payload();
    expect(body.installation.id).toBe('UNKNOWN');
    expect(body.modules.ddosMitigation.enabled).toBe(false);
    expect(body.modules.ddosMitigation.reason).toBe('installation-not-implantar');
  });

  it('identidade configurada confirma a IMPLANTAR em qualquer hostname', async () => {
    hostnameMock.value = 'host-de-build';
    process.env.NETVISION_INSTALLATION_ID = 'implantar';
    const body = await payload();
    expect(body.installation.id).toBe('IMPLANTAR');
    expect(body.installation.source).toBe('installation-id');
    expect(body.modules.ddosMitigation.enabled).toBe(true);
  });

  it('opt-in explícito liga o módulo em outra instalação', async () => {
    hostnameMock.value = 'laboratorio';
    process.env.NEXT_PUBLIC_DDOS_MITIGATION_UI = 'true';
    const body = await payload();
    expect(body.modules.ddosMitigation).toEqual({ enabled: true, reason: 'explicit-flag' });
  });

  it('não devolve segredos do ambiente', async () => {
    process.env.NETVISION_MCP_PASSWORD = 'segredo-que-nao-pode-vazar';
    const serialized = JSON.stringify(await payload());
    expect(serialized).not.toContain('segredo-que-nao-pode-vazar');
    delete process.env.NETVISION_MCP_PASSWORD;
  });
});
