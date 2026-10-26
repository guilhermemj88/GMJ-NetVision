'use client';

import { useState, type ReactNode } from 'react';
import type {
  VsiDiagnosticCategory,
  VsiDiagnosticCheck,
  VsiDiagnosticEvidence,
  VsiDiagnosticProbe,
  VsiDiagnosticResult,
} from '@gmj/shared';
import { EvidenceDrawer } from './evidence-drawer';
import { HealthCards } from './health-cards';
import {
  buildExecutionContext,
  buildHealthCards,
  buildSections,
  durationLabel,
  evidenceSummary,
  formatUtc,
  headlineStatus,
  isRunning,
  limitationText,
  operationalNextTests,
  probeHeadline,
  remotePeerLabel,
  sectionSummary,
  toneOf,
  underlayLabel,
  type Tone,
} from './health-model';
import { RunningStepper } from './running-stepper';
import { TopologyDiagram } from './topology-diagram';
import styles from './result-view.module.css';

function StatusChip({ status }: { status: VsiDiagnosticCheck['status'] }) {
  return (
    <span className={`${styles.chip} ${styles[`chip_${toneOf(status)}`]}`}>{status}</span>
  );
}

function CheckRow({ check }: { check: VsiDiagnosticCheck }) {
  return (
    <li className={styles.checkRow}>
      <div className={styles.checkHead}>
        <StatusChip status={check.status} />
        <strong>{check.label}</strong>
        <span className={styles.checkCertainty}>{check.certainty}</span>
      </div>
      <p className={styles.checkMessage}>{check.message}</p>
    </li>
  );
}

