import { existsSync, readFileSync } from 'node:fs';
import { adaptLegacyVsiDiagnostic, type VsiServiceDiagnosis } from '@gmj/shared';
import { vsi1809Result } from '../result/vsi-1809.fixture';
import engineReplay3072 from './fixtures/engine-replay-3072.json';
import engineReplayVta from './fixtures/engine-replay-3072-vta-mcp.json';
import { vsi3066Fixture, vsi3072Fixture } from './fixtures/vsi-fixtures';
import { VsiServiceDiagnosisView } from './service-view';
import styles from './service-view.module.css';

/**
 * Pagina de desenvolvimento. COMPONENTE DE SERVIDOR de proposito: as fixtures (com nomes reais de
 * equipamentos) ficam so no bundle do servidor e chegam ao navegador apenas como props, quando a
 * rota esta habilitada (`next dev`). Nunca importar `./fixtures` de um arquivo com a diretiva de cliente.
 */
const SCENARIOS: Array<{ id: string; label: string; build: () => VsiServiceDiagnosis }> = [
  { id: '3066', label: '3066 · fixture', build: () => vsi3066Fixture },
  { id: '3072', label: '3072 · fixture', build: () => vsi3072Fixture },
  // Resposta REAL do motor VSI/MCP + agregador (replay das capturas de 16/11, sem SSH); golden em apps/api.
  { id: 'motor-3072', label: '3072 · resposta do motor (replay)', build: () => engineReplay3072 as unknown as VsiServiceDiagnosis },
  // Sessao real do VTA-01 pelo fluxo MCP (16/11 19:37Z) reproduzida em teste: Backup lido por inteiro.
  { id: 'motor-vta', label: '3072 · VTA-01 real (replay)', build: () => engineReplayVta as unknown as VsiServiceDiagnosis },
  {
    id: 'legado',
    label: 'Motor legado (caso 1809)',
    build: () => ({
      ...adaptLegacyVsiDiagnostic(vsi1809Result),
      demonstration: {
        label: 'Fixture de desenvolvimento',
        provenance:
          'Resultado do motor legado reconstruído para testes (caso 1809), convertido pelo adaptador. Não contém saída real de equipamento.',
      },
    }),
  },
];

/**
 * Resultado de homologacao gerado fora do repositorio (ver apps/api/.../vsi-service/homolog-aggregate.test.ts).
 * Lido do disco pelo SERVIDOR de desenvolvimento, so quando VSI_PREVIEW_RESULT_FILE aponta para ele.
 */
function homologScenario(): Array<{ id: string; label: string; build: () => VsiServiceDiagnosis }> {
  const file = process.env.VSI_PREVIEW_RESULT_FILE;
  if (!file || !existsSync(file)) return [];
  return [{ id: 'homolog', label: 'Resultado de homologação (arquivo)', build: () => JSON.parse(readFileSync(file, 'utf8')) as VsiServiceDiagnosis }];
}

export function VsiServicePreview({ scenario, evidenceId }: { scenario: string; evidenceId: string | null }) {
  const scenarios = [...SCENARIOS, ...homologScenario()];
  const current = scenarios.find((s) => s.id === scenario) ?? SCENARIOS[1]!;
  return (
    <main className={styles.previewPage}>
      <header className={styles.previewBar}>
        <h1>
          Diagnóstico <span>/ VSI · VPLS · pré-visualização DEV</span>
        </h1>
        <nav aria-label="Cenário">
          {scenarios.map((s) => (
            <a key={s.id} href={`?cenario=${s.id}`} aria-current={s.id === current.id ? 'page' : undefined}>
              {s.label}
            </a>
          ))}
        </nav>
      </header>
      <VsiServiceDiagnosisView key={current.id} diagnosis={current.build()} initialEvidenceId={evidenceId} />
    </main>
  );
}
