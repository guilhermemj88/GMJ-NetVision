import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config do renderer de snapshot', () => {
  it('usa America/Sao_Paulo como fuso padrao (horario operacional)', () => {
    expect(loadConfig({}).timeZone).toBe('America/Sao_Paulo');
  });

  it('respeita SNAPSHOT_TIME_ZONE customizado (IANA, com trim)', () => {
    expect(loadConfig({ SNAPSHOT_TIME_ZONE: 'America/Manaus' }).timeZone).toBe('America/Manaus');
    expect(loadConfig({ SNAPSHOT_TIME_ZONE: '  Europe/Lisbon  ' }).timeZone).toBe('Europe/Lisbon');
  });

  it('variavel vazia nunca deixa o contexto sem fuso', () => {
    expect(loadConfig({ SNAPSHOT_TIME_ZONE: '   ' }).timeZone).toBe('America/Sao_Paulo');
    expect(loadConfig({ SNAPSHOT_TIME_ZONE: '' }).timeZone).toBe('America/Sao_Paulo');
  });
});
