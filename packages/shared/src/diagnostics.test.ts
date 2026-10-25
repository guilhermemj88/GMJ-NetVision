import { describe, expect, it } from 'vitest';
import { concludeDiagnosticRun, type DiagnosticRun, type DiagnosticTest } from './diagnostics';
const passed = { state: 'PASSED' } as DiagnosticTest;
const run = (
  state: DiagnosticRun['state'],
  tests: DiagnosticTest[] = [],
  findings: DiagnosticRun['findings'] = [],
) => ({ state, tests, findings });
describe('evidence-based overall conclusion', () => {
  it('never calls missing data healthy', () => {
    expect(concludeDiagnosticRun(run('COMPLETED'))).toBe('INCONCLUSIVE');
  });
  it('does not call partial or interrupted investigations healthy', () => {
    expect(concludeDiagnosticRun(run('PARTIAL', [passed]))).toBe('INCONCLUSIVE');
    expect(concludeDiagnosticRun(run('CANCELLED', [passed]))).toBe('INCONCLUSIVE');
  });
  it('only reports no anomalies for completed observations', () => {
    expect(concludeDiagnosticRun(run('COMPLETED', [passed]))).toBe('NO_ANOMALIES');
  });
  it('preserves a confirmed failure with partial coverage', () => {
    expect(concludeDiagnosticRun(run('PARTIAL', [{ state: 'FAILED' } as DiagnosticTest]))).toBe(
      'CONFIRMED_FAULT',
    );
  });
});
