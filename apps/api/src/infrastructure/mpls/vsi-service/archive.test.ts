import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VsiServiceResultArchive, type ArchiveOptions } from './archive';

const result = (runId: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  runId,
  origin: 'REPLAY',
  vsiName: 'VSI-TESTE',
  completedAt: '2026-11-17T00:00:00.000Z',
  verdict: { status: 'INCONCLUSIVE' },
  endpoints: [],
  findings: [],
  evidence: [],
  ...extra,
});

/** stat falso: o teste roda no Windows, onde o modo POSIX nao existe. */
function fakeStat(map: Record<string, { mode: number; uid?: number; kind?: 'file' | 'dir' | 'link' }>, dir: string): NonNullable<ArchiveOptions['lstat']> {
  return (path) => {
    const key = path === dir ? '.' : path.slice(dir.length + 1);
    const e = map[key] ?? { mode: 0o644 };
    const kind = e.kind ?? (key === '.' ? 'dir' : 'file');
    return { isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link', size: 100, mode: e.mode, uid: e.uid ?? 0 };
  };
}

function folder(files: Record<string, unknown | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vsi-ro-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

describe('diretorio de resultados restrito e somente leitura (fail-closed)', () => {
  it('pasta 0755 root com arquivos 0644: lista os resultados e a auditoria nao aponta problema', () => {
    const dir = folder({ 'a.json': result('replay-a') });
    const archive = new VsiServiceResultArchive(dir, { enforceModes: true, uid: 1000, lstat: fakeStat({ '.': { mode: 0o755 }, 'a.json': { mode: 0o644 } }, dir) });
    expect(archive.list().map((d) => d.runId)).toEqual(['replay-a']);
    expect(archive.audit()).toEqual({ ok: true, issues: [] });
  });

  it('pasta gravavel por grupo ou outros: a pasta inteira e ignorada (lista vazia) e a auditoria acusa', () => {
    for (const mode of [0o775, 0o757, 0o777, 0o722]) {
      const dir = folder({ 'a.json': result('replay-a') });
      const archive = new VsiServiceResultArchive(dir, { enforceModes: true, uid: 0, lstat: fakeStat({ '.': { mode } }, dir) });
      expect(archive.list(), mode.toString(8)).toEqual([]);
      expect(archive.audit().issues.join(' ')).toContain('pasta: gravavel por grupo/outros');
    }
  });

  it('arquivo gravavel por terceiros, symlink ou de outro dono: so ele e ignorado', () => {
    const dir = folder({ 'ok.json': result('replay-ok'), 'aberto.json': result('replay-aberto'), 'link.json': result('replay-link'), 'alheio.json': result('replay-alheio') });
    const archive = new VsiServiceResultArchive(dir, {
      enforceModes: true,
      uid: 1000,
      lstat: fakeStat({ '.': { mode: 0o755 }, 'ok.json': { mode: 0o644, uid: 1000 }, 'aberto.json': { mode: 0o666 }, 'link.json': { mode: 0o777, kind: 'link' }, 'alheio.json': { mode: 0o644, uid: 4242 } }, dir),
    });
    expect(archive.list().map((d) => d.runId)).toEqual(['replay-ok']);
    const issues = archive.audit().issues.join(' | ');
    expect(issues).toContain('aberto.json: gravavel por grupo/outros');
    expect(issues).toContain('link.json: symlink');
    expect(issues).toContain('alheio.json: dono inesperado');
  });

  it('auditoria: arquivo que nao e resultado (extensao, JSON invalido, formato) quebra a auditoria', () => {
    const dir = folder({ 'a.json': result('replay-a'), 'notas.txt': 'texto', 'lixo.json': '{ nao e json', 'outro.json': { schemaVersion: 2 } });
    const issues = new VsiServiceResultArchive(dir, { enforceModes: false }).audit();
    expect(issues.ok).toBe(false);
    expect(issues.issues.join(' | ')).toMatch(/notas\.txt: nao e um resultado/);
    expect(issues.issues.join(' | ')).toMatch(/lixo\.json: JSON invalido/);
    expect(issues.issues.join(' | ')).toMatch(/outro\.json: nao e um resultado VSI valido/);
  });

  it('pasta inexistente: lista vazia, sem excecao; auditoria acusa', () => {
    const archive = new VsiServiceResultArchive(join(tmpdir(), 'nao-existe-vsi'), { enforceModes: false });
    expect(archive.list()).toEqual([]);
    expect(archive.audit().ok).toBe(false);
  });

  it('o arquivo so le: a classe nao expoe nenhuma operacao de escrita', () => {
    const methods = Object.getOwnPropertyNames(VsiServiceResultArchive.prototype).sort();
    expect(methods).toEqual(['audit', 'constructor', 'get', 'list', 'untrusted']);
  });
});
