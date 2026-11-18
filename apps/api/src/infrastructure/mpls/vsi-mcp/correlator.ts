import type { HuaweiPlatform } from './platform';
import type {
  EncapDirective,
  ParsedInterfaceConfig,
  ParsedMacTable,
  ParsedVlanInfo,
  ParsedVsiVerbose,
} from './parsers';
import { vlanListIncludes } from './parsers';
import {
  classifyTrunkRole,
  isPersistedPwStale,
  normalizeRd,
  type PathRole,
  type PersistedPwRef,
  type RedundancyFacts,
  type TrunkRole,
} from './redundancy';

/**
 * Correlacionador de evidencias de VSI/VPLS.
 *
 * Regra de ouro: separar FATO observado (certainty) de EFEITO inferido
 * (impactCertainty). Nada aqui declara "causa raiz confirmada": o maximo e
 * CONFIRMED para um fato presente na saida do equipamento e PROBABLE/HYPOTHESIS
 * para a consequencia.
 */

export type Certainty = 'CONFIRMED' | 'PROBABLE' | 'HYPOTHESIS' | 'INCONCLUSIVE';
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
export type DiagnosticStatus = 'OK' | 'WARNING' | 'FAILED' | 'INCONCLUSIVE';

export interface Finding {
  code: string;
  severity: Severity;
  /** Certeza do FATO (o que a saida mostra). */
  certainty: Certainty;
  /** Certeza da CONSEQUENCIA descrita. */
  impactCertainty: Certainty;
  title: string;
  explanation: string;
  /** Quando a regra NAO se aplica / contra-exemplos legitimos. */
  caveat: string | null;
  hostId: string | null;
  evidence: string[];
}

export interface EndpointFacts {
  hostId: string;
  hostName: string;
  platform: HuaweiPlatform | null;
  vsiName: string;
  vsi: ParsedVsiVerbose | null;
  interfaces: Record<string, ParsedInterfaceConfig>;
  macs: ParsedMacTable | null;
  /** `display vlan <id>` (so quando solicitado e autorizado no perfil). */
  vlan?: ParsedVlanInfo | null;
  /** Config de portas transportadoras (ex.: Eth-Trunk) NAO-AC, lidas por lista fechada do perfil. */
  carriers?: Record<string, ParsedInterfaceConfig>;
  /** ACs que o NetVision tem PERSISTIDOS (SNMP) para esta VSI, para conferir contra o equipamento. */
  persistedAcs?: string[];
  /** O que o chamador pediu. MAC ausente so e lacuna se foi solicitado (padrao: solicitado). */
  requested?: { mac?: boolean };
  /** `display eth-trunk N` / `display e-trunk N` lidos (so quando solicitados e autorizados no perfil). */
  redundancy?: RedundancyFacts;
  /** PWs PERSISTIDOS (SNMP) desta VSI e a ultima leitura da VSI, para apontar registros obsoletos. */
  persistedPws?: { vsiLastSeenAt: string; pws: PersistedPwRef[] };
  /** ids de evidencia por origem, para referenciar nos findings. */
  evidenceIds: { vsi?: string; macs?: string; vlan?: string; interfaces: Record<string, string>; carriers?: Record<string, string> };
}

const isParentOf = (parent: string, child: string): boolean => child.startsWith(parent + '.');

/* ----------------------------- VLAN path ----------------------------- */

export interface AcVlanTransform {
  interfaceName: string;
  mode: 'DOT1Q_TERMINATION' | 'QINQ_TERMINATION' | 'UNTAG' | 'QINQ_STACKING' | 'VLAN_MAPPING' | 'REWRITE' | 'NONE';
  /** VLAN(s) esperadas na entrada do AC. */
  ingress: string[];
  /** VLAN(s) observadas apos a transformacao (o que segue para a VSI). */
  transported: string[];
  /** Quantidade de tags carregadas apos a transformacao, quando deduzivel. */
  tagCount: 0 | 1 | 2 | null;
  directives: string[];
}

export function acVlanTransform(cfg: ParsedInterfaceConfig): AcVlanTransform {
  const base = { interfaceName: cfg.interfaceName ?? '', directives: cfg.directives.map((d) => d.raw) };
  const find = <K extends EncapDirective['kind']>(kind: K) =>
    cfg.directives.find((d): d is Extract<EncapDirective, { kind: K }> => d.kind === kind);

  // Uma subinterface pode trazer varias linhas de stacking (uma por VLAN/faixa de cliente): todas contam.
  const stacks = cfg.directives.filter((d): d is Extract<EncapDirective, { kind: 'QINQ_STACKING' }> => d.kind === 'QINQ_STACKING');
  if (stacks.length > 0) {
    const ingress = [...new Set(stacks.map((s) => s.vlan))];
    return { ...base, mode: 'QINQ_STACKING', ingress, transported: [...new Set(stacks.map((s) => s.stackVlan)), ...ingress], tagCount: 2 };
  }
  const map = find('VLAN_MAPPING');
  if (map)
    return { ...base, mode: 'VLAN_MAPPING', ingress: [map.vlan], transported: [map.mapVlan], tagCount: 1 };
  const q = find('QINQ_TERMINATION');
  if (q)
    return { ...base, mode: 'QINQ_TERMINATION', ingress: [q.peVid, q.ceVid], transported: [], tagCount: 0 };
  const d = find('DOT1Q_TERMINATION');
  if (d) return { ...base, mode: 'DOT1Q_TERMINATION', ingress: [d.vid], transported: [], tagCount: 0 };
  const rw = find('REWRITE');
  if (rw) return { ...base, mode: 'REWRITE', ingress: [], transported: [], tagCount: null };
  if (find('UNTAG')) return { ...base, mode: 'UNTAG', ingress: [], transported: [], tagCount: 0 };
  return { ...base, mode: 'NONE', ingress: [], transported: [], tagCount: null };
}

/* ------------------------------ por ponta ---------------------------- */

export type DimensionVerdict = 'OK' | 'ISSUE' | 'NOT_EVALUATED';
export interface DiagnosisDimensions {
  VSI_STATE: DimensionVerdict;
  AC_STATE: DimensionVerdict;
  PW_STATE: DimensionVerdict;
  AC_BINDING: DimensionVerdict;
  MAC_LEARNING: DimensionVerdict;
  ENCAPSULATION: DimensionVerdict;
}

export interface EvidenceCoverage {
  vsi: boolean;
  acConfigs: { collected: number; total: number };
  mac: 'COLLECTED' | 'MISSING' | 'NOT_REQUESTED';
}

export interface MacSummary {
  total: number;
  declaredTotal: number | null;
  viaAc: number;
  viaPw: number;
  /**
   * Entradas de origem NAO CLASSIFICADA: o Learned-From e uma interface que nao e AC da VSI (nem pai/filha
   * de um AC, nem porta comprovadamente na VLAN de um AC Vlanif). O campo nao distingue porta de acesso de
   * interface de saida do tunel do PW, logo essas entradas nao contam como AC nem como PW.
   * Sempre vale: total = viaAc + viaPw + viaUnresolved.
   */
  viaUnresolved: number;
  unresolvedOrigin: string[];
  byLearnedFrom: Record<string, number>;
  byType: Record<string, number>;
  oldestAgeSeconds: number | null;
  newestAgeSeconds: number | null;
  /** Contador `Mac Flapping` por PW, como o equipamento informou. */
  pwMacFlapping: Array<{ peer: string; counter: number | null }>;
  /** Nao ha historico confiavel entre coletas: cada diagnostico e uma fotografia. */
  history: 'NOT_AVAILABLE';
}

export interface EndpointDiagnosis {
  hostId: string;
  hostName: string;
  vsiName: string;
  status: DiagnosticStatus;
  /** Cobertura das evidencias: base para dizer o que NAO foi verificado. */
  coverage: EvidenceCoverage;
  /** Veredito por dimensao: o status geral so e OK se TODAS foram avaliadas e estao OK. */
  dimensions: DiagnosisDimensions;
  /** Aprendizado MAC resumido (null se a tabela nao foi coletada completa). */
  macSummary: MacSummary | null;
  /** O que este diagnostico de UMA ponta NAO verifica, sempre listado. */
  notVerified: string[];
  findings: Finding[];
  vlanPaths: AcVlanTransform[];
  /**
   * Papel operacional de cada AC e dos Eth-Trunks que o transportam. Presente SOMENTE quando ha
   * evidencia de redundancia no escopo (E-Trunk/Eth-Trunk lidos ou config com `e-trunk N`).
   */
  pathRoles?: PathRoleEntry[];
  /** Papel desta ponta para a VSI (mesma condicao de presenca de `pathRoles`). */
  operationalRole?: PathRole;
}

export interface PathRoleEntry {
  kind: 'AC' | 'ETH_TRUNK';
  name: string;
  role: PathRole;
  mechanism: TrunkRole['mechanism'] | null;
  eTrunkId: number | null;
  reasons: string[];
  missingEvidence: string[];
}

const NOT_VERIFIED: string[] = [
  'Encapsulamento e estado da outra ponta (use compare_vsi_endpoints)',
  'Conectividade fim a fim e trafego real (MAC aprendido e evidencia indireta)',
  'Historico: nao ha comparacao entre coletas, cada diagnostico e uma fotografia',
];

