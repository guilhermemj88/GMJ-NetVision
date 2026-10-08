'use client';

import { useState } from 'react';
import { Badge, Button } from '@gmj/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Pencil, Plus, Power, ShieldCheck, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { alarmTypeLabel, type AlarmRuleDto, type AlarmSeverity, type MetricAlarmType, type OpticalRuleConfig } from '@gmj/shared';
import { useMapStore } from '@/store/map-store';
import { getMediaIntegrationsByPurpose } from '@/lib/media-api';
import {
  createAlarmRule,
  deleteAlarmRule,
  getAlarmRules,
  setAlarmRuleEnabled,
  updateAlarmRule,
  type AlarmRuleInput,
} from '@/lib/api';
import {
  BASIC_ALARM_RULE_SLOTS,
  describeAlarmRule,
  describeAlarmRuleScope,
  isRecommendedConfiguration,
  opticalRuleDefaults,
  otherEnabledRulesOfType,
  presetsForType,
  RULE_SPEED_OPTIONS,
  type AlarmRulePreset,
  type BasicAlarmRuleSlot,
} from '@/lib/alarm-rule-presets';

const RULE_TYPES: Array<{ value: MetricAlarmType; label: string }> = [
  { value: 'INTERFACE_ERRORS', label: 'Erros' },
  { value: 'INTERFACE_CRC', label: 'CRC/FCS' },
  { value: 'INTERFACE_DISCARDS', label: 'Discards' },
  { value: 'OPTICAL_RX_DEGRADATION', label: 'Degradação óptica' },
];

const SEVERITIES: AlarmSeverity[] = ['WARNING', 'MAJOR', 'CRITICAL', 'INFO'];

interface RuleDraft {
  name: string;
  type: MetricAlarmType;
  severity: AlarmSeverity;
  mediaEnabled: boolean;
  mapLinkedOnly: boolean;
  speedsBps: number[];
  direction: 'RX' | 'TX' | 'BOTH';
  thresholdPerMinute: number;
  recoveryThresholdPerMinute: number;
  triggerSamples: number;
  recoverySamples: number;
  optical: OpticalRuleConfig;
}

function draftFromRule(rule: AlarmRuleDto): RuleDraft {
  const config = rule.config as unknown as Record<string, number | string | null | undefined>;
  return {
    name: rule.name,
    type: rule.type,
    severity: rule.severity,
    mediaEnabled: rule.mediaEnabled,
    mapLinkedOnly: rule.mapLinkedOnly,
    speedsBps: [...(rule.scope.speedsBps ?? [])],
    direction: (config.direction as 'RX' | 'TX' | 'BOTH' | undefined) ?? 'RX',
    thresholdPerMinute: Number(config.thresholdPerMinute ?? 10),
    recoveryThresholdPerMinute: Number(config.recoveryThresholdPerMinute ?? 2),
    triggerSamples: Number(config.triggerSamples ?? 3),
    recoverySamples: Number(config.recoverySamples ?? 3),
    optical: rule.type === 'OPTICAL_RX_DEGRADATION'
      ? { ...opticalRuleDefaults(), ...(rule.config as OpticalRuleConfig) }
      : opticalRuleDefaults(),
  };
}

function newDraft(type: MetricAlarmType = 'INTERFACE_CRC'): RuleDraft {
  return {
    name: '',
    type,
    severity: type === 'OPTICAL_RX_DEGRADATION' ? 'WARNING' : 'WARNING',
    mediaEnabled: false,
    mapLinkedOnly: true,
    speedsBps: [],
    direction: 'RX',
    thresholdPerMinute: 10,
    recoveryThresholdPerMinute: 2,
    triggerSamples: 3,
    recoverySamples: 3,
    optical: opticalRuleDefaults(),
  };
}

