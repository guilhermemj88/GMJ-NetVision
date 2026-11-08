/**
 * AUTO-ALL (embedded FAST ENFORCE) wiring decisions, kept pure so the production
 * wiring in routes.ts and the isolated tests evaluate exactly the same rules.
 *
 * Under AUTO-ALL there is ONE collection path (the embedded FAST poller + lease) and ONE
 * decision path (the canonical engine) for HOLD **and** for physical execution. Physical
 * writes still go exclusively through AutoMitigationLifecycle.activate(), so the lifecycle
 * gates (kill switch, allowlist, readiness, ownership, capacity, physical readback,
 * journal/outbox) apply unchanged. The external bridge / external pilot path is used only
 * when AUTO-ALL is NOT enabled (reviewed single-pilot topology).
 */
export type TelemetrySource = 'EMBEDDED_FAST' | 'EXTERNAL_BRIDGE' | 'EFFECTIVE_ROUTING';

export interface AutoAllWiringInput {
  autoAllEnforce: boolean;
  lifecycleEnabled: boolean;
}

/** The lifecycle-driven external pilot runtime is never used with the embedded AUTO-ALL FAST. */
export function usesExternalPilotRuntime(input: AutoAllWiringInput): boolean {
  return input.lifecycleEnabled && !input.autoAllEnforce;
}

/** Source of the telemetry that re-validates the evidence immediately before a physical write. */
export function physicalEvidenceSource(input: AutoAllWiringInput): TelemetrySource {
  if (input.autoAllEnforce) return 'EMBEDDED_FAST';
  return input.lifecycleEnabled ? 'EXTERNAL_BRIDGE' : 'EFFECTIVE_ROUTING';
}

/**
 * The legacy exemption bypasses the engine-level execution allowlist. AUTO-ALL has a single
 * authority for physical scope (the explicit allowlist, enforced again by the lifecycle), so
 * no profile is exempt.
 */
export function engineLegacyExemptProfileIds(
  input: AutoAllWiringInput,
  configured: readonly string[],
): readonly string[] {
  return input.autoAllEnforce ? [] : configured;
}