export function diagnoseEndpoint(f: EndpointFacts): EndpointDiagnosis {
  const findings: Finding[] = [];
  const add = (x: Omit<Finding, 'hostId'>) => findings.push({ ...x, hostId: f.hostId });

  if (!f.vsi || !f.vsi.complete) {
    add({
      code: 'VSI_EVIDENCE_MISSING', severity: 'WARNING', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
      title: 'Saida da VSI ausente ou incompleta',
      explanation: 'Sem a saida completa de `display vsi name <vsi> verbose` nenhuma conclusao sobre VSI, AC ou PW e possivel.',
      caveat: null, evidence: f.evidenceIds.vsi ? [f.evidenceIds.vsi] : [],
    });
    return {
      hostId: f.hostId, hostName: f.hostName, vsiName: f.vsiName, status: 'INCONCLUSIVE', findings, vlanPaths: [],
      coverage: { vsi: false, acConfigs: { collected: 0, total: 0 }, mac: f.requested?.mac === false ? 'NOT_REQUESTED' : 'MISSING' },
      dimensions: { VSI_STATE: 'NOT_EVALUATED', AC_STATE: 'NOT_EVALUATED', PW_STATE: 'NOT_EVALUATED', AC_BINDING: 'NOT_EVALUATED', MAC_LEARNING: 'NOT_EVALUATED', ENCAPSULATION: 'NOT_EVALUATED' },
      macSummary: null,
      notVerified: NOT_VERIFIED,
    };
  }

  const vsi = f.vsi;
  const vsiEv = f.evidenceIds.vsi ? [f.evidenceIds.vsi] : [];

  /* ---- Topologia de acesso e papel operacional (so com evidencia de redundancia no escopo) ---- */
  const cfgOf = (name: string): ParsedInterfaceConfig | undefined => f.carriers?.[name] ?? f.interfaces[name];
  const redundancyInScope = !!f.redundancy ||
    [...Object.values(f.carriers ?? {}), ...Object.values(f.interfaces)].some((c) => c.complete && c.eTrunkId !== undefined);
  const trunkRoles = new Map<string, TrunkRole>();
  const trunkRole = (name: string): TrunkRole => {
    let r = trunkRoles.get(name);
    if (!r) trunkRoles.set(name, (r = classifyTrunkRole(name, cfgOf(name), f.redundancy)));
    return r;
  };
  const redundancyEv = (name: string, eTrunkId: number | null): string[] => [
    ...(f.redundancy?.evidenceIds?.ethTrunks?.[name] ? [f.redundancy.evidenceIds.ethTrunks[name]!] : []),
    ...(eTrunkId !== null && f.redundancy?.evidenceIds?.eTrunks?.[eTrunkId] ? [f.redundancy.evidenceIds.eTrunks[eTrunkId]!] : []),
    ...(f.evidenceIds.carriers?.[name] ? [f.evidenceIds.carriers[name]!] : []),
  ];
  /** O que a config de uma porta L2 diz sobre uma VLAN: true/false/null (nao lida ou nao interpretavel). */
  const carriesVlan = (port: string, vlan: number): boolean | null => {
    const pv = f.carriers?.[port]?.complete ? f.carriers[port]!.portVlan : null;
    if (!pv) return null;
    const tagged = vlanListIncludes(pv.hybridTagged, vlan);
    const untagged = vlanListIncludes(pv.hybridUntagged, vlan);
    return pv.linkType === 'TRUNK' ? vlanListIncludes(pv.trunkAllow, vlan)
      : pv.linkType === 'HYBRID' ? (tagged === true || untagged === true ? true : tagged === false && untagged === false ? false : null)
      : pv.linkType === 'ACCESS' ? pv.defaultVlan === vlan
      : null;
  };
  const isEthTrunk = (name: string): boolean => /^Eth-Trunk\d+$/i.test(name);
  interface AcRole { role: PathRole; trunks: TrunkRole[]; reasons: string[]; missing: string[] }
  const acRoles = new Map<string, AcRole>();
  if (redundancyInScope)
    for (const ac of vsi.acs) {
      const reasons: string[] = [];
      const missing: string[] = [];
      let trunks: TrunkRole[] = [];
      const otherPorts: string[] = [];
      let resolved = false;
      const onTrunk = /^(Eth-Trunk\d+)(?:\.\d+)?$/i.exec(ac.interfaceName);
      const vlanif = /^Vlanif(\d+)$/i.exec(ac.interfaceName);
      if (onTrunk) {
        trunks = [trunkRole(onTrunk[1]!)];
        resolved = true;
      } else if (vlanif) {
        const vid = Number(vlanif[1]);
        if (f.vlan?.complete && f.vlan.vlanId === vid && f.vlan.exists !== false) {
          // Membership completa da VLAN: todas as portas por onde o AC pode receber trafego.
          for (const port of f.vlan.ports) {
            if (isEthTrunk(port.name)) trunks.push(trunkRole(port.name));
            else otherPorts.push(port.name);
          }
          resolved = true;
        } else {
          // Sem `display vlan`: so se conhecem os trunks cuja config permite a VLAN; pode haver outras portas.
          trunks = Object.keys(f.carriers ?? {}).filter((n) => isEthTrunk(n) && carriesVlan(n, vid) === true).map(trunkRole);
          if (trunks.length) missing.push(`display vlan ${vid} (todas as portas da VLAN do AC; sem isso nao se exclui outro caminho de acesso)`);
        }
      }
      for (const t of trunks) {
        reasons.push(...t.reasons);
        missing.push(...t.missingEvidence);
      }
      let role: PathRole;
      if (ac.state === 'UP') role = 'ACTIVE';
      else if (ac.state !== 'DOWN') role = 'ROLE_UNKNOWN';
      else if (trunks.length === 0) role = 'DOWN_UNEXPECTED';
      else if (resolved && otherPorts.length === 0 && trunks.every((t) => t.role === 'STANDBY_EXPECTED')) role = 'STANDBY_EXPECTED';
      else if (otherPorts.length === 0 && trunks.every((t) => t.role === 'DOWN_UNEXPECTED')) role = 'DOWN_UNEXPECTED';
      else if (trunks.some((t) => t.role === 'STANDBY_EXPECTED' || t.role === 'ROLE_UNKNOWN' || t.mechanism === 'E_TRUNK')) {
        role = 'ROLE_UNKNOWN';
        if (otherPorts.length) missing.push(`papel das portas ${otherPorts.join(', ')} na VLAN do AC (nao sao Eth-Trunk com protecao lida)`);
      } else role = 'DOWN_UNEXPECTED';
      acRoles.set(ac.interfaceName, { role, trunks, reasons: [...new Set(reasons)], missing: [...new Set(missing)] });
    }
  const roleOf = (name: string): PathRole | null => acRoles.get(name)?.role ?? null;
  const acRoleList = vsi.acs.map((a) => roleOf(a.interfaceName));
  /** Todos os ACs em standby comprovado: a VSI down e o comportamento esperado da redundancia. */
  const allStandby = redundancyInScope && vsi.acs.length > 0 && acRoleList.every((r) => r === 'STANDBY_EXPECTED');
  /** Nenhum AC com falha comprovada nem ativo: standby e/ou papel indeterminado. */
  const inactiveNotFailed = redundancyInScope && vsi.acs.length > 0 && acRoleList.every((r) => r === 'STANDBY_EXPECTED' || r === 'ROLE_UNKNOWN');

  if (vsi.state === 'DOWN') {
    if (allStandby)
      add({ code: 'VSI_DOWN_STANDBY_EXPECTED', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
        title: 'VSI down neste equipamento: lado BACKUP da redundancia de acesso',
        explanation: `O equipamento reporta VSI State: down e todos os ACs (${vsi.acs.map((a) => a.interfaceName).join(', ')}) estao em standby comprovado pelo mecanismo de protecao. Sem AC ativo a VSI nao sobe: e o estado esperado do lado Backup.`,
        caveat: 'Vale somente para ESTA ponta. Que o servico esteja encaminhando depende do lado ativo, que deve ser diagnosticado a parte.', evidence: vsiEv });
    else if (inactiveNotFailed)
      add({ code: 'VSI_DOWN_ROLE_UNKNOWN', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'INCONCLUSIVE',
        title: 'VSI down com papel de redundancia nao determinado',
        explanation: 'O equipamento reporta VSI State: down. Ha indicio de redundancia de acesso, mas o papel dos ACs nao foi comprovado: nao e possivel afirmar standby esperado nem falha.',
        caveat: 'Nao tratar como normal: ver PATH_ROLE_UNKNOWN para a evidencia que falta.', evidence: vsiEv });
    else
      add({ code: 'VSI_DOWN', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
        title: 'VSI em estado down', explanation: 'O equipamento reporta VSI State: down.', caveat: null, evidence: vsiEv });
  }

  for (const ac of vsi.acs) {
    const r = acRoles.get(ac.interfaceName);
    const rEv = [...vsiEv, ...(r?.trunks.flatMap((t) => redundancyEv(t.interfaceName, t.eTrunkId)) ?? [])];
    if (ac.state === 'DOWN') {
      if (r?.role === 'STANDBY_EXPECTED')
        add({ code: 'STANDBY_PATH_IDLE', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
          title: `AC ${ac.interfaceName} inativo: caminho BACKUP da redundancia`,
          explanation: `${ac.interfaceName} reporta State: down porque o caminho esta em standby: ${r.reasons.join('; ')}. Nao se espera encaminhamento nem aprendizado de MAC por este caminho neste estado.`,
          caveat: 'O papel foi lido do equipamento nesta sessao; apos um failover o papel muda e o diagnostico deve ser refeito.', evidence: rEv });
      else if (r?.role === 'ROLE_UNKNOWN')
        add({ code: 'PATH_ROLE_UNKNOWN', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
          title: `AC ${ac.interfaceName} down: papel na redundancia nao determinado`,
          explanation: `${ac.interfaceName} reporta State: down e ha indicio de redundancia${r.reasons.length ? ` (${r.reasons.join('; ')})` : ''}, mas falta evidencia para classificar como standby esperado ou falha: ${r.missing.join('; ') || 'mecanismo de protecao nao lido'}.`,
          caveat: 'Nao e declaracao de normalidade: sem a evidencia listada o AC down pode ser falha real.', evidence: rEv });
      else
        add({ code: 'AC_DOWN', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
          title: `AC ${ac.interfaceName} down`,
          explanation: `A interface ${ac.interfaceName} esta vinculada a VSI mas reporta State: down.${r?.reasons.length ? ` O caminho deveria estar ativo: ${r.reasons.join('; ')}.` : ''}`,
          caveat: null, evidence: rEv });
    }
    // Estado da protecao no caminho (ativo ou nao): perda de redundancia e riscos lidos do E-Trunk/LACP.
    for (const t of r?.trunks ?? []) {
      const tEv = redundancyEv(t.interfaceName, t.eTrunkId);
      if (t.alerts.includes('PEER_MEMBER_DOWN'))
        add({ code: 'REDUNDANCY_PEER_MEMBER_DOWN', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
          title: `${t.interfaceName} e Master porque o membro do par esta down (E-Trunk ${t.eTrunkId})`,
          explanation: `${t.reasons.join('; ')}. Este lado assumiu ou mantem o encaminhamento sem caminho de reserva disponivel: failover em curso ou par fora de servico.`,
          caveat: 'O servico pode estar integro por este lado; o alerta e de perda de redundancia.', evidence: tEv });
      if (t.alerts.includes('ETRUNK_PEER_UNREACHABLE'))
        add({ code: 'ETRUNK_PEER_UNREACHABLE', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
          title: `E-Trunk ${t.eTrunkId} em Master sem comunicacao valida com o par`,
          explanation: `${t.reasons.join('; ')}. Sem o protocolo com o par, os dois lados podem assumir Master ao mesmo tempo.`,
          caveat: 'Confirmar o estado no outro equipamento.', evidence: tEv });
      if (t.alerts.includes('MEMBER_NOT_SELECTED'))
        add({ code: 'TRUNK_MEMBER_NOT_SELECTED', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
          title: `${t.interfaceName} ativo com ${t.selectedMembers}/${t.totalMembers} membro(s) em uso`,
          explanation: `${t.reasons.join('; ')}. Membro fora do agregado reduz capacidade; o aprendizado de MAC continua sendo na interface logica.`,
          caveat: 'Pode ser intencional (max active-linknumber / membro de reserva).', evidence: tEv });
      if (t.alerts.includes('FORCED_STATE'))
        add({ code: 'ETRUNK_FORCED_STATE', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
          title: `${t.interfaceName} com estado E-Trunk forcado por configuracao`,
          explanation: `${t.reasons.join('; ')}.`, caveat: 'Estado forcado nao acompanha falhas: confirmar se e intencional.', evidence: tEv });
    }
  }
  if (vsi.acs.length === 0)
    add({ code: 'NO_AC', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
      title: 'VSI sem AC', explanation: 'Nenhuma interface de acesso (AC) listada na VSI neste equipamento.',
      caveat: 'Em VSI puramente de transito (hub) a ausencia de AC pode ser intencional.', evidence: vsiEv });

  // Conferencia persistido x equipamento: AC no banco que a VSI viva nao lista.
  const liveAcs = new Set(vsi.acs.map((a) => a.interfaceName));
  for (const name of f.persistedAcs ?? []) {
    if (liveAcs.has(name)) continue;
    const cfg = f.interfaces[name];
    const otherVsi = cfg?.complete && cfg.l2BindingVsi && cfg.l2BindingVsi !== f.vsiName ? cfg.l2BindingVsi : null;
    const evidence = [...vsiEv, ...(f.evidenceIds.interfaces[name] ? [f.evidenceIds.interfaces[name]!] : [])];
    if (otherVsi)
      add({ code: 'PERSISTED_AC_OBSOLETE', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `Registro do AC ${name} na VSI ${f.vsiName} esta obsoleto`,
        explanation: `${name} nao esta na VSI viva (ACs: ${[...liveAcs].join(', ') || 'nenhum'}) e sua configuracao atual faz "l2 binding vsi ${otherVsi}", outra VSI. O registro persistido nao representa um AC atual de ${f.vsiName}.`,
        caveat: 'O fato (nao e AC atual) esta confirmado pelo equipamento; que a causa seja interface movida de VSI e registro antigo nao removido pela coleta SNMP e provavel, nao provado aqui.',
        evidence });
    else
      add({ code: 'PERSISTED_AC_NOT_IN_LIVE_VSI', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: `AC ${name} consta no NetVision mas nao esta na VSI do equipamento`,
        explanation: `O equipamento lista como AC de ${f.vsiName} apenas: ${[...liveAcs].join(', ') || '(nenhum)'}. O registro persistido de ${name} diverge${cfg?.complete ? '' : ' e a configuracao desta interface nao foi coletada, entao a obsolescencia nao esta confirmada'}.`,
        caveat: 'Hipotese mais simples: registro persistido antigo (a coleta SNMP nao remove ACs que sairam da VSI). Nao indica falha do circuito.',
        evidence });
  }

  // Binding efetivo: cada AC vivo deve apontar, na propria config, para ESTA VSI.
  for (const ac of vsi.acs) {
    const cfg = f.interfaces[ac.interfaceName];
    if (cfg?.complete && cfg.l2BindingVsi !== f.vsiName)
      add({ code: 'AC_BINDING_MISMATCH', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `${ac.interfaceName} aparece na VSI ${f.vsiName} mas a config aponta para ${cfg.l2BindingVsi ?? 'nenhuma VSI'}`,
        explanation: 'A lista de ACs da VSI e a configuracao da interface divergem.', caveat: 'As leituras nao sao atomicas; uma alteracao entre elas pode explicar a diferenca.',
        evidence: [...vsiEv, ...(f.evidenceIds.interfaces[ac.interfaceName] ? [f.evidenceIds.interfaces[ac.interfaceName]!] : [])] });
  }

  // Conferencia persistido x equipamento: PW gravado como UP que a coleta nao ve mais.
  for (const pw of f.persistedPws?.pws ?? []) {
    if (pw.state !== 'UP' || !isPersistedPwStale(pw.lastSeenAt, f.persistedPws!.vsiLastSeenAt)) continue;
    const live = vsi.pws.find((p) => p.peerAddress === pw.peerAddress);
    if (live?.state === 'UP') continue;
    add({ code: 'PERSISTED_PW_STALE', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
      title: `Registro do PW para ${pw.peerAddress} no NetVision esta obsoleto`,
      explanation: `O banco guarda o PW como UP, com ultima leitura em ${pw.lastSeenAt} (a VSI foi lida em ${f.persistedPws!.vsiLastSeenAt}); o equipamento ${live ? 'reporta o PW down' : 'nao lista esse PW'}. O registro nao representa o estado atual.`,
      caveat: 'A coleta SNMP so faz upsert e nao remove PWs que deixaram de existir; nao indica falha do circuito.', evidence: vsiEv });
  }

  if (vsi.state === 'DOWN' && inactiveNotFailed && vsi.pws.some((p) => p.state === 'DOWN'))
    add({ code: 'PW_DOWN_ON_INACTIVE_PATH', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: allStandby ? 'CONFIRMED' : 'INCONCLUSIVE',
      title: 'Pseudowires down em ponta sem AC ativo',
      explanation: `PW(s) ${vsi.pws.filter((p) => p.state === 'DOWN').map((p) => p.peerAddress).join(', ')} down com a VSI down. ${allStandby ? 'Esperado no lado Backup: sem AC ativo a VSI nao sinaliza PW.' : 'O papel desta ponta na redundancia nao foi determinado.'}`,
      caveat: null, evidence: vsiEv });
  else if (vsi.pws.length > 0 && vsi.pws.every((p) => p.state === 'DOWN'))
    add({ code: 'ALL_PW_DOWN', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
      title: 'Todos os pseudowires down', explanation: 'Todos os PWs listados reportam PW State: down.', caveat: null, evidence: vsiEv });
  else
    for (const pw of vsi.pws)
      if (pw.state === 'DOWN')
        add({ code: 'PW_DOWN', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
          title: `PW para ${pw.peerAddress} down`, explanation: `O PW com o peer ${pw.peerAddress} reporta PW State: down.`, caveat: null, evidence: vsiEv });

  for (const pw of vsi.pws)
    if (pw.state === 'UP' && (pw.localLabel === null || pw.remoteLabel === null))
      add({ code: 'PW_UP_WITHOUT_LABELS', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `PW ${pw.peerAddress} up sem labels completos`,
        explanation: 'PW up mas com label local ou remoto ausente na saida; encaminhamento pode estar incompleto.',
        caveat: 'Pode ser limitacao do parser para esta versao de VRP.', evidence: vsiEv });

  /* ---- CENARIO A: binding duplicado fisica + subinterface ---- */
  const bound = new Map<string, 'VSI_OUTPUT' | 'INTERFACE_CONFIG'>();
  for (const ac of vsi.acs) bound.set(ac.interfaceName, 'VSI_OUTPUT');
  for (const cfg of Object.values(f.interfaces))
    if (cfg.complete && cfg.interfaceName && cfg.l2BindingVsi === f.vsiName) bound.set(cfg.interfaceName, bound.get(cfg.interfaceName) ?? 'INTERFACE_CONFIG');
  const names = [...bound.keys()];
  for (const parent of names)
    for (const child of names)
      if (isParentOf(parent, child)) {
        const parentCfg = f.interfaces[parent];
        add({
          code: 'DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE', severity: 'CRITICAL',
          certainty: 'CONFIRMED',
          // O fato e confirmado; o efeito (quebra de PPPoE/QinQ) e provavel, nao provado.
          impactCertainty: 'PROBABLE',
          title: `${parent} e ${child} ligadas a mesma VSI ${f.vsiName}`,
          explanation:
            `A interface fisica/pai ${parent} e a subinterface ${child} aparecem como AC da mesma VSI. ` +
            'Com a interface pai vinculada, quadros que deveriam ser classificados pela subinterface (Dot1Q/QinQ) ' +
            'podem ser capturados pelo AC do pai, gerando classificacao ambigua, duplicacao ou aprendizado MAC ' +
            'inconsistente. Em PPPoE o sintoma tipico e VSI/PW "up" com falha no PADI/PADO.',
          caveat:
            'Nao e invalido em todo cenario: depende do modelo de ligacao (port-based vs sub-interface) e da ' +
            'versao. Confirmar com a remocao controlada do binding do pai em janela de manutencao e observar o PPPoE.' +
            (parentCfg && parentCfg.complete ? '' : ' A configuracao da interface pai nao foi coletada.'),
          evidence: [vsiEv[0], f.evidenceIds.interfaces[parent], f.evidenceIds.interfaces[child]].filter((x): x is string => !!x),
        });
      }

  /* ---- Transformacoes de VLAN por AC ---- */
  const vlanPaths: AcVlanTransform[] = [];
  for (const ac of vsi.acs) {
    const cfg = f.interfaces[ac.interfaceName];
    if (!cfg || !cfg.complete) {
      add({ code: 'AC_CONFIG_MISSING', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
        title: `Configuracao de ${ac.interfaceName} nao coletada`,
        explanation: 'Sem `display current-configuration interface` do AC nao e possivel avaliar Dot1Q/QinQ/mapping.',
        caveat: null, evidence: vsiEv });
      continue;
    }
    vlanPaths.push(acVlanTransform(cfg));
  }

  /* ---- contexto VLAN/portas usado pelo MAC e pelo encapsulamento ---- */
  const onlyAc = vsi.acs.length === 1 ? vsi.acs[0]! : null;
  const vlanifMatch = onlyAc ? /^Vlanif(\d+)$/i.exec(onlyAc.interfaceName) : null;
  const vlanifId = vlanifMatch ? Number(vlanifMatch[1]) : null;
  const pwUp = vsi.pws.some((p) => p.state === 'UP');
  /** O que a config de uma porta L2 diz sobre a VLAN do AC: true/false/null (nao lida ou nao interpretavel). */
  const portCarriesVlan = (port: string): boolean | null => (vlanifId === null ? null : carriesVlan(port, vlanifId));
  // Portas (Learned-From com nome de interface, diferente do AC) pelas quais a VSI aprendeu MAC.
  const macPorts = onlyAc
    ? [...new Set((f.macs?.complete ? f.macs.entries : []).filter((e) => e.side === 'AC' && e.learnedFrom !== onlyAc.interfaceName).map((e) => e.learnedFrom))]
    : [];
  // Porta fora da VLAN do AC: nao listada em `display vlan` E config lida que nao permite a VLAN.
  const vlanUsable = !!f.vlan?.complete && f.vlan.exists !== false && vlanifId !== null && f.vlan.vlanId === vlanifId;
  const outsideVlanPorts = vlanUsable ? macPorts.filter((p) => !f.vlan!.ports.some((x) => x.name === p) && portCarriesVlan(p) === false) : [];
  // Com PW up, o campo Learned-From nao distingue "porta de acesso" de "interface de saida do tunel do PW"
  // (comportamento nao documentado/nao homologado): a origem dessas entradas fica INDETERMINADA.
  const unresolvedOrigin = pwUp ? outsideVlanPorts : [];
  /** Segundos entre o ultimo up do PW (unico PW up com uptime) e o aprendizado do MAC; >0 = depois do PW subir. */
  const pwUpRefs = vsi.pws.filter((p) => p.state === 'UP' && typeof p.totalUpSeconds === 'number');
  const sinceLastPwUp = (ageSeconds: number | null | undefined): number | null =>
    pwUpRefs.length === 1 && typeof ageSeconds === 'number' ? pwUpRefs[0]!.totalUpSeconds! - ageSeconds : null;

  /* ---- MAC ---- */
  const macRequested = f.requested?.mac !== false;
  const macEv = f.evidenceIds.macs ? [f.evidenceIds.macs] : [];
  let macSummary: MacSummary | null = null;
  let macUnclassifiedOrigin: string[] = [];
  if (f.macs?.complete) {
    const entries = f.macs.entries;
    // AC so com evidencia: o Learned-From e o proprio AC, a interface pai/filha dele, ou (AC Vlanif) uma porta
    // que `display vlan`/a config da porta comprovam estar na VLAN. PW so quando o campo traz o peer/PW.
    // Qualquer outra interface fica NAO CLASSIFICADA — nunca e presumida AC nem PW.
    const acIfNames = vsi.acs.map((a) => a.interfaceName);
    // A tabela MAC abrevia o tipo da interface (GE1/0/1 = GigabitEthernet1/0/1, XGE = XGigabitEthernet): mesma interface.
    const canon = (name: string): string => name.replace(/^XGE(?=\d)/, 'XGigabitEthernet').replace(/^GE(?=\d)/, 'GigabitEthernet');
    const isAcInterface = (raw: string): boolean => {
      const name = canon(raw);
      return acIfNames.map(canon).some((n) => n === name || isParentOf(name, n) || isParentOf(n, name));
    };
    const inAcVlan = (port: string): boolean =>
      vlanifId !== null && !unresolvedOrigin.includes(port) && ((vlanUsable && f.vlan!.ports.some((x) => x.name === port)) || portCarriesVlan(port) === true);
    const viaAcEntry = (e: (typeof entries)[number]): boolean => e.side === 'AC' && (isAcInterface(e.learnedFrom) || inAcVlan(e.learnedFrom));
    const pwMacs = entries.filter((e) => e.side === 'PW').length;
    const acMacs = entries.filter(viaAcEntry).length;
    const unclassified = entries.filter((e) => e.side !== 'PW' && !viaAcEntry(e));
    const unresolvedMacs = unclassified.length;
    macUnclassifiedOrigin = [...new Set(unclassified.map((e) => e.learnedFrom))];
    const count = (key: (e: (typeof entries)[number]) => string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const e of entries) out[key(e)] = (out[key(e)] ?? 0) + 1;
      return out;
    };
    const ages = entries.map((e) => e.ageSeconds).filter((x): x is number => typeof x === 'number');
    macSummary = {
      total: entries.length, declaredTotal: f.macs.declaredTotal, viaAc: acMacs, viaPw: pwMacs,
      viaUnresolved: unresolvedMacs, unresolvedOrigin: macUnclassifiedOrigin,
      byLearnedFrom: count((e) => e.learnedFrom), byType: count((e) => e.type),
      oldestAgeSeconds: ages.length ? Math.max(...ages) : null, newestAgeSeconds: ages.length ? Math.min(...ages) : null,
      pwMacFlapping: vsi.pws.map((p) => ({ peer: p.peerAddress, counter: p.macFlapping ?? null })),
      history: 'NOT_AVAILABLE',
    };
    // Ausencia de MAC e INFORMATIVA: nao e prova de falha de trafego (aging, janela sem trafego, MAC so de um lado).
    // Com entradas de origem nao classificada, "nenhum MAC via AC" tambem nao pode ser afirmado (podem SER as do AC).
    if (vsi.state === 'UP' && acMacs === 0 && unresolvedMacs === 0)
      add({ code: 'NO_MAC_FROM_AC', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: 'Nenhum MAC aprendido via AC no momento da consulta',
        explanation: `${acMacs} MAC(s) via AC, ${pwMacs} via PW${unresolvedMacs > 0 ? ` e ${unresolvedMacs} de origem nao classificada (${macUnclassifiedOrigin.join(', ')})` : ''}. Isso sozinho nao prova falha: pode ser aging ou ausencia de trafego.`,
        caveat: 'So e relevante se houver trafego esperado e outros sinais de falha.', evidence: macEv });
    // Com entradas de origem indeterminada, "nenhum MAC via PW" nao pode ser afirmado (podem SER as do PW).
    if (vsi.state === 'UP' && pwUp && pwMacs === 0 && acMacs > 0 && unresolvedMacs === 0)
      add({ code: 'NO_MAC_FROM_PW', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: 'Nenhum MAC aprendido via PW no momento da consulta',
        explanation: `${acMacs} MAC(s) via AC e nenhum via PW (PW up). Pode significar que a outra ponta nao enviou quadros para esta VSI recentemente.`,
        caveat: 'Observacao pontual; o aprendizado depende de trafego e de aging. Nao e conclusao de falha.', evidence: macEv });

    // Relacao temporal MAC x PW, calculada na MESMA sessao (Age do MAC vs PW Total Up Time), sem depender de relogio.
    const timed = entries.map((e) => ({ e, d: sinceLastPwUp(e.ageSeconds) })).filter((x): x is { e: typeof x.e; d: number } => x.d !== null);
    const atPwUp = timed.filter((x) => x.d >= -30 && x.d <= 60);
    if (timed.length > 0 && atPwUp.length === timed.length)
      add({ code: 'MAC_LEARNED_AT_PW_UP', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: `Todos os ${timed.length} MAC(s) da VSI foram aprendidos ate ${Math.max(0, ...timed.map((x) => x.d))} s apos o ultimo up do PW ${pwUpRefs[0]!.peerAddress}`,
        explanation: `Idade de cada MAC comparada ao PW Total Up Time lidos na mesma sessao: ${timed.map((x) => `${x.e.mac} (${x.e.learnedFrom}) ${x.d >= 0 ? '+' : ''}${x.d} s`).join('; ')}. Compativel com limpeza da tabela MAC na transicao do PW e reaprendizado imediato; MACs com essa idade so persistem se houver trafego continuo ou aging desabilitado.`,
        caveat: 'Relacao temporal (tolerancia de alguns segundos entre comandos); nao identifica por onde cada MAC entrou.', evidence: [...macEv, ...vsiEv] });

    // MAC flapping: so o contador que o PROPRIO equipamento informa (campo `Mac Flapping` do PW).
    const flapping = vsi.pws.filter((p) => (p.macFlapping ?? 0) > 0);
    if (flapping.length)
      add({ code: 'MAC_FLAPPING_REPORTED', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `Equipamento reporta MAC flapping em ${flapping.length} PW(s)`,
        explanation: `Contador "Mac Flapping" > 0 em: ${flapping.map((p) => `${p.peerAddress}=${p.macFlapping}`).join(', ')}. MACs trocando de origem entre PW/AC costumam indicar laco ou duplicidade de caminho.`,
        caveat: 'O contador e informado pelo equipamento desde que o PW subiu; nao indica se o flapping e atual nem qual MAC.', evidence: vsiEv });

    // Duplicata do mesmo MAC na tabela da VSI (esperado: unico por VSI/VLAN).
    const seen = new Map<string, string[]>();
    for (const e of entries) seen.set(e.mac, [...(seen.get(e.mac) ?? []), e.learnedFrom]);
    const dups = [...seen].filter(([, from]) => from.length > 1);
    if (dups.length)
      add({ code: 'MAC_DUPLICATE_IN_TABLE', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: `${dups.length} MAC(s) aparecem mais de uma vez na tabela da VSI`,
        explanation: dups.slice(0, 5).map(([mac, from]) => `${mac} em ${from.join(' e ')}`).join('; '),
        caveat: 'Pode ser VLAN distinta dentro da mesma VSI ou mudanca de origem entre leituras; nao prova laco.', evidence: macEv });

    const blackhole = entries.filter((e) => e.typeClass === 'BLACKHOLE');
    if (blackhole.length)
      add({ code: 'MAC_BLACKHOLE_PRESENT', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `${blackhole.length} MAC(s) de tipo blackhole na VSI`,
        explanation: `Quadros para ${blackhole.slice(0, 5).map((e) => e.mac).join(', ')} sao descartados por configuracao.`,
        caveat: 'Pode ser intencional (filtragem).', evidence: macEv });
    const statics = entries.filter((e) => e.typeClass === 'STATIC' || e.typeClass === 'OTHER');
    if (statics.length)
      add({ code: 'MAC_NON_DYNAMIC_PRESENT', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: `${statics.length} MAC(s) nao dinamicos (estatico/outro tipo)`,
        explanation: `Tipos: ${[...new Set(statics.map((e) => e.type))].join(', ')}. Entradas estaticas nao dependem de aprendizado por trafego.`,
        caveat: 'Verifique se sao esperadas.', evidence: macEv });

    // Coerencia entre origem do aprendizado e ACs: so avaliavel quando o AC e uma subinterface/porta
    // (para AC Vlanif o MAC e aprendido na porta fisica da VLAN, o que e esperado).
    const acNames = vsi.acs.map((a) => a.interfaceName);
    const allVlanif = acNames.length > 0 && acNames.every((n) => /^Vlanif\d+$/i.test(n));
    if (!allVlanif && acNames.length > 0) {
      const strangers = [...new Set(entries.filter((e) => e.side === 'AC' && !isAcInterface(e.learnedFrom)).map((e) => e.learnedFrom))];
      if (strangers.length)
        add({ code: 'MAC_LEARNED_ON_NON_AC_INTERFACE', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
          title: `MAC aprendido em interface que nao e AC da VSI: ${strangers.join(', ')}`,
          explanation: `ACs vivos: ${acNames.join(', ')}. A tabela da VSI mostra aprendizado por outra(s) interface(s): ${strangers.map((s) => `${s} (${entries.filter((e) => e.learnedFrom === s).length})`).join(', ')}. Essas entradas ficam como origem NAO CLASSIFICADA: nao contam como AC nem como PW.`,
          caveat: 'O campo Learned-From nao distingue porta de acesso de interface de saida do tunel do PW; classificar exige evidencia adicional (ex.: por onde sai o tunel do PW). Nao inferimos local/remoto alem do campo.', evidence: [...macEv, ...vsiEv] });
    }
  } else if (macRequested && vsi.state === 'UP') {
    const reason = f.macs?.incompleteReason;
    add({ code: reason ? 'MAC_TABLE_INCOMPLETE' : 'MAC_EVIDENCE_MISSING', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
      title: reason ? 'Tabela MAC da VSI incompleta ou fora do escopo' : 'Tabela MAC da VSI nao coletada',
      explanation: reason === 'OUT_OF_SCOPE'
        ? 'A saida trouxe linhas de outra VSI: a consulta vazou do escopo pedido e foi descartada.'
        : reason === 'TOTAL_MISMATCH'
          ? `Total declarado (${f.macs?.declaredTotal}) difere das linhas lidas (${f.macs?.entries.length}): saida truncada ou formato inesperado.`
          : reason === 'PAGED'
            ? 'A saida foi paginada (More): captura descartada.'
            : 'Sem a tabela MAC (ausente, truncada pelo limite de saida ou nao suportada) nao ha como avaliar aprendizado nem a presenca de trafego.',
      caveat: null, evidence: macEv });
  }

  // Encapsulamento so e AVALIADO com evidencia. Dois caminhos:
  //  (1) AC de subinterface/porta: diretivas na config do proprio AC;
  //  (2) AC Vlanif unico: `display vlan <id>` + portas por onde a VSI aprendeu MAC (+ config das portas, se lida).
  // O resultado e sempre LOCAL: a outra ponta so e verificada por compare_vsi_endpoints.
  const acsWithConfig = vsi.acs.filter((a) => f.interfaces[a.interfaceName]?.complete);
  const directEncap = vsi.acs.length > 0 && acsWithConfig.length === vsi.acs.length &&
    acsWithConfig.every((a) => acVlanTransform(f.interfaces[a.interfaceName]!).mode !== 'NONE');
  let encapVerdict: DimensionVerdict = directEncap ? 'OK' : 'NOT_EVALUATED';
  let vlanEvidenceUsed = false;

  if (!directEncap && onlyAc && vlanifId !== null && f.vlan) {
    vlanEvidenceUsed = true;
    const acEv = f.evidenceIds.interfaces[onlyAc.interfaceName];
    const vlanEv = [...(f.evidenceIds.vlan ? [f.evidenceIds.vlan] : []), ...(acEv ? [acEv] : [])];
    const v = f.vlan;
    if (!v.complete)
      add({ code: 'VLAN_OUTPUT_INCOMPLETE', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
        title: `Saida de display vlan ${v.vlanId} ausente ou em formato nao reconhecido`,
        explanation: 'Sem a linha da VLAN na tabela de portas nao e possivel comprovar a membership; nada foi presumido.', caveat: null, evidence: vlanEv });
    else if (v.vlanId !== vlanifId)
      add({ code: 'VLAN_AC_NUMBER_MISMATCH', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
        title: `VLAN consultada (${v.vlanId}) difere da VLAN do AC (${vlanifId})`,
        explanation: `${onlyAc.interfaceName} usa a VLAN ${vlanifId}; a evidencia de VLAN ${v.vlanId} nao se aplica.`, caveat: null, evidence: vlanEv });
    else if (v.exists === false) {
      encapVerdict = 'ISSUE';
      add({ code: 'VLAN_NOT_FOUND', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `VLAN ${vlanifId} nao existe no equipamento`,
        explanation: `${onlyAc.interfaceName} e AC da VSI, mas o switch informa que a VLAN ${vlanifId} nao existe.`,
        caveat: 'Leituras nao atomicas: uma alteracao entre elas pode explicar.', evidence: vlanEv });
    } else if (v.status === 'DISABLE') {
      encapVerdict = 'ISSUE';
      add({ code: 'VLAN_DISABLED', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `VLAN ${vlanifId} esta desabilitada`, explanation: 'O status da VLAN e disable.', caveat: null, evidence: vlanEv });
    } else {
      // Portas pelas quais a VSI aprendeu MAC (diferentes do AC = porta fisica/trunk da VLAN).
      const carriers = macPorts;
      // Propriedades da VLAN que afetam o aprendizado/encaminhamento da VSI.
      if (v.macLearning === 'DISABLE')
        add({ code: 'VLAN_MAC_LEARNING_DISABLED', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
          title: `Aprendizado de MAC desabilitado na VLAN ${vlanifId}`, explanation: 'MAC-LRN = disable na tabela de propriedades da VLAN.',
          caveat: 'Pode ser intencional; a VSI depende de aprendizado de MAC para encaminhar unicast.', evidence: vlanEv });
      if (v.forwarding && (v.forwarding.broadcast === 'DSD' || v.forwarding.multicast === 'DSD' || v.forwarding.unknownUnicast === 'DSD'))
        add({ code: 'VLAN_FORWARDING_DISCARD', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
          title: `VLAN ${vlanifId} descarta ${[v.forwarding.broadcast === 'DSD' ? 'broadcast' : '', v.forwarding.multicast === 'DSD' ? 'multicast' : '', v.forwarding.unknownUnicast === 'DSD' ? 'unicast desconhecido' : ''].filter(Boolean).join(', ')}`,
          explanation: 'Controle de encaminhamento BC/MC/UC configurado como DSD.', caveat: 'Pode ser intencional.', evidence: vlanEv });

      const notes: string[] = [];
      const proven: string[] = [];
      const outside: string[] = [];
      const unresolved: string[] = [];
      for (const port of carriers) {
        const member = v.ports.find((p) => p.name === port);
        const cfg = f.carriers?.[port];
        const cfgEv = f.evidenceIds.carriers?.[port] ? [f.evidenceIds.carriers[port]!] : [];
        // O que a config da porta diz sobre a VLAN (independe de a porta constar na tabela da VLAN).
        const carries = portCarriesVlan(port);
        if (!member) {
          if (carries === false && unresolvedOrigin.includes(port)) {
            // PW up: a entrada pode ser o MAC remoto exibido com a interface de saida do tunel do PW
            // (nao documentado para o YunShan; nunca observado com peer no Learned-From nesta familia)
            // ou uma entrada residual. Os comandos desta sessao nao distinguem: INCONCLUSIVE, nao WARNING.
            unresolved.push(port);
            const portEntries = (f.macs?.complete ? f.macs.entries : []).filter((e) => e.learnedFrom === port);
            const timing = portEntries.map((e) => ({ e, d: sinceLastPwUp(e.ageSeconds) })).filter((x) => x.d !== null)
              .map((x) => `${x.e.mac} aprendido ${x.d! >= 0 ? `${x.d} s depois` : `${-x.d!} s antes`} do ultimo up do PW`);
            notes.push(`${port}: origem indeterminada (fora da VLAN ${vlanifId}; pode ser a interface de saida do tunel do PW)`);
            add({ code: 'MAC_ORIGIN_UNRESOLVED', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
              title: `${port} aparece como origem de MAC da VSI, mas nao participa da VLAN ${vlanifId}: origem indeterminada`,
              explanation: `A tabela MAC da VSI lista ${port}; ${port} nao consta em display vlan ${vlanifId} e sua config (${cfg!.portVlan!.linkType}) nao permite a VLAN. Com PW up, o campo Learned-From nao distingue porta de acesso de interface de saida do tunel do PW: a entrada pode ser o MAC remoto recebido pelo PW (exibido com a interface fisica de saida), uma entrada residual ou outro mecanismo nao refletido nestes comandos.${timing.length ? ` Relacao temporal: ${timing.join('; ')}.` : ''}`,
              caveat: 'Nao e inconsistencia confirmada nem prova de transporte do servico por essa porta. Distinguir exige evidencia do caminho do PW (interface de saida do tunel/LSP ate o peer) ou documentacao do formato; nao e feito nesta sessao.',
              evidence: [...vlanEv, ...cfgEv, ...(f.evidenceIds.macs ? [f.evidenceIds.macs] : [])] });
          } else if (carries === false) {
            outside.push(port);
            add({ code: 'MAC_ON_PORT_OUTSIDE_VLAN', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
              title: `${port} tem MAC aprendido na VSI, mas nao participa da VLAN ${vlanifId}`,
              explanation: `A tabela MAC da VSI lista ${port}; ${port} nao consta em display vlan ${vlanifId} e sua config (${cfg!.portVlan!.linkType}) nao permite a VLAN. Sem PW up nao ha tunel que explique a entrada: pelo estado atual a porta nao deveria aprender MAC desta VSI.`,
              caveat: 'Hipoteses nao distinguidas: entrada residual (porta/VLAN reconfigurada apos o aprendizado), outro mecanismo de entrada nao refletido nestes comandos, ou leitura nao atomica. Nao prova falha do servico.',
              evidence: [...vlanEv, ...cfgEv, ...(f.evidenceIds.macs ? [f.evidenceIds.macs] : [])] });
          } else {
            unresolved.push(port);
            notes.push(`${port}: MAC aprendido na VSI, mas a porta nao consta na tabela da VLAN ${vlanifId} e a config da porta ${cfg?.complete ? 'nao permite concluir' : 'nao foi lida'}`);
          }
          continue;
        }
        if (member.tagging === 'STACKING' || member.tagging === 'MAPPING') {
          unresolved.push(port);
          add({ code: 'VLAN_TRANSFORM_ON_CARRIER', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
            title: `${port} aplica ${member.tagging === 'STACKING' ? 'vlan-stacking (QinQ)' : 'vlan-mapping'} na VLAN ${vlanifId}`,
            explanation: 'A porta transforma a VLAN; a tag no cliente pode diferir da VLAN do AC.',
            caveat: 'A traducao exata so se confirma pela config da porta.', evidence: [...vlanEv, ...cfgEv] });
          continue;
        }
        if (carries === false) {
          outside.push(port);
          add({ code: 'CARRIER_CONFIG_CONTRADICTS_VLAN', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
            title: `${port} consta na VLAN ${vlanifId} mas a config da porta nao a permite`,
            explanation: `link-type ${cfg!.portVlan!.linkType}; allow-pass/tagged/default nao incluem ${vlanifId}.`,
            caveat: 'Pode ter sido alterada entre as leituras; confira o historico.', evidence: [...vlanEv, ...cfgEv] });
          continue;
        }
        if (member.tagging === null) {
          unresolved.push(port);
          notes.push(`${port}: tagging nao informado`);
          continue;
        }
        proven.push(port);
        notes.push(`${port}: ${member.tagging === 'TAGGED' ? 'tagged' : 'untagged'}, ${member.state === 'UP' ? 'up' : member.state === 'DOWN' ? 'down' : 'estado n/d'}${carries === true ? ', config da porta permite a VLAN' : ', config da porta nao lida'}`);
      }

      const all = carriers.length > 0 && proven.length === carriers.length;
      if (outside.length) encapVerdict = 'ISSUE';
      else encapVerdict = all ? 'OK' : 'NOT_EVALUATED';
      const evAll = [...vlanEv, ...(f.evidenceIds.macs ? [f.evidenceIds.macs] : [])];
      if (all)
        add({ code: 'ENCAPSULATION_LOCAL_PROVEN', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
          title: `Encapsulamento LOCAL comprovado: VLAN ${vlanifId} em ${carriers.join(', ')}`,
          explanation: `VLAN ${vlanifId} existe${v.status ? ` (${v.status.toLowerCase()})` : ''}, ${onlyAc.interfaceName} usa a VLAN pelo numero e os MACs da VSI foram aprendidos em portas listadas nela: ${notes.join('; ')}.`,
          caveat: 'Comprova somente o tratamento local de VLAN; a outra ponta e o trafego fim a fim nao foram verificados e VLAN existente nao implica conectividade.', evidence: evAll });
      else {
        if (proven.length)
          add({ code: 'CARRIER_PORT_VLAN_PROVEN', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
            title: `Caminho local da VLAN ${vlanifId} comprovado em ${proven.join(', ')}`,
            explanation: `${notes.filter((n) => proven.some((p) => n.startsWith(p + ':'))).join('; ')}. A porta consta na VLAN (tagging/estado do equipamento) e o MAC da VSI foi aprendido nela.`,
            caveat: 'Comprova somente o tratamento local daquela porta; nao e conectividade fim a fim.', evidence: evAll });
        if (!outside.length)
          add({ code: 'ENCAPSULATION_NOT_EVALUATED', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
            title: 'Encapsulamento/VLAN nao avaliado',
            explanation: carriers.length === 0
              ? 'Nenhum MAC aprendido na VSI para identificar as portas que a transportam; a relacao porta-servico nao pode ser comprovada.'
              : `Evidencia insuficiente: ${notes.join('; ') || 'tagging nao informado'}.`,
            caveat: 'Comprova somente o tratamento local de VLAN; a outra ponta e o trafego fim a fim nao foram verificados e VLAN existente nao implica conectividade.', evidence: evAll });
      }
    }
  }
  if (!directEncap && !vlanEvidenceUsed && vsi.acs.length > 0 && acsWithConfig.length > 0)
    add({ code: 'ENCAPSULATION_NOT_EVALUATED', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
      title: 'Encapsulamento/VLAN nao avaliado',
      explanation: `A configuracao de ${acsWithConfig.map((a) => a.interfaceName).join(', ')} nao traz diretivas de encapsulamento (comum em interface VLANIF, cuja VLAN e a do numero da interface). Quais portas/trunks carregam a VLAN e como etiquetam nao foi consultado.`,
      caveat: 'Avaliar exige leitura da membership da VLAN (ex.: display vlan <id>) e da config das portas/trunks, nao autorizadas neste escopo.',
      evidence: acsWithConfig.flatMap((a) => (f.evidenceIds.interfaces[a.interfaceName] ? [f.evidenceIds.interfaces[a.interfaceName]!] : [])) });

  const has = (code: string) => findings.some((x) => x.code === code);
  const dimensions: DiagnosisDimensions = {
    // Ponta em standby comprovado ou de papel indeterminado: o estado down nao e avaliado como defeito.
    VSI_STATE: vsi.state === 'UP' ? 'OK' : vsi.state === 'DOWN' ? (inactiveNotFailed ? 'NOT_EVALUATED' : 'ISSUE') : 'NOT_EVALUATED',
    AC_STATE: vsi.acs.length === 0 ? 'NOT_EVALUATED'
      : vsi.acs.some((a) => a.state === 'DOWN' && (roleOf(a.interfaceName) ?? 'DOWN_UNEXPECTED') === 'DOWN_UNEXPECTED') ? 'ISSUE'
      : vsi.acs.every((a) => a.state === 'UP') ? 'OK'
      : vsi.acs.some((a) => a.state === 'UP') && vsi.acs.every((a) => a.state === 'UP' || roleOf(a.interfaceName) === 'STANDBY_EXPECTED') ? 'OK'
      : 'NOT_EVALUATED',
    PW_STATE: vsi.pws.length === 0 ? 'NOT_EVALUATED'
      : vsi.state === 'DOWN' && inactiveNotFailed ? 'NOT_EVALUATED'
      : vsi.pws.some((p) => p.state === 'DOWN') ? 'ISSUE' : vsi.pws.every((p) => p.state === 'UP') ? 'OK' : 'NOT_EVALUATED',
    AC_BINDING: has('AC_BINDING_MISMATCH') || has('DUPLICATE_BINDING_PARENT_AND_SUBINTERFACE') ? 'ISSUE' : vsi.acs.length > 0 && acsWithConfig.length === vsi.acs.length ? 'OK' : 'NOT_EVALUATED',
    MAC_LEARNING: has('MAC_FLAPPING_REPORTED') || has('MAC_BLACKHOLE_PRESENT') ? 'ISSUE' : f.macs?.complete && f.macs.entries.length > 0 ? 'OK' : 'NOT_EVALUATED',
    ENCAPSULATION: has('ENCAPSULATION_TYPE_MISMATCH') ? 'ISSUE' : encapVerdict,
  };

  const coverage: EvidenceCoverage = {
    vsi: true,
    acConfigs: { collected: vsi.acs.filter((a) => f.interfaces[a.interfaceName]?.complete).length, total: vsi.acs.length },
    mac: f.macs?.complete ? 'COLLECTED' : macRequested ? 'MISSING' : 'NOT_REQUESTED',
  };

  // OK so com TODAS as evidencias solicitadas coletadas: "VSI up" sozinho nunca e "saudavel".
  const hasGap = findings.some((x) => x.certainty === 'INCONCLUSIVE');
  const status: DiagnosticStatus = findings.some((x) => x.severity === 'CRITICAL')
    ? 'FAILED'
    : findings.some((x) => x.severity === 'WARNING')
      ? 'WARNING'
      : hasGap
        ? 'INCONCLUSIVE'
        : 'OK';
  const notVerified = [
    ...NOT_VERIFIED,
    ...(macUnclassifiedOrigin.length
      ? [`Origem real (porta de acesso ou interface de saida do tunel do PW) dos MACs em ${macUnclassifiedOrigin.join(', ')}: o campo Learned-From nao distingue; viaAc/viaPw excluem essas entradas`]
      : []),
  ];
  let roles: Pick<EndpointDiagnosis, 'pathRoles' | 'operationalRole'> = {};
  if (redundancyInScope) {
    const pathRoles: PathRoleEntry[] = [];
    for (const ac of vsi.acs) {
      const r = acRoles.get(ac.interfaceName)!;
      pathRoles.push({ kind: 'AC', name: ac.interfaceName, role: r.role, mechanism: r.trunks[0]?.mechanism ?? null, eTrunkId: r.trunks[0]?.eTrunkId ?? null, reasons: r.reasons, missingEvidence: r.missing });
    }
    for (const t of trunkRoles.values())
      pathRoles.push({ kind: 'ETH_TRUNK', name: t.interfaceName, role: t.role, mechanism: t.mechanism, eTrunkId: t.eTrunkId, reasons: t.reasons, missingEvidence: t.missingEvidence });
    const operationalRole: PathRole = vsi.state === 'UP' && acRoleList.some((r) => r === 'ACTIVE') ? 'ACTIVE'
      : allStandby ? 'STANDBY_EXPECTED'
      : acRoleList.some((r) => r === 'DOWN_UNEXPECTED') || (vsi.state === 'DOWN' && !inactiveNotFailed) ? 'DOWN_UNEXPECTED'
      : 'ROLE_UNKNOWN';
    roles = { pathRoles, operationalRole };
  }
  if (allStandby) notVerified.push('Lado ATIVO da redundancia: esta ponta esta em standby; o encaminhamento do servico so se comprova no equipamento Master');
  return { hostId: f.hostId, hostName: f.hostName, vsiName: f.vsiName, status, coverage, dimensions, macSummary, notVerified, findings, vlanPaths, ...roles };
}

