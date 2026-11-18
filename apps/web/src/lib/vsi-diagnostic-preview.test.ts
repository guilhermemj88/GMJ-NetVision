import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicPath } from '../app/providers';
import { isVsiDiagnosticPreviewEnabled } from './vsi-diagnostic-preview';

/**
 * A pre-visualizacao do Diagnostico VSI/VPLS e sem sessao e mostra fixtures com nomes reais de
 * equipamentos: so pode existir em `next dev`.
 */
describe('pre-visualizacao do Diagnostico VSI/VPLS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('em producao a rota esta desligada e exige sessao', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isVsiDiagnosticPreviewEnabled()).toBe(false);
    expect(isPublicPath('/vsi-diagnostic-preview')).toBe(false);
  });

  it('nenhuma flag de build a religa: nem o modo preview, nem uma flag propria', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', 'true');
    vi.stubEnv('NEXT_PUBLIC_VSI_DIAGNOSTIC_PREVIEW', 'true');
    expect(isVsiDiagnosticPreviewEnabled()).toBe(false);
    expect(isPublicPath('/vsi-diagnostic-preview')).toBe(false);
  });

  it('fora de development (ex.: test) tambem fica desligada', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(isVsiDiagnosticPreviewEnabled()).toBe(false);
    expect(isPublicPath('/vsi-diagnostic-preview')).toBe(false);
  });

  it('so em next dev fica disponivel sem sessao, e nao abre nenhuma outra rota', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(isVsiDiagnosticPreviewEnabled()).toBe(true);
    expect(isPublicPath('/vsi-diagnostic-preview')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/physical')).toBe(false);
  });

  it('a pagina chama notFound() antes de montar qualquer coisa', () => {
    const page = readFileSync(resolve(process.cwd(), 'src/app/vsi-diagnostic-preview/page.tsx'), 'utf8');
    expect(page).toMatch(/if \(!isVsiDiagnosticPreviewEnabled\(\)\) notFound\(\);/);
    expect(page.indexOf('notFound();')).toBeLessThan(page.indexOf('<VsiServicePreview'));
  });

  it('as fixtures nunca sao importadas por componente de cliente (nao vao para /_next/static)', () => {
    const dir = resolve(process.cwd(), 'src/components/diagnostics/service');
    const offenders = readdirSync(dir)
      .filter((name) => /\.tsx?$/.test(name) && !name.includes('.test.'))
      .filter((name) => {
        const source = readFileSync(join(dir, name), 'utf8');
        return /^'use client';/m.test(source) && /from '\.\/fixtures\//.test(source);
      });
    expect(offenders).toEqual([]);
    const preview = readFileSync(join(dir, 'service-preview.tsx'), 'utf8');
    expect(preview).not.toMatch(/'use client'/);
  });

  it('nao ha link para a pre-visualizacao no app', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(d, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(d, entry.name)] : [],
      );
    const allowed = ['vsi-diagnostic-preview', 'providers.tsx'];
    const linking = walk(resolve(process.cwd(), 'src'))
      .filter((file) => !allowed.some((a) => file.includes(a)))
      .filter((file) => readFileSync(file, 'utf8').includes('/vsi-diagnostic-preview'));
    expect(linking).toEqual([]);
  });
});
