'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { vsiFreshness, type VsiDiagnosticEvidence, type VsiEvidenceRef, type VsiFindingView, type VsiFreshness, type VsiServiceDiagnosis } from '@gmj/shared';
import { EvidenceDrawer } from '../result/evidence-drawer';
import { Badge, OriginBadge, ToneIcon, toneClass } from './badges';
import { EndpointMatrix } from './endpoint-matrix';
import { ServiceTopology } from './service-topology';
import {
  ENGINE_LABEL,
  GROUP_TITLE,
  ORIGIN_LABEL,
  KIND_META,
  KIND_ORDER,
  READING_KIND,
  VERDICT_META,
  axisMeta,
  certaintyText,
  formatInstant,
  pendingCount,
  renderClause,
  stepsForFinding,
} from './view-model';
import styles from './service-view.module.css';

const AXES = ['redundancy', 'service', 'mac', 'evidence'] as const;

/** Agrupa achados de mesmo codigo quando o texto e comum (titulo de grupo conhecido ou titulos identicos). */
function bucketsOf(list: VsiFindingView[]): VsiFindingView[][] {
  const out: VsiFindingView[][] = [];
  for (const finding of list) {
    const same = out.find(
      (bucket) => bucket[0]!.code === finding.code && (GROUP_TITLE[finding.code] !== undefined || bucket[0]!.title === finding.title),
    );
    if (same) same.push(finding);
    else out.push([finding]);
  }
  return out;
}

function groupCount(bucket: VsiFindingView[]): string {
  const hosts = new Set(bucket.map((f) => f.hostName ?? '')).size;
  return hosts === bucket.length ? `${hosts} PEs` : `${bucket.length} ocorrências em ${hosts} ${hosts === 1 ? 'PE' : 'PEs'}`;
}

const PROBE_TONE = { OK: 'ok', WARNING: 'warn', FAILED: 'crit', INSUFFICIENT_DATA: 'unk' } as const;
const PROBE_LABEL = { OK: 'OK', WARNING: 'ATENÇÃO', FAILED: 'FALHA', INSUFFICIENT_DATA: 'DADO INSUFICIENTE' } as const;

function evidenceLabel(e: VsiEvidenceRef): string {
  return `${e.command ?? 'inventário SNMP'} · ${e.hostName.replace(/-MPLS-\d+$/, '')}`;
}

/** O painel de evidencia existente recebe o formato do legado; a conversao nao altera conteudo. */
function toDrawerEvidence(e: VsiEvidenceRef): VsiDiagnosticEvidence {
  return {
    id: e.id,
    hostId: e.hostId ?? e.hostName,
    source: e.source,
    observedAt: e.observedAt,
    collectedAt: e.collectedAt ?? '',
    command: e.command,
    output: e.output ?? 'Saída bruta não embutida neste resultado.',
    complete: e.complete,
    ...(e.sha256 ? { sha256: e.sha256 } : {}),
  };
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <button
      className={styles.copy}
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => setState('ok'))
          .catch(() => setState('fail'));
      }}
    >
      {state === 'ok' ? 'copiado' : state === 'fail' ? 'copie manualmente' : 'copiar'}
    </button>
  );
}

/**
 * Diagnostico VSI/VPLS por servico. Renderiza SOMENTE o que o contrato traz: veredito e eixos
 * vem prontos (clausulas), achados vem do motor, e todo valor carrega origem e evidencia.
 */
