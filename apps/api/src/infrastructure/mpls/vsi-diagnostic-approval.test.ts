import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VsiDiagnosticApprovalStore } from './vsi-diagnostic-approval';
import { VsiDiagnosticError } from './vsi-diagnostic-service';

const HOST = 'host-1';
const VSI = 'vsi-1';

function code(fn: () => unknown): number | 'OK' {
  try {
    fn();
    return 'OK';
  } catch (error) {
    return error instanceof VsiDiagnosticError ? error.statusCode : -1;
  }
}

describe('aprovacao one-shot do diagnostico VSI', () => {
  let dir: string;
  let store: VsiDiagnosticApprovalStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vsi-approval-'));
    store = new VsiDiagnosticApprovalStore(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cria e consome uma unica vez', () => {
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin' });
    expect(a.expiresAt > a.createdAt).toBe(true);
    expect(store.consume(a.approvalId, HOST, VSI).approvalId).toBe(a.approvalId);
    expect(code(() => store.consume(a.approvalId, HOST, VSI))).toBe(423);
  });

  it('rejeita aprovacao ausente', () => {
    expect(code(() => store.consume(undefined, HOST, VSI))).toBe(423);
    expect(code(() => store.consume('', HOST, VSI))).toBe(423);
  });

  it('rejeita id inexistente e id fora do formato', () => {
    expect(code(() => store.consume(randomUUID(), HOST, VSI))).toBe(423);
    expect(code(() => store.consume('../../etc/passwd', HOST, VSI))).toBe(423);
  });

  it('rejeita host ou VSI diferente do autorizado', () => {
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin' });
    expect(code(() => store.consume(a.approvalId, 'host-2', VSI))).toBe(423);
    expect(code(() => store.consume(a.approvalId, HOST, 'vsi-2'))).toBe(423);
    expect(store.consume(a.approvalId, HOST, VSI).approvalId).toBe(a.approvalId);
  });

  it('rejeita aprovacao expirada', () => {
    const now = Date.now();
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin', ttlSeconds: 30, now });
    expect(code(() => store.consume(a.approvalId, HOST, VSI, now + 30_001))).toBe(423);
    expect(store.consume(a.approvalId, HOST, VSI, now + 29_000).approvalId).toBe(a.approvalId);
  });

  it('duas requisicoes concorrentes: apenas uma consome', () => {
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin' });
    const results = [1, 2].map(() => code(() => store.consume(a.approvalId, HOST, VSI)));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 423)).toHaveLength(1);
  });

  it('rejeita arquivo corrompido ou adulterado', () => {
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin' });
    writeFileSync(join(dir, `${a.approvalId}.json`), '{"approvalId":"x"}');
    expect(code(() => store.consume(a.approvalId, HOST, VSI))).toBe(423);
  });

  it('limita o TTL ao maximo permitido', () => {
    const now = Date.now();
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin', ttlSeconds: 999_999, now });
    expect(Date.parse(a.expiresAt) - now).toBe(900_000);
  });

  it('nao deixa .consumed quando a validacao falha antes do consumo', () => {
    const a = store.create({ hostId: HOST, vsiId: VSI, createdBy: 'admin' });
    code(() => store.consume(a.approvalId, 'host-2', VSI));
    expect(readdirSync(dir).some((n) => n.endsWith('.consumed'))).toBe(false);
    expect(store.consume(a.approvalId, HOST, VSI).approvalId).toBe(a.approvalId);
  });
});
