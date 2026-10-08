import { describe, expect, it } from 'vitest';
import { isAllowedSnapshotPath, isAllowedTarget } from '../src/allowlist.js';

const ORIGIN = 'http://127.0.0.1:3005';
const TOKEN = 'a'.repeat(40);

describe('allowlist do renderer', () => {
  it('aceita somente a origem interna configurada', () => {
    expect(isAllowedTarget(`${ORIGIN}/snapshot/${TOKEN}`, ORIGIN)).toBe(true);
    expect(isAllowedTarget(`http://127.0.0.1:3000/snapshot/${TOKEN}`, ORIGIN)).toBe(false);
    expect(isAllowedTarget(`http://localhost:3005/snapshot/${TOKEN}`, ORIGIN)).toBe(false);
    expect(isAllowedTarget(`http://169.254.169.254/latest/meta-data`, ORIGIN)).toBe(false);
    expect(isAllowedTarget(`https://evil.example/snapshot/${TOKEN}`, ORIGIN)).toBe(false);
  });

  it('recusa esquemas e credenciais embutidas na URL', () => {
    expect(isAllowedTarget(`file:///etc/passwd`, ORIGIN)).toBe(false);
    expect(isAllowedTarget(`gopher://127.0.0.1:3005/`, ORIGIN)).toBe(false);
    expect(isAllowedTarget(`http://user:pass@127.0.0.1:3005/snapshot/${TOKEN}`, ORIGIN)).toBe(false);
    expect(isAllowedTarget('nao-e-url', ORIGIN)).toBe(false);
  });

  it('so navega a pagina /snapshot/<token>, sem query nem outros caminhos', () => {
    expect(isAllowedSnapshotPath(`/snapshot/${TOKEN}`)).toBe(true);
    expect(isAllowedSnapshotPath(`/snapshot/curto`)).toBe(false);
    expect(isAllowedSnapshotPath(`/snapshot/${TOKEN}?x=1`)).toBe(false);
    expect(isAllowedSnapshotPath(`/api/public/snapshot/${TOKEN}`)).toBe(false);
    expect(isAllowedSnapshotPath(`/api/auth/me`)).toBe(false);
    expect(isAllowedSnapshotPath(`/snapshot/${TOKEN}/../../etc/passwd`)).toBe(false);
  });
});