function CompareColumn({ title, checks }: { title: string; checks: VsiDiagnosticCheck[] }) {
  return (
    <div className={styles.compareColumn}>
      <h5 className={styles.compareTitle}>{title}</h5>
      {checks.length === 0 ? (
        <p className={styles.empty}>não avaliado nesta execução</p>
      ) : (
        <ul className={styles.checkList}>
          {checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CompareGrid({
  result,
  categories,
}: {
  result: VsiDiagnosticResult;
  categories: VsiDiagnosticCategory[];
}) {
  const remoteHostId = result.remotes[0]?.hostId ?? null;
  const pick = (hostId: string | null) =>
    hostId
      ? result.checks.filter(
          (check) => check.hostId === hostId && categories.includes(check.category),
        )
      : [];
  return (
    <div className={styles.compare}>
      <CompareColumn title={result.local.name} checks={pick(result.local.hostId)} />
      <CompareColumn
        title={result.remotes[0]?.name ?? 'PE remoto não identificado'}
        checks={pick(remoteHostId)}
      />
    </div>
  );
}

function ProbeRow({ probe }: { probe: VsiDiagnosticProbe }) {
  return (
    <li className={styles.probe}>
      <div className={styles.probeHead}>
        <span className={`${styles.chip} ${styles[`chip_${toneOf(probe.status)}`]}`}>
          {probe.status}
        </span>
        <strong>{probeHeadline(probe)}</strong>
        <code className={styles.probePath}>
          {probe.source} → {probe.destination}
        </code>
      </div>
      <p className={styles.probeMeta}>
        {probe.lossPercent === null ? 'perda não medida' : `perda ${probe.lossPercent}%`}
        {probe.rttMs
          ? ` · RTT ${probe.rttMs.min}/${probe.rttMs.avg}/${probe.rttMs.max} ms`
          : ' · RTT não medido'}
      </p>
      {probe.hops.length > 0 ? (
        <ol className={styles.hops}>
          {probe.hops.map((hop) => (
            <li key={hop.ttl}>
              salto {hop.ttl}: {hop.address ?? '*'} ({hop.timesMs.join('/') || 'N/D'} ms)
            </li>
          ))}
        </ol>
      ) : null}
      {probe.tracerouteNotExecutedReason ? (
        <p className={styles.probeNote}>
          Tracert não executado: {probe.tracerouteNotExecutedReason}
        </p>
      ) : null}
    </li>
  );
}

function Section({
  title,
  tone,
  summary,
  children,
  variant,
}: {
  title: string;
  tone: Tone;
  summary: string;
  children: ReactNode;
  variant?: 'context' | 'limitations';
}) {
  const variantClass = variant ? styles[`section_${variant}`] : '';
  return (
    <details className={`${styles.section} ${styles[`section_${tone}`]} ${variantClass}`}>
      <summary className={styles.sectionSummary}>
        <span className={styles.sectionTitle}>{title}</span>
        <span className={styles.sectionMeta}>{summary}</span>
        <span className={styles.sectionChevron} aria-hidden="true">
          ▸
        </span>
      </summary>
      <div className={styles.sectionBody}>{children}</div>
    </details>
  );
}

export function VsiDiagnosticResultView({ result }: { result: VsiDiagnosticResult }) {
  const [selected, setSelected] = useState<VsiDiagnosticEvidence | null>(null);
  const running = isRunning(result);
  const status = headlineStatus(result);
  const remote = result.remotes[0] ?? null;
  const sections = buildSections(result);
  const cards = buildHealthCards(result);
  const context = buildExecutionContext(result);
  const limitations = result.warnings.map(limitationText);
  const nextTests = operationalNextTests(result.nextTests);
  const probes = result.probes ?? [];
  const observedPeers = [result.local, ...(remote ? [remote] : [])].flatMap((endpoint) =>
    (endpoint.observedVsi?.peers ?? []).map((peer) => ({ endpoint: endpoint.name, peer })),
  );

  return (
    <article className={styles.result} aria-label="Resultado do diagnóstico">
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <span className={`${styles.status} ${styles[`status_${status}`]}`}>
            {running ? 'DIAGNÓSTICO EM ANDAMENTO' : status}
          </span>
          <h3 className={styles.title}>{result.vsiName}</h3>
          {!running && result.state !== 'COMPLETED' ? (
            <span className={styles.stateBadge}>{result.state}</span>
          ) : null}
        </div>
        <p className={styles.peers}>
          <strong>{result.local.name}</strong>
          <span aria-hidden="true"> ↔ </span>
          <strong>{remotePeerLabel(result)}</strong>
        </p>
        {/* O resumo do backend so e conclusao depois do job; antes disso seria veredito provisorio. */}
        <p className={styles.summaryText}>
          {running ? 'Coletando e validando evidências dos PEs…' : result.summary}
        </p>
        <dl className={styles.meta}>
          <div>
            <dt>Underlay</dt>
            <dd>{underlayLabel(result)}</dd>
          </div>
          <div>
            <dt>Execução</dt>
            <dd>
              <code>{result.diagnosticId}</code>
            </dd>
          </div>
          <div>
            <dt>Operador</dt>
            <dd>
              {result.operator.username} · {result.operator.role}
            </dd>
          </div>
          <div>
            <dt>Início</dt>
            <dd>{formatUtc(result.startedAt)}</dd>
          </div>
          <div>
            <dt>Concluído em</dt>
            <dd>{durationLabel(result)}</dd>
          </div>
        </dl>
      </header>

      {running ? (
        <RunningStepper result={result} />
      ) : (
        <>
          <HealthCards cards={cards} />
          <TopologyDiagram result={result} />

          <div className={styles.sections}>
            <Section
              title="Underlay"
              tone={sections[0]?.tone ?? 'neutral'}
              summary={sections[0] ? sectionSummary(sections[0]) : 'não avaliado'}
            >
              <ul className={styles.checkList}>
                {(sections[0]?.checks ?? []).map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
              <p className={styles.empty}>
                {probes.length} probe{probes.length === 1 ? '' : 's'} de loopback registrado
                {probes.length === 1 ? '' : 's'} nesta execução.
              </p>
            </Section>

            <Section
              title="VSI"
              tone={sections[1]?.tone ?? 'neutral'}
              summary={sections[1] ? sectionSummary(sections[1]) : 'não avaliado'}
            >
              <CompareGrid result={result} categories={['VSI']} />
            </Section>

            <Section
              title="PW"
              tone={sections[2]?.tone ?? 'neutral'}
              summary={sections[2] ? sectionSummary(sections[2]) : 'não avaliado'}
            >
              <CompareGrid result={result} categories={['PW', 'ETH_TRUNK']} />
              {observedPeers.length > 0 ? (
                <table className={styles.peersTable}>
                  <thead>
                    <tr>
                      <th>PE</th>
                      <th>Peer</th>
                      <th>VC-ID</th>
                      <th>Estado</th>
                      <th>Labels in/out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observedPeers.map(({ endpoint, peer }) => (
                      <tr key={`${endpoint}-${peer.address}`}>
                        <td>{endpoint}</td>
                        <td>{peer.address}</td>
                        <td>{peer.vcId ?? '—'}</td>
                        <td>{peer.state ?? '—'}</td>
                        <td>
                          {peer.inboundLabel ?? '—'} / {peer.outboundLabel ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </Section>

            <Section
              title="AC"
              tone={sections[3]?.tone ?? 'neutral'}
              summary={sections[3] ? sectionSummary(sections[3]) : 'não avaliado'}
            >
              <CompareGrid result={result} categories={['AC', 'INTERFACE']} />
            </Section>

            <Section
              title="Reachability"
              tone={sections[4]?.tone ?? 'neutral'}
              summary={
                probes.length === 0
                  ? 'nenhum probe executado'
                  : `${probes.length} probe${probes.length === 1 ? '' : 's'} · ${
                      probes.some((p) => p.status === 'FAILED') ? 'com falha' : 'sem falha'
                    }`
              }
            >
              <ul className={styles.checkList}>
                {(sections[4]?.checks ?? []).map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </ul>
              {probes.length > 0 ? (
                <ul className={styles.checkList}>
                  {probes.map((probe) => (
                    <ProbeRow key={`${probe.sourceHostId}-${probe.destinationHostId}`} probe={probe} />
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>nenhum probe executado nesta execução</p>
              )}
            </Section>

            <Section
              title="Contexto de execução"
              tone="neutral"
              summary={context.summary}
              variant="context"
            >
              {/* Informativo: RBAC do NetVision, conta SSH e AAA do equipamento sao dominios distintos. */}
              <dl className={styles.evidenceMeta} aria-label="Contexto de execução">
                <div>
                  <dt>Permissão no NetVision</dt>
                  <dd>{context.netvision} — usuário que iniciou esta execução.</dd>
                </div>
                <div>
                  <dt>Acesso aos equipamentos</dt>
                  <dd>{context.deviceAccess}</dd>
                </div>
                <div>
                  <dt>Autorização dos comandos</dt>
                  <dd>{context.commandAuthorization}</dd>
                </div>
                <div>
                  <dt>Nível de privilégio no equipamento</dt>
                  <dd>{context.privilegeLevel}</dd>
                </div>
                <div>
                  <dt>Início</dt>
                  <dd>{formatUtc(result.startedAt)}</dd>
                </div>
                <div>
                  <dt>Conclusão</dt>
                  <dd>
                    {formatUtc(result.completedAt)} · {durationLabel(result)}
                  </dd>
                </div>
              </dl>
              {context.endpoints.length > 0 ? (
                <ul className={styles.contextEndpoints} aria-label="Contexto por PE">
                  {context.endpoints.map((endpoint) => (
                    <li key={endpoint.hostId} className={styles.contextEndpoint}>
                      <span className={styles.contextRole}>{endpoint.role}</span>
                      <strong>{endpoint.name}</strong>
                      <span>Conta SSH: {endpoint.sshUsername}</span>
                      <span>{endpoint.authorization}</span>
                      <span className={styles.contextCount}>{endpoint.commands}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className={styles.empty}>
                A lista completa de comandos está em Evidências e comandos.
              </p>
            </Section>

            <Section
              title="Limitações da análise"
              tone="attention"
              summary={`${limitations.length + nextTests.length} ${
                limitations.length + nextTests.length === 1 ? 'item' : 'itens'
              } de escopo`}
              variant="limitations"
            >
              {limitations.length > 0 ? (
                <ul className={styles.limitationList}>
                  {limitations.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>nenhuma limitação declarada nesta execução</p>
              )}
              {nextTests.length > 0 ? (
                <>
                  <h5 className={styles.compareTitle}>Próximas verificações sugeridas</h5>
                  <ul className={styles.limitationList}>
                    {nextTests.map((next) => (
                      <li key={next}>{next}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className={styles.empty}>
                A conclusão vale apenas para as evidências desta execução. Limitação de escopo não
                indica falha do circuito.
              </p>
            </Section>

            <Section
              title="Evidências e comandos"
              tone="neutral"
              summary={`${result.evidence.length} evidência${
                result.evidence.length === 1 ? '' : 's'
              } · abrir em painel`}
            >
              {result.evidence.length === 0 ? (
                <p className={styles.empty}>nenhuma evidência coletada nesta execução</p>
              ) : (
                <ul className={styles.evidenceList}>
                  {result.evidence.map((item) => (
                    <li key={item.id}>
                      <button className={styles.evidenceItem} onClick={() => setSelected(item)}>
                        <span className={styles.evidenceSource}>{item.source}</span>
                        <span className={styles.evidenceHost}>{item.hostId}</span>
                        <span className={styles.evidenceTime}>
                          {formatUtc(item.observedAt ?? item.collectedAt)}
                        </span>
                        <span className={styles.evidenceSummaryText}>
                          {evidenceSummary(item) || 'sem conteúdo textual'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      )}

      <EvidenceDrawer evidence={selected} onClose={() => setSelected(null)} />
    </article>
  );
}