/** Monta o corpo aceito pela API (Zod do backend valida tudo de novo). */
export function draftToRuleInput(draft: RuleDraft, editing?: AlarmRuleDto): AlarmRuleInput {
  const base = {
    name: draft.name.trim(),
    type: draft.type,
    enabled: editing?.enabled ?? true,
    severity: draft.severity,
    mapLinkedOnly: draft.mapLinkedOnly,
    mediaEnabled: draft.mediaEnabled,
    scope: {
      ...(editing?.scope.devices?.length ? { devices: editing.scope.devices } : {}),
      ...(editing?.scope.interfaces?.length ? { interfaces: editing.scope.interfaces } : {}),
      ...(draft.speedsBps.length ? { speedsBps: draft.speedsBps } : {}),
    },
  };
  if (draft.type === 'OPTICAL_RX_DEGRADATION') {
    return { ...base, config: draft.optical };
  }
  const threshold = {
    thresholdPerMinute: draft.thresholdPerMinute,
    recoveryThresholdPerMinute: draft.recoveryThresholdPerMinute,
    triggerSamples: draft.triggerSamples,
    recoverySamples: draft.recoverySamples,
  };
  if (draft.type === 'INTERFACE_CRC') return { ...base, config: threshold };
  return { ...base, config: { direction: draft.direction, ...threshold } };
}

function applyPreset(draft: RuleDraft, preset: AlarmRulePreset): RuleDraft {
  const config = preset.config as unknown as Record<string, number | string | undefined>;
  return {
    ...draft,
    type: preset.type,
    severity: preset.severity,
    direction: (config.direction as 'RX' | 'TX' | 'BOTH' | undefined) ?? draft.direction,
    thresholdPerMinute: Number(config.thresholdPerMinute ?? draft.thresholdPerMinute),
    recoveryThresholdPerMinute: Number(
      config.recoveryThresholdPerMinute ?? draft.recoveryThresholdPerMinute,
    ),
    triggerSamples: Number(config.triggerSamples ?? draft.triggerSamples),
    recoverySamples: Number(config.recoverySamples ?? draft.recoverySamples),
  };
}

/**
 * CONFIGURAÇÕES → ALARMES.
 *
 * BÁSICO (F9.6): camada operacional sobre `AlarmRule` — 4 slots gerenciados por
 * `managedKey` + a proteção nativa de queda de interface (que NÃO é AlarmRule).
 * Abrir a aba nunca cria linha; só o gesto explícito ATIVAR cria.
 *
 * AVANÇADO: o CRUD completo de sempre (presets, thresholds, samples, recovery,
 * velocidades, escopo, fallback manual, severidade, mídia, excluir). Editar uma
 * regra gerenciada aqui preserva o `managedKey` e a marca como PERSONALIZADA.
 */