/* ----------------------------- comparacao ----------------------------- */

export interface TrafficStage {
  stage: 'A_AC' | 'A_PW' | 'B_PW' | 'B_AC';
  macCount: number | null;
}

export interface EndpointComparison {
  status: DiagnosticStatus;
  findings: Finding[];
  vlanComparison: {
    a: AcVlanTransform[];
    b: AcVlanTransform[];
  };
  trafficObservation: {
    stages: TrafficStage[];
    /** Ultimo estagio com evidencia, na ordem A_AC -> A_PW -> B_PW -> B_AC. */
    lastObservedStage: TrafficStage['stage'] | null;
    note: string;
  };
}

export function compareEndpoints(
  a: EndpointFacts,
  b: EndpointFacts,
  options: { peerAddressOnA?: string; peerAddressOnB?: string } = {},
): EndpointComparison {
  const findings: Finding[] = [];
  const add = (x: Omit<Finding, 'hostId'>) => findings.push({ ...x, hostId: null });
  const da = diagnoseEndpoint(a);
  const db = diagnoseEndpoint(b);
  findings.push(...da.findings, ...db.findings);

  const va = a.vsi?.complete ? a.vsi : null;
  const vb = b.vsi?.complete ? b.vsi : null;
  const evs = [a.evidenceIds.vsi, b.evidenceIds.vsi].filter((x): x is string => !!x);

  if (!va || !vb) {
    add({ code: 'COMPARISON_INCONCLUSIVE', severity: 'WARNING', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
      title: 'Comparacao inconclusiva', explanation: 'Falta a saida completa da VSI em pelo menos uma das pontas.', caveat: null, evidence: evs });
  } else {
    if (va.encapsulationType && vb.encapsulationType && va.encapsulationType !== vb.encapsulationType)
      add({ code: 'ENCAPSULATION_TYPE_MISMATCH', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `Encapsulation Type diferente: ${a.hostName}=${va.encapsulationType} x ${b.hostName}=${vb.encapsulationType}`,
        explanation:
          'Pontas com tipo de encapsulamento de PW distintos (vlan x ethernet) tratam a tag de servico de forma diferente: ' +
          'uma carrega a VLAN no PW e a outra a remove/espera sem tag. E uma causa classica de VSI/PW "up" sem passagem de trafego.',
        caveat: 'Alguns equipamentos negociam o tipo via LDP e o PW so sobe se coincidir; PW up sugere negociacao ok.', evidence: evs });

    if (va.mtu !== null && vb.mtu !== null && va.mtu !== vb.mtu)
      add({ code: 'MTU_MISMATCH', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
        title: `MTU da VSI diferente: ${va.mtu} x ${vb.mtu}`,
        explanation: 'MTU de VSI distinta entre as pontas pode derrubar o PW (LDP) ou causar descarte de quadros grandes (PPPoE/QinQ).',
        caveat: null, evidence: evs });

    // RD: o mesmo valor pode ser exibido em asplain ou asdot conforme a versao; compara-se a forma canonica.
    if (va.rd && vb.rd && va.rd !== vb.rd && normalizeRd(va.rd) !== null && normalizeRd(va.rd) === normalizeRd(vb.rd))
      add({ code: 'RD_SAME_VALUE_DIFFERENT_NOTATION', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: 'CONFIRMED',
        title: `RD igual em notacoes diferentes: ${va.rd} x ${vb.rd}`,
        explanation: `As duas pontas usam o mesmo RD (${normalizeRd(va.rd)}); uma exibe o ASN de 4 bytes em asdot e a outra em asplain.`,
        caveat: 'Nao e divergencia de configuracao.', evidence: evs });

    const pwA = pickPw(va, options.peerAddressOnA);
    const pwB = pickPw(vb, options.peerAddressOnB);
    if (!pwA || !pwB) {
      add({ code: 'PW_PAIR_UNRESOLVED', severity: 'INFO', certainty: 'INCONCLUSIVE', impactCertainty: 'INCONCLUSIVE',
        title: 'Par de PW nao resolvido',
        explanation: 'Mais de um PW (ou nenhum) em uma das pontas; informe peerAddressOnA/peerAddressOnB para comparar labels.',
        caveat: null, evidence: evs });
    } else {
      if (pwA.state !== pwB.state) {
        const inactive = [da, db].filter((d) => d.operationalRole === 'STANDBY_EXPECTED' || d.operationalRole === 'ROLE_UNKNOWN');
        const standbyOnly = inactive.length > 0 && inactive.every((d) => d.operationalRole === 'STANDBY_EXPECTED');
        if (inactive.length)
          add({ code: 'PW_STATE_ASYMMETRIC_INACTIVE_PATH', severity: 'INFO', certainty: 'CONFIRMED', impactCertainty: standbyOnly ? 'CONFIRMED' : 'INCONCLUSIVE',
            title: `Estado do PW difere (${pwA.state} x ${pwB.state}) com uma ponta fora do caminho ativo`,
            explanation: `${inactive.map((d) => `${d.hostName}: ${d.operationalRole}`).join('; ')}. ${standbyOnly ? 'Com a ponta em standby comprovado a diferenca e esperada.' : 'O papel da ponta nao foi determinado: nao se afirma falha nem normalidade.'}`,
            caveat: 'As capturas nao sao simultaneas.', evidence: evs });
        else
          add({ code: 'PW_STATE_ASYMMETRIC', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
            title: `Estado do PW assimetrico: ${pwA.state} x ${pwB.state}`,
            explanation: 'Um lado ve o PW up e o outro down; a sinalizacao ou o underlay e unidirecional.', caveat: null, evidence: evs });
      }
      if (pwA.localLabel !== null && pwA.remoteLabel !== null && pwB.localLabel !== null && pwB.remoteLabel !== null &&
          (pwA.remoteLabel !== pwB.localLabel || pwB.remoteLabel !== pwA.localLabel))
        add({ code: 'PW_LABEL_MISMATCH', severity: 'CRITICAL', certainty: 'CONFIRMED', impactCertainty: 'PROBABLE',
          title: 'Labels do PW nao se correspondem',
          explanation: `Esperado: label remoto de A (${pwA.remoteLabel}) = label local de B (${pwB.localLabel}) e vice-versa (${pwB.remoteLabel} x ${pwA.localLabel}).`,
          caveat: 'As capturas nao sao simultaneas; uma renegociacao entre elas pode explicar a diferenca.', evidence: evs });
    }
  }

  /* ---- CENARIO B: caminho de VLAN ---- */
  const pathsA = da.vlanPaths;
  const pathsB = db.vlanPaths;
  const transformsA = pathsA.filter((p) => p.mode === 'VLAN_MAPPING' || p.mode === 'QINQ_STACKING' || p.mode === 'REWRITE');
  const transformsB = pathsB.filter((p) => p.mode === 'VLAN_MAPPING' || p.mode === 'QINQ_STACKING' || p.mode === 'REWRITE');
  const modesA = new Set(pathsA.map((p) => p.mode));
  const modesB = new Set(pathsB.map((p) => p.mode));
  const confEvidence = [...Object.values(a.evidenceIds.interfaces), ...Object.values(b.evidenceIds.interfaces)];

  if (pathsA.length && pathsB.length) {
    const aTransforms = transformsA.length > 0;
    const bTransforms = transformsB.length > 0;
    if (aTransforms !== bTransforms || (aTransforms && bTransforms && !sameTransformMode(transformsA, transformsB))) {
      add({ code: 'VLAN_TRANSFORM_ASYMMETRIC', severity: 'WARNING', certainty: 'CONFIRMED', impactCertainty: 'HYPOTHESIS',
        title: 'Tratamento de VLAN diferente entre as pontas',
        explanation:
          `Ponta A: ${[...modesA].join('/')} (${describeTransforms(pathsA)}). Ponta B: ${[...modesB].join('/')} (${describeTransforms(pathsB)}). ` +
          'Se uma ponta converte/empilha a VLAN (mapping, QinQ stacking, rewrite) e a outra apenas termina Dot1Q, o numero de tags ' +
          'ou o VID transportado no PW pode divergir entre as pontas.',
        caveat: 'HIPOTESE: sem captura de trafego no PW (ou contadores por AC) nao ha como afirmar que esta e a causa da falha.',
        evidence: confEvidence });
    }
    const tagsA = new Set(pathsA.map((p) => p.tagCount).filter((x) => x !== null));
    const tagsB = new Set(pathsB.map((p) => p.tagCount).filter((x) => x !== null));
    if (tagsA.size === 1 && tagsB.size === 1 && [...tagsA][0] !== [...tagsB][0] && (aTransforms || bTransforms))
      add({ code: 'TAG_COUNT_MISMATCH_PROBABLE', severity: 'WARNING', certainty: 'PROBABLE', impactCertainty: 'HYPOTHESIS',
        title: 'Quantidade de tags apos o AC difere entre as pontas',
        explanation: `A ponta A entrega ${[...tagsA][0]} tag(s) a VSI e a ponta B ${[...tagsB][0]}.`,
        caveat: 'Deducao a partir de diretivas de configuracao; o comportamento real depende da versao e do Encapsulation Type.',
        evidence: confEvidence });
  }

  /* ---- Onde o trafego deixa de ser observado (por MAC) ---- */
  // Mesma classificacao do resumo por ponta: entradas de origem nao classificada nao entram em AC nem em PW.
  const count = (d: EndpointDiagnosis, side: 'AC' | 'PW'): number | null =>
    d.macSummary ? (side === 'AC' ? d.macSummary.viaAc : d.macSummary.viaPw) : null;
  const stages: TrafficStage[] = [
    { stage: 'A_AC', macCount: count(da, 'AC') },
    { stage: 'A_PW', macCount: count(da, 'PW') },
    { stage: 'B_PW', macCount: count(db, 'PW') },
    { stage: 'B_AC', macCount: count(db, 'AC') },
  ];
  let last: TrafficStage['stage'] | null = null;
  for (const s of stages) {
    if (s.macCount === null) break;
    if (s.macCount > 0) last = s.stage;
    else break;
  }
  const unknownStage = stages.find((s) => s.macCount === null);
  if (last && last !== 'B_AC' && !unknownStage)
    add({ code: 'TRAFFIC_STOPS_AFTER_STAGE', severity: 'WARNING', certainty: 'PROBABLE', impactCertainty: 'HYPOTHESIS',
      title: `Ultimo ponto com MAC aprendido: ${last}`,
      explanation: 'O aprendizado de MAC cessa apos este estagio na ordem A_AC -> A_PW -> B_PW -> B_AC.',
      caveat: 'MAC aprendido e evidencia indireta de trafego; a ausencia pode ser aging ou falta de trafego no momento.',
      evidence: [a.evidenceIds.macs, b.evidenceIds.macs].filter((x): x is string => !!x) });

  const incomplete = !va || !vb;
  const status: DiagnosticStatus = incomplete
    ? 'INCONCLUSIVE'
    : findings.some((x) => x.severity === 'CRITICAL')
      ? 'FAILED'
      : findings.some((x) => x.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
  return {
    status,
    findings,
    vlanComparison: { a: pathsA, b: pathsB },
    trafficObservation: {
      stages,
      lastObservedStage: last,
      note: unknownStage
        ? 'Tabela MAC ausente/incompleta em pelo menos um estagio: observacao de trafego inconclusiva.'
        : 'Baseado apenas em aprendizado MAC; nao substitui captura de pacotes.',
    },
  };
}

function pickPw(vsi: ParsedVsiVerbose, peer?: string) {
  if (peer) return vsi.pws.find((p) => p.peerAddress === peer) ?? null;
  return vsi.pws.length === 1 ? vsi.pws[0]! : null;
}

function sameTransformMode(a: AcVlanTransform[], b: AcVlanTransform[]): boolean {
  const key = (p: AcVlanTransform) => `${p.mode}:${p.transported.join(',')}`;
  const sa = new Set(a.map(key));
  const sb = new Set(b.map(key));
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

function describeTransforms(paths: AcVlanTransform[]): string {
  return paths
    .map((p) => `${p.interfaceName}: ${p.mode}${p.ingress.length ? ` in=${p.ingress.join('/')}` : ''}${p.transported.length ? ` out=${p.transported.join('/')}` : ''}`)
    .join('; ');
}