export function VsiServiceDiagnosisView({
  diagnosis,
  initialEvidenceId = null,
  now,
}: {
  diagnosis: VsiServiceDiagnosis;
  /** Abre o painel ja nesta evidencia (links diretos e capturas de tela). */
  initialEvidenceId?: string | null;
  /** Relogio de quem esta VENDO o resultado (ISO). Padrao: relogio do navegador, apos montar. */
  now?: string | undefined;
}) {
  const [selected, setSelected] = useState<VsiEvidenceRef | null>(
    () => diagnosis.evidence.find((e) => e.id === initialEvidenceId) ?? null,
  );
  const stepsRef = useRef<HTMLOListElement>(null);
  // Um resultado guardado e aberto depois NAO e leitura atual: a idade e medida contra o relogio de quem ve.
  const [viewedAt, setViewedAt] = useState<string | null>(now ?? null);
  useEffect(() => {
    setViewedAt(now ?? new Date().toISOString());
  }, [now, diagnosis.runId]);
  const resultAge: VsiFreshness | null = viewedAt ? vsiFreshness(diagnosis.completedAt, viewedAt) : null;
  const ageHours = viewedAt ? Math.max(0, (Date.parse(viewedAt) - Date.parse(diagnosis.completedAt)) / 3_600_000) : 0;
  const ageText = ageHours >= 48 ? `${Math.round(ageHours / 24)} dias` : ageHours >= 1 ? `${Math.round(ageHours)} h` : `${Math.round(ageHours * 60)} min`;
  const d = diagnosis;
  const verdict = VERDICT_META[d.verdict.status];
  const evidenceById = (id: string): VsiEvidenceRef | undefined => d.evidence.find((e) => e.id === id);
  const openEvidence = useCallback(
    (id: string) => setSelected(d.evidence.find((e) => e.id === id) ?? null),
    [d.evidence],
  );
  const close = useCallback(() => setSelected(null), []);
  const groups = KIND_ORDER.map((kind) => ({ kind, list: d.findings.filter((f) => f.kind === kind) })).filter((g) => g.list.length > 0);
  const failures = d.findings.filter((f) => f.kind === 'FAILURE').length;
  const pending = pendingCount(d.findings);
  // As clausulas dos eixos ja aparecem nos quadros dos eixos: no veredito ficam so as demais.
  const axisCodes = new Set(AXES.map((key) => d.axes[key].clause.code));
  const [primary, ...others] = d.verdict.clauses;
  const rest = others.filter((clause) => !axisCodes.has(clause.code));

  const goToStep = (number: number): void => {
    const item = stepsRef.current?.children[number - 1] as HTMLElement | undefined;
    item?.scrollIntoView?.({ block: 'center' });
    item?.focus?.();
  };

  const EvidenceLinks = ({ ids }: { ids: string[] }) => (
    <span className={styles.evlinks}>
      {ids.map((id) => {
        const item = evidenceById(id);
        return item ? (
          <button key={id} className={styles.evlink} data-evidence-id={id} onClick={() => openEvidence(id)}>
            {evidenceLabel(item)}
          </button>
        ) : null;
      })}
    </span>
  );

  const Finding = ({ finding, open }: { finding: VsiFindingView; open: boolean }) => {
    const tone = KIND_META[finding.kind].tone;
    const steps = stepsForFinding(finding, d.nextSteps);
    return (
      <details className={`${styles.issue} ${toneClass(tone)}`} open={open} data-finding-code={finding.code} data-finding-kind={finding.kind}>
        <summary>
          <span className={styles.issueIcon}>
            <ToneIcon tone={tone} size={15} />
          </span>
          <span className={styles.issueWhat}>{finding.title}</span>
          <span className={styles.chev} aria-hidden="true">▸</span>
          <span className={styles.issueWhere}>
            {[finding.hostName, finding.component, finding.code].filter(Boolean).join(' · ')}
          </span>
        </summary>
        <dl className={styles.kv}>
          <dt>O que foi detectado</dt>
          <dd>{finding.explanation}</dd>
          {finding.caveat ? (
            <>
              <dt>Ressalva</dt>
              <dd>{finding.caveat}</dd>
            </>
          ) : null}
          <dt>Grau de certeza</dt>
          <dd>
            {certaintyText(finding)}
            {finding.origin !== 'ENGINE' ? (
              <span className={styles.quiet}> · {finding.origin === 'AGGREGATOR' ? 'regra de composição' : 'análise manual (fixture)'}</span>
            ) : null}
          </dd>
          <dt>Evidência</dt>
          <dd>{finding.evidenceIds.length > 0 ? <EvidenceLinks ids={finding.evidenceIds} /> : <span className={styles.quiet}>sem evidência associada: é uma lacuna de leitura</span>}</dd>
          {steps.length > 0 ? (
            <>
              <dt>Próximo teste</dt>
              <dd className={styles.evlinks}>
                {steps.map(({ step, number }) => (
                  <button key={step.id} className={styles.evlink} onClick={() => goToStep(number)}>
                    Passo {number} · {step.title}
                  </button>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    );
  };

  return (
    <article className={styles.root} aria-label="Diagnóstico VSI/VPLS por serviço" data-engine={d.engine} data-run-id={d.runId}>
      {d.demonstration ? (
        <div className={styles.demo} role="note">
          <strong>{d.demonstration.label.toUpperCase()} · NÃO É ESTADO ATUAL DA REDE</strong>
          <span>{d.demonstration.provenance}</span>
        </div>
      ) : null}

      {resultAge && resultAge !== 'CURRENT' ? (
        <div className={styles.aged} role="alert" data-result-age={resultAge}>
          <strong>{resultAge === 'STALE' ? 'RESULTADO ANTIGO' : 'RESULTADO ENVELHECIDO'} · montado há {ageText}</strong>
          <span>Este é o estado no momento da execução ({formatInstant(d.completedAt)}), não o estado atual. Faça nova coleta antes de concluir.</span>
        </div>
      ) : null}

      <section className={`${styles.verdict} ${toneClass(verdict.tone)}`} aria-label="Veredito" data-verdict={d.verdict.status}>
        <div>
          <div className={styles.vsiName}>{d.vsiName}</div>
          <div className={styles.verdictState}>
            <span className={styles.verdictIcon}>
              <ToneIcon tone={verdict.tone} size={22} />
            </span>
            <b>{verdict.label}</b>
            {failures === 0 ? <span className={styles.quiet}>Nenhuma falha comprovada na evidência disponível.</span> : null}
          </div>
          <p className={styles.say}>{primary ? renderClause(primary) : ''}</p>
          {rest.length > 0 ? (
            <ul className={styles.clauses}>
              {rest.map((clause) => (
                <li key={clause.code} data-clause={clause.code}>
                  {renderClause(clause)}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className={styles.prov}>
          <h3>Origem e idade</h3>
          <dl className={styles.src}>
            <dt>Motor</dt>
            <dd data-testid="engine">
              {ENGINE_LABEL[d.engine]} · {d.engineVersion}
            </dd>
            <dt>Execução</dt>
            <dd>
              <code>{d.runId}</code>
            </dd>
            <dt>Origem</dt>
            <dd data-testid="origin">{ORIGIN_LABEL[d.origin]}</dd>
            <dt>Operador</dt>
            <dd>{d.operator ? `${d.operator.username} · ${d.operator.role}` : 'nenhum (fixture)'}</dd>
            <dt>Montado em</dt>
            <dd>{formatInstant(d.completedAt)}</dd>
          </dl>
        </div>
        <div className={styles.axes}>
          {AXES.map((key) => {
            const meta = axisMeta(key, d.axes[key].state);
            return (
              <div key={key} className={`${styles.axis} ${toneClass(meta.tone)}`} data-axis={key} data-axis-state={d.axes[key].state}>
                <div className={styles.axisKey}>{meta.title}</div>
                <div className={styles.axisValue}>
                  <ToneIcon tone={meta.tone} size={15} />
                  {meta.label}
                </div>
                <div className={styles.axisDetail}>{renderClause(d.axes[key].clause)}</div>
              </div>
            );
          })}
        </div>
      </section>

      <div className={styles.two}>
        <section className={styles.panel} aria-label="Achados">
          <h2>
            Achados <small>{pending} pendência(s), por gravidade</small>
          </h2>
          {groups.length === 0 ? <p className={styles.quiet}>Nenhum achado nesta execução.</p> : null}
          {groups.map(({ kind, list }) => {
            const meta = KIND_META[kind];
            return (
              <div key={kind} className={`${styles.group} ${toneClass(meta.tone)}`} data-kind={kind}>
                <h3>
                  <ToneIcon tone={meta.tone} size={15} />
                  {meta.label} <span>{list.length}</span>
                </h3>
                {kind === 'INFO' ? (
                  <details className={styles.infoFold}>
                    <summary>mostrar {list.length} item(ns)</summary>
                    {list.map((finding) => (
                      <Finding key={finding.id} finding={finding} open={false} />
                    ))}
                  </details>
                ) : (
                  bucketsOf(list).map((bucket) =>
                    bucket.length === 1 ? (
                      <Finding key={bucket[0]!.id} finding={bucket[0]!} open={meta.open && list.length <= 3} />
                    ) : (
                      // Mesmo achado em varios PEs: um grupo, com cada PE e suas evidencias preservados dentro.
                      <details key={bucket[0]!.code} className={styles.issueGroup} open={meta.open} data-finding-group={bucket[0]!.code} data-group-size={bucket.length}>
                        <summary>
                          <span className={styles.issueIcon}>
                            <ToneIcon tone={meta.tone} size={15} />
                          </span>
                          <span className={styles.issueWhat}>
                            {GROUP_TITLE[bucket[0]!.code] ?? bucket[0]!.title} · {groupCount(bucket)}
                          </span>
                          <span className={styles.chev} aria-hidden="true">▸</span>
                          <span className={styles.issueWhere}>{[...new Set(bucket.map((f) => f.hostName ?? 'sem PE'))].join(' · ')}</span>
                        </summary>
                        <div className={styles.issueGroupBody}>
                          {bucket.map((finding) => (
                            <Finding key={finding.id} finding={finding} open={false} />
                          ))}
                        </div>
                      </details>
                    ),
                  )
                )}
              </div>
            );
          })}
        </section>

        <section className={styles.panel} aria-label="Topologia">
          <h2>
            Topologia <small>{d.endpoints.length} PE(s) · gerada dos dados desta tela</small>
          </h2>
          <ServiceTopology diagnosis={d} />
        </section>
      </div>

      <section className={styles.panel} aria-label="Por equipamento">
        <h2>
          Por equipamento <small>{d.endpoints.length} PE(s) lado a lado · cada célula traz estado, origem e hora da leitura</small>
        </h2>
        <EndpointMatrix diagnosis={d} onEvidence={openEvidence} />
      </section>

      <section className={styles.panel} aria-label="Conectividade" data-connectivity-evaluated={d.connectivity.evaluated}>
        <h2>
          Conectividade entre loopbacks <small>ping e traceroute, como o motor mediu</small>
        </h2>
        {!d.connectivity.evaluated ? (
          <p className={styles.quiet}>
            Não avaliada: o motor desta execução não faz ping nem traceroute. Isso não significa ausência de perda.
          </p>
        ) : (
          <>
            {d.connectivity.underlayClassification ? (
              <p className={styles.probeUnderlay}>
                Underlay, na classificação do motor: <code>{d.connectivity.underlayClassification}</code>
              </p>
            ) : null}
            {d.connectivity.probes.length === 0 ? <p className={styles.quiet}>Nenhum probe executado nesta execução.</p> : null}
            <ul className={styles.probes}>
              {d.connectivity.probes.map((p) => (
                <li key={`${p.sourceHostId}-${p.destinationHostId}`} className={toneClass(PROBE_TONE[p.status])} data-probe-status={p.status}>
                  <span className={styles.entryState} data-tone={PROBE_TONE[p.status]}>
                    <ToneIcon tone={PROBE_TONE[p.status]} />
                    {PROBE_LABEL[p.status]}
                  </span>
                  <span>
                    {p.sourceHostName} → {p.destinationHostName}
                  </span>
                  <code>
                    {p.source} → {p.destination}
                  </code>
                  <span className={styles.probeMeta}>
                    {p.transmitted !== null && p.received !== null ? `${p.received}/${p.transmitted} respostas · ` : ''}
                    {p.lossPercent === null ? 'perda não medida' : `perda ${p.lossPercent}%`}
                    {p.rttMs ? ` · RTT mín/méd/máx ${p.rttMs.min}/${p.rttMs.avg}/${p.rttMs.max} ms` : ' · RTT não medido'}
                    {` · contexto ${p.routingContext}`}
                  </span>
                  {p.hops.length > 0 ? (
                    <ol className={styles.hops}>
                      {p.hops.map((hop) => (
                        <li key={hop.ttl}>
                          salto {hop.ttl}: {hop.address ?? '*'} ({hop.timesMs.join('/') || 'N/D'} ms)
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {p.tracerouteNotExecutedReason ? (
                    <span className={styles.probeMeta}>Traceroute não executado: {p.tracerouteNotExecutedReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <div className={styles.two}>
        <section className={styles.panel} aria-label="Próximos passos">
          <h2>
            Próximos passos <small>verificações sugeridas, não causas comprovadas</small>
          </h2>
          {d.nextSteps.length === 0 ? <p className={styles.quiet}>Nenhum passo sugerido.</p> : null}
          <ol className={styles.steps} ref={stepsRef}>
            {d.nextSteps.map((step) => (
              <li key={step.id} tabIndex={-1} data-step-id={step.id} data-step-host={step.hostName ?? ""}>
                <span>
                  {step.title}
                  {step.hostName ? <span className={styles.quiet}> · {step.hostName}</span> : null}
                </span>
                {step.command ? (
                  <span className={styles.cmdline}>
                    <code>{step.command}</code>
                    <CopyButton text={step.command} />
                    {step.homologated === false ? <Badge tone="warn" label="comando não homologado" /> : null}
                  </span>
                ) : null}
                <span className={styles.why}>
                  Motivo: {step.reason} {step.evidenceIds.length > 0 ? <EvidenceLinks ids={step.evidenceIds} /> : null}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.panel} aria-label="Evidências técnicas">
          <h2>
            Leituras <small>cada leitura é listada separada; execuções diferentes não se misturam</small>
          </h2>
          <ul className={styles.readings} aria-label="Leituras">
            {d.readings.map((r) => (
              <li key={r.id} data-reading-id={r.id} data-in-this-run={r.inThisRun}>
                <span className={styles.readKind}>{READING_KIND[r.kind]}</span>
                <span>{r.hostName}</span>
                <span className={styles.quiet}>{formatInstant(r.startedAt, r.timePrecision)}</span>
                <span className={styles.quiet}>{r.scope}</span>
                <span className={`${styles.origin} ${r.inThisRun ? styles.origin_ssh : styles.origin_none}`}>
                  {r.inThisRun ? 'nesta execução' : 'leitura anterior'}
                  {r.outcome === 'PARTIAL' ? ' · parcial' : r.outcome === 'FAILED' ? ' · falhou' : ''}
                </span>
              </li>
            ))}
          </ul>
          <h2 className={styles.subhead}>
            Evidências técnicas <small>{d.evidence.length} item(ns) · clique para ver a saída bruta</small>
          </h2>
          {d.evidence.length === 0 ? <p className={styles.quiet}>Nenhuma evidência neste resultado.</p> : null}
          <div className={styles.evs}>
            {d.evidence.map((e) => (
              <button key={e.id} className={styles.ev} data-evidence-id={e.id} onClick={() => openEvidence(e.id)}>
                <span className={styles.evHost}>{e.hostName}</span>
                <span className={styles.evCmd}>{e.command ?? 'inventário SNMP (banco do NetVision)'}</span>
                <span className={styles.evAt}>{formatInstant(e.collectedAt, e.timePrecision)}</span>
                <OriginBadge
                  origin={
                    !e.complete
                      ? { kind: 'fail', label: 'incompleta' }
                      : e.source === 'LIVE_SSH'
                        ? { kind: 'ssh', label: 'SSH' }
                        : { kind: 'snmp', label: e.source === 'PERSISTED_SNMP' ? 'SNMP' : 'métricas' }
                  }
                />
              </button>
            ))}
          </div>
        </section>
      </div>

      <EvidenceDrawer
        evidence={selected ? toDrawerEvidence(selected) : null}
        onClose={close}
        hostLabel={selected?.hostName}
        timeLabel={selected ? formatInstant(selected.collectedAt, selected.timePrecision) : undefined}
        note={selected ? [selected.note, selected.complete ? null : 'Saída incompleta: descartada pelo diagnóstico.'].filter(Boolean).join(' ') || null : null}
        highlightLines={selected?.usedLines}
        initialTab="saida"
        wide
      />
    </article>
  );
}