export function AlarmRulesPanel() {
  const setPanel = useMapStore((state) => state.setPanel);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'BASIC' | 'ADVANCED'>('BASIC');
  const [editing, setEditing] = useState<AlarmRuleDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(() => newDraft());
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const rulesQuery = useQuery({ queryKey: ['alarm-rules'], queryFn: getAlarmRules });
  const rules = rulesQuery.data ?? [];

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['alarm-rules'] });
    void queryClient.invalidateQueries({ queryKey: ['alarms'] });
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const input = draftToRuleInput(draft, editing ?? undefined);
      return editing ? updateAlarmRule(editing.id, input) : createAlarmRule(input);
    },
    onSuccess: () => {
      setEditing(null);
      setCreating(false);
      setDraft(newDraft());
      invalidate();
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setAlarmRuleEnabled(id, enabled),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAlarmRule(id),
    onSuccess: () => {
      setConfirmingDelete(null);
      invalidate();
    },
  });

  /** BÁSICO: cria o slot com o preset recomendado (ação explícita do operador). */
  const enableSlotMutation = useMutation({
    mutationFn: async (slot: BasicAlarmRuleSlot) => {
      const managed = rules.find((rule) => rule.managedKey === slot.managedKey);
      if (managed) return setAlarmRuleEnabled(managed.id, true);
      return createAlarmRule({
        name: slot.defaultName,
        type: slot.type,
        enabled: true,
        severity: slot.severity,
        mapLinkedOnly: true,
        mediaEnabled: false,
        scope: {},
        config: slot.config,
        managedKey: slot.managedKey,
      });
    },
    onSuccess: invalidate,
  });

  /** BÁSICO: liga/desliga um campo sem perder nome/config/scope da regra. */
  const patchRuleMutation = useMutation({
    mutationFn: ({ rule, changes }: { rule: AlarmRuleDto; changes: Partial<AlarmRuleInput> }) =>
      updateAlarmRule(rule.id, { ...ruleInputFromRecord(rule), ...changes }),
    onSuccess: invalidate,
  });

  const startCreate = () => {
    setEditing(null);
    setCreating(true);
    setDraft(newDraft());
  };

  const startEdit = (rule: AlarmRuleDto) => {
    setCreating(false);
    setEditing(rule);
    setDraft(draftFromRule(rule));
  };

  const closeForm = () => {
    setEditing(null);
    setCreating(false);
  };

  const openAdvancedForSlot = (slot: BasicAlarmRuleSlot) => {
    const managed = rules.find((rule) => rule.managedKey === slot.managedKey) ?? null;
    setTab('ADVANCED');
    if (managed) {
      startEdit(managed);
      return;
    }
    // Sem regra ainda: abre o formulário preenchido com o preset, SEM persistir.
    setEditing(null);
    setCreating(true);
    setDraft(draftFromSlot(slot));
  };

  const formOpen = creating || editing !== null;
  const busy = saveMutation.isPending || toggleMutation.isPending || deleteMutation.isPending;

  return (
    <div
      className="panel-overlay"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && setPanel(null)}
    >
      <section
        className="action-panel action-panel--wide"
        role="dialog"
        aria-modal="true"
        aria-label="Regras de alarme"
      >
        <header>
          <div>
            <span>CONFIGURAÇÕES · ALARMES</span>
            <h2>Regras de alarme</h2>
          </div>
          <button type="button" aria-label="Fechar" onClick={() => setPanel(null)}>
            <X size={18} />
          </button>
        </header>

        <div className="alarms-tabs" role="tablist" aria-label="Modo de configuração">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'BASIC'}
            className={tab === 'BASIC' ? 'is-active' : ''}
            onClick={() => setTab('BASIC')}
          >
            BÁSICO
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'ADVANCED'}
            className={tab === 'ADVANCED' ? 'is-active' : ''}
            onClick={() => setTab('ADVANCED')}
          >
            AVANÇADO
          </button>
        </div>

        <div className="panel-body alarms-panel">
          {tab === 'BASIC' ? (
            <AlarmRulesBasicTab
              rules={rules}
              busy={busy || enableSlotMutation.isPending || patchRuleMutation.isPending}
              onEnableSlot={(slot) => enableSlotMutation.mutate(slot)}
              onDisableRule={(rule) => toggleMutation.mutate({ id: rule.id, enabled: false })}
              onToggleMedia={(rule, mediaEnabled) =>
                patchRuleMutation.mutate({ rule, changes: { mediaEnabled } })
              }
              onToggleMapLinked={(rule, mapLinkedOnly) =>
                patchRuleMutation.mutate({ rule, changes: { mapLinkedOnly } })
              }
              onPersonalize={openAdvancedForSlot}
            />
          ) : (
            <>
              <div className="alarms-panel__toolbar">
                <span>
                  {rules.length} regra{rules.length === 1 ? '' : 's'} · alerta sem regra continua visível
                  nas ocorrências recentes
                </span>
                <Button compact variant="primary" onClick={startCreate} disabled={busy}>
                  <Plus size={14} /> NOVA REGRA
                </Button>
              </div>

              {formOpen ? (
                <RuleForm
                  draft={draft}
                  editing={editing}
                  busy={busy}
                  onChange={setDraft}
                  onCancel={closeForm}
                  onSave={() => saveMutation.mutate()}
                />
              ) : null}

              {rules.length === 0 && !formOpen ? (
                <p className="panel-note">
                  Nenhuma regra cadastrada. Use os presets (qualquer CRC, discard sustentado) para
                  começar — sem regra, nenhum alarme métrico é aberto, mas as ocorrências recentes
                  continuam aparecendo no painel.
                </p>
              ) : null}

              <ul className="alarms-panel__list">
                {rules.map((rule) => (
                  <li key={rule.id} className={`alarms-rule ${rule.enabled ? '' : 'is-disabled'}`}>
                    <div className="alarms-rule__head">
                      <span className={`alarms-rule__dot alarms-rule__dot--${rule.severity.toLowerCase()}`} />
                      <strong>{rule.name}</strong>
                      <Badge tone={rule.enabled ? 'info' : 'neutral'}>
                        {rule.enabled ? 'ATIVA' : 'DESATIVADA'}
                      </Badge>
                      <Badge tone="info">{rule.severity}</Badge>
                      {rule.managedKey ? (
                        <Badge tone="info">
                          <ShieldCheck size={12} /> GERENCIADA PELO BÁSICO
                        </Badge>
                      ) : null}
                      {rule.mediaEnabled ? (
                        <Badge tone="info">
                          <BellRing size={12} /> MÍDIA: SIM
                        </Badge>
                      ) : (
                        <Badge tone="neutral">MÍDIA: NÃO</Badge>
                      )}
                    </div>
                    <span className="alarms-rule__type">{alarmTypeLabel(rule.type)}</span>
                    <span className="alarms-rule__config">{describeAlarmRule(rule)}</span>
                    <span className="alarms-rule__scope">
                      {describeAlarmRuleScope(rule.scope, rule.mapLinkedOnly)}
                    </span>
                    <div className="alarms-rule__actions">
                      <Button compact variant="secondary" onClick={() => startEdit(rule)} disabled={busy}>
                        <Pencil size={13} /> EDITAR
                      </Button>
                      <Button
                        compact
                        variant="secondary"
                        disabled={busy}
                        onClick={() => toggleMutation.mutate({ id: rule.id, enabled: !rule.enabled })}
                      >
                        <Power size={13} /> {rule.enabled ? 'DESATIVAR' : 'ATIVAR'}
                      </Button>
                      {confirmingDelete === rule.id ? (
                        <>
                          <Button
                            compact
                            variant="primary"
                            disabled={busy}
                            onClick={() => deleteMutation.mutate(rule.id)}
                          >
                            <Trash2 size={13} /> CONFIRMAR EXCLUSÃO
                          </Button>
                          <Button compact variant="ghost" onClick={() => setConfirmingDelete(null)}>
                            CANCELAR
                          </Button>
                        </>
                      ) : (
                        <Button
                          compact
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setConfirmingDelete(rule.id)}
                        >
                          <Trash2 size={13} /> EXCLUIR
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <footer>
          <Button variant="ghost" onClick={() => setPanel(null)}>
            Fechar
          </Button>
        </footer>
      </section>
    </div>
  );
}

/** Corpo do BÁSICO: proteção nativa + 4 cards gerenciados. */
export function AlarmRulesBasicTab({
  rules,
  busy,
  onEnableSlot,
  onDisableRule,
  onToggleMedia,
  onToggleMapLinked,
  onPersonalize,
}: {
  rules: readonly AlarmRuleDto[];
  busy: boolean;
  onEnableSlot: (slot: BasicAlarmRuleSlot) => void;
  onDisableRule: (rule: AlarmRuleDto) => void;
  onToggleMedia: (rule: AlarmRuleDto, mediaEnabled: boolean) => void;
  onToggleMapLinked: (rule: AlarmRuleDto, mapLinkedOnly: boolean) => void;
  onPersonalize: (slot: BasicAlarmRuleSlot) => void;
}) {
  /**
   * Mídia dos alarmes: canal NETWORK_ALARMS (nunca a mitigação). Sem canal
   * configurado o toggle continua permitido, mas o card avisa.
   */
  const mediaQuery = useQuery({
    queryKey: ['media-integrations', 'NETWORK_ALARMS'],
    queryFn: () => getMediaIntegrationsByPurpose('NETWORK_ALARMS'),
  });
  const mediaChannelReady = Boolean(
    mediaQuery.data?.integration?.enabled && mediaQuery.data.integration.outboundConfigured,
  );

  return (
    <div className="alarms-basic">
      <article className="alarms-basic-card alarms-basic-card--native">
        <header>
          <strong>QUEDA DE INTERFACE</strong>
          <Badge tone="info">
            <ShieldCheck size={12} /> PROTEÇÃO NATIVA
          </Badge>
        </header>
        <p>
          Abre alarme CRITICAL quando uma interface pertencente a um enlace fica DOWN e resolve
          quando volta UP.
        </p>
        <dl className="alarms-basic-card__meta">
          <div>
            <dt>Status</dt>
            <dd>ATIVA</dd>
          </div>
          <div>
            <dt>Escopo</dt>
            <dd>Somente enlaces de mapa</dd>
          </div>
          <div>
            <dt>Mídia</dt>
            <dd>Sem notificação (fluxo nativo)</dd>
          </div>
        </dl>
        <small>Configuração desta proteção será disponibilizada em uma fase futura.</small>
      </article>

      {BASIC_ALARM_RULE_SLOTS.map((slot) => {
        const rule = rules.find((item) => item.managedKey === slot.managedKey) ?? null;
        const recommended = rule ? isRecommendedConfiguration(rule, slot) : false;
        const extraRules = otherEnabledRulesOfType(rules, slot, rule?.id ?? null);
        return (
          <article
            key={slot.managedKey}
            className={`alarms-basic-card ${rule?.enabled ? '' : 'is-off'}`}
          >
            <header>
              <strong>{slot.title}</strong>
              <Badge tone={rule?.enabled ? 'info' : 'neutral'}>
                {rule ? (rule.enabled ? 'ON' : 'OFF') : 'OFF'}
              </Badge>
            </header>
            <p>{slot.description}</p>
            <div className="alarms-basic-card__toggles">
              <button
                type="button"
                className={`alarms-basic-card__toggle ${rule?.enabled ? 'is-on' : ''}`}
                aria-pressed={Boolean(rule?.enabled)}
                disabled={busy}
                onClick={() => (rule?.enabled ? onDisableRule(rule) : onEnableSlot(slot))}
                title={
                  rule?.enabled
                    ? 'Desativar encerra os alarmes atualmente abertos por esta regra.'
                    : 'Criar/ativar a regra recomendada para esta proteção'
                }
              >
                ATIVO {rule?.enabled ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                className={`alarms-basic-card__toggle ${rule?.mediaEnabled ? 'is-on' : ''}`}
                aria-pressed={Boolean(rule?.mediaEnabled)}
                disabled={busy || !rule}
                title="Envia OPENED/ESCALATED/RESOLVED para o canal de alarmes (NETWORK_ALARMS)"
                onClick={() => rule && onToggleMedia(rule, !rule.mediaEnabled)}
              >
                MÍDIA {rule?.mediaEnabled ? 'ON' : 'OFF'}
              </button>
              <button
                type="button"
                className={`alarms-basic-card__toggle ${rule?.mapLinkedOnly ? 'is-on' : ''}`}
                aria-pressed={rule ? rule.mapLinkedOnly : true}
                disabled={busy || !rule}
                title="Somente interfaces associadas a enlaces de mapa"
                onClick={() => rule && onToggleMapLinked(rule, !rule.mapLinkedOnly)}
              >
                SOMENTE ENLACES {rule?.mapLinkedOnly ? 'ON' : 'OFF'}
              </button>
            </div>
            <div className="alarms-basic-card__footer">
              <span>
                CONFIGURAÇÃO:{' '}
                {rule ? (recommended ? 'RECOMENDADA' : 'PERSONALIZADA') : 'DISPONÍVEL'}
              </span>
              <Button
                compact
                variant="secondary"
                onClick={() => onPersonalize(slot)}
                disabled={busy}
              >
                <SlidersHorizontal size={13} /> PERSONALIZAR
              </Button>
            </div>
            {extraRules > 0 ? (
              <small className="alarms-basic-card__hint">
                +{extraRules} regra{extraRules > 1 ? 's' : ''} avançada{extraRules > 1 ? 's' : ''}{' '}
                ativa{extraRules > 1 ? 's' : ''} do mesmo tipo — podem abrir alarmes além deste card.
              </small>
            ) : null}
            {rule?.mediaEnabled && !mediaChannelReady ? (
              <small className="alarms-basic-card__hint">
                Canal de mídia não configurado — os eventos ficam registrados como PULADO até a
                integração de Alarmes de Rede ser configurada em Mídias.
              </small>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

/**
 * Corpo aceito pela API a partir de uma regra existente: preserva nome, tipo,
 * severidade, escopo, config e o `managedKey`; o Básico só troca os campos
 * pedidos (enabled/mediaEnabled/mapLinkedOnly).
 */
export function ruleInputFromRecord(rule: AlarmRuleDto): AlarmRuleInput {
  return {
    name: rule.name,
    type: rule.type,
    enabled: rule.enabled,
    severity: rule.severity,
    mapLinkedOnly: rule.mapLinkedOnly,
    mediaEnabled: rule.mediaEnabled,
    scope: rule.scope,
    config: rule.config,
    managedKey: rule.managedKey,
  };
}

/** Draft do formulário preenchido com o preset do slot (sem persistir nada). */
function draftFromSlot(slot: BasicAlarmRuleSlot): RuleDraft {
  const base = newDraft(slot.type);
  const config = slot.config as unknown as Record<string, number | string | undefined>;
  return {
    ...base,
    name: slot.defaultName,
    severity: slot.severity,
    direction: (config.direction as 'RX' | 'TX' | 'BOTH' | undefined) ?? base.direction,
    thresholdPerMinute: Number(config.thresholdPerMinute ?? base.thresholdPerMinute),
    recoveryThresholdPerMinute: Number(
      config.recoveryThresholdPerMinute ?? base.recoveryThresholdPerMinute,
    ),
    triggerSamples: Number(config.triggerSamples ?? base.triggerSamples),
    recoverySamples: Number(config.recoverySamples ?? base.recoverySamples),
    optical: slot.type === 'OPTICAL_RX_DEGRADATION'
      ? { ...opticalRuleDefaults(), ...(slot.config as OpticalRuleConfig) }
      : base.optical,
  };
}

function RuleForm({
  draft,
  editing,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: RuleDraft;
  editing: AlarmRuleDto | null;
  busy: boolean;
  onChange: (draft: RuleDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const optical = draft.type === 'OPTICAL_RX_DEGRADATION';
  const presets = presetsForType(draft.type);
  const patch = (values: Partial<RuleDraft>) => onChange({ ...draft, ...values });
  const patchOptical = (values: Partial<OpticalRuleConfig>) =>
    onChange({ ...draft, optical: { ...draft.optical, ...values } });

  return (
    <div className="alarms-form">
      <h3>{editing ? `EDITAR · ${editing.name}` : 'NOVA REGRA'}</h3>
      {editing?.managedKey ? (
        <p className="alarms-form__note">
          <small>
            Regra GERENCIADA PELO BÁSICO. Alterar qualquer parâmetro técnico aqui marca o card
            como PERSONALIZADA — o vínculo com o Básico é mantido.
          </small>
        </p>
      ) : null}
      <div className="alarms-form__grid">
        <label>
          <span>NOME</span>
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
            placeholder="CRC backbone"
          />
        </label>
        <label>
          <span>TIPO</span>
          <select
            value={draft.type}
            onChange={(event) => patch({ type: event.target.value as MetricAlarmType })}
          >
            {RULE_TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>SEVERIDADE MÍNIMA</span>
          <select
            value={draft.severity}
            onChange={(event) => patch({ severity: event.target.value as AlarmSeverity })}
          >
            {SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {severity}
              </option>
            ))}
          </select>
        </label>
        <label className="alarms-form__toggle">
          <span>ENVIAR PARA MÍDIA</span>
          <button
            type="button"
            className={draft.mediaEnabled ? 'is-on' : ''}
            aria-pressed={draft.mediaEnabled}
            onClick={() => patch({ mediaEnabled: !draft.mediaEnabled })}
          >
            {draft.mediaEnabled ? 'ON' : 'OFF'}
          </button>
        </label>
      </div>

      {presets.length ? (
        <div className="alarms-form__presets">
          <span>PRESETS</span>
          {presets.map((preset) => (
            <Button
              key={preset.id}
              compact
              variant="secondary"
              onClick={() => onChange(applyPreset({ ...draft, name: draft.name || preset.label }, preset))}
              title={preset.summary}
            >
              {preset.label}
            </Button>
          ))}
        </div>
      ) : null}

      {optical ? (
        <>
          <h3>DEGRADAÇÃO ÓPTICA</h3>
          <div className="alarms-form__note">
            <strong>Threshold: limites do equipamento/transceiver (DEVICE/USER/DEFAULT).</strong>
            <small>
              LOW/HIGH vêm do módulo (SNMP .13-.16 ou CLI). O cadastro manual abaixo é só fallback
              quando o equipamento não informa nada.
            </small>
          </div>
          <div className="alarms-form__grid">
            <label>
              <span>WARNING (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={draft.optical.warningProximityPercent}
                onChange={(event) => patchOptical({ warningProximityPercent: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>MAJOR (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={draft.optical.majorProximityPercent}
                onChange={(event) => patchOptical({ majorProximityPercent: Number(event.target.value) })}
              />
            </label>
            <label className="alarms-form__toggle">
              <span>CRITICAL NO LOW</span>
              <button
                type="button"
                className={draft.optical.criticalAtLowAlarm ? 'is-on' : ''}
                aria-pressed={draft.optical.criticalAtLowAlarm}
                onClick={() => patchOptical({ criticalAtLowAlarm: !draft.optical.criticalAtLowAlarm })}
              >
                {draft.optical.criticalAtLowAlarm ? 'ON' : 'OFF'}
              </button>
            </label>
            <label>
              <span>RECOVERY (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={draft.optical.recoveryProximityPercent}
                onChange={(event) => patchOptical({ recoveryProximityPercent: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>AMOSTRAS WARNING</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.optical.warningTriggerSamples}
                onChange={(event) => patchOptical({ warningTriggerSamples: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>AMOSTRAS MAJOR</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.optical.majorTriggerSamples}
                onChange={(event) => patchOptical({ majorTriggerSamples: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>RECOVERY (amostras)</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.optical.recoverySamples}
                onChange={(event) => patchOptical({ recoverySamples: Number(event.target.value) })}
              />
            </label>
          </div>
          <h3>VARIAÇÃO RÁPIDA</h3>
          <div className="alarms-form__grid">
            <label>
              <span>QUEDA WARNING (dB)</span>
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={draft.optical.trendDropDb}
                onChange={(event) => patchOptical({ trendDropDb: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>QUEDA MAJOR (dB)</span>
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={draft.optical.trendMajorDropDb}
                onChange={(event) => patchOptical({ trendMajorDropDb: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>JANELA (min)</span>
              <input
                type="number"
                min={5}
                max={1440}
                value={draft.optical.trendWindowMinutes}
                onChange={(event) => patchOptical({ trendWindowMinutes: Number(event.target.value) })}
              />
            </label>
          </div>
          <h3>FALLBACK MANUAL (opcional)</h3>
          <div className="alarms-form__grid">
            <label>
              <span>LOW MANUAL (dBm)</span>
              <input
                type="number"
                step={0.01}
                value={draft.optical.manualRxLowAlarmDbm ?? ''}
                onChange={(event) =>
                  patchOptical({
                    manualRxLowAlarmDbm: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>HIGH MANUAL (dBm)</span>
              <input
                type="number"
                step={0.01}
                value={draft.optical.manualRxHighAlarmDbm ?? ''}
                onChange={(event) =>
                  patchOptical({
                    manualRxHighAlarmDbm: event.target.value === '' ? null : Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
        </>
      ) : (
        <>
          <h3>LIMITE</h3>
          <div className="alarms-form__grid">
            {draft.type !== 'INTERFACE_CRC' ? (
              <label>
                <span>DIREÇÃO</span>
                <select
                  value={draft.direction}
                  onChange={(event) =>
                    patch({ direction: event.target.value as 'RX' | 'TX' | 'BOTH' })
                  }
                >
                  <option value="RX">RX</option>
                  <option value="TX">TX</option>
                  <option value="BOTH">RX/TX</option>
                </select>
              </label>
            ) : null}
            <label>
              <span>THRESHOLD (/min) — 0 = QUALQUER</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={draft.thresholdPerMinute}
                onChange={(event) => patch({ thresholdPerMinute: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>AMOSTRAS</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.triggerSamples}
                onChange={(event) => patch({ triggerSamples: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>RECOVERY (/min)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={draft.recoveryThresholdPerMinute}
                onChange={(event) => patch({ recoveryThresholdPerMinute: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>RECOVERY (amostras)</span>
              <input
                type="number"
                min={1}
                max={10}
                value={draft.recoverySamples}
                onChange={(event) => patch({ recoverySamples: Number(event.target.value) })}
              />
            </label>
          </div>
        </>
      )}

      <h3>ESCOPO</h3>
      <div className="alarms-form__speeds">
        <span>VELOCIDADES</span>
        {RULE_SPEED_OPTIONS.map((option) => {
          const active = draft.speedsBps.includes(option.bps);
          return (
            <button
              key={option.bps}
              type="button"
              className={active ? 'is-active' : ''}
              aria-pressed={active}
              onClick={() =>
                patch({
                  speedsBps: active
                    ? draft.speedsBps.filter((value) => value !== option.bps)
                    : [...draft.speedsBps, option.bps],
                })
              }
            >
              {option.label}
            </button>
          );
        })}
        <label className="alarms-form__toggle">
          <span>SOMENTE EM ENLACES</span>
          <button
            type="button"
            className={draft.mapLinkedOnly ? 'is-on' : ''}
            aria-pressed={draft.mapLinkedOnly}
            onClick={() => patch({ mapLinkedOnly: !draft.mapLinkedOnly })}
          >
            {draft.mapLinkedOnly ? 'ON' : 'OFF'}
          </button>
        </label>
      </div>
      {editing?.scope.devices?.length || editing?.scope.interfaces?.length ? (
        <p className="alarms-form__note">
          <small>
            Escopo por equipamento/interface desta regra é preservado ao salvar
            {editing?.scope.devices?.length ? ` · ${editing.scope.devices.length} equipamento(s)` : ''}
            {editing?.scope.interfaces?.length ? ` · ${editing.scope.interfaces.length} interface(s)` : ''}
            .
          </small>
        </p>
      ) : null}

      <div className="alarms-form__actions">
        <Button variant="primary" onClick={onSave} disabled={busy || !draft.name.trim()}>
          SALVAR
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          CANCELAR
        </Button>
      </div>
    </div>
  );
}
