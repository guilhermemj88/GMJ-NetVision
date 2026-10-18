# DDoS Fast Response — release candidate and observation rollout

Branch: `feature/ddos-fast-response`. Base: production API commit `fc790ade3455f2c16eeff372a8a9168deffb0d7d`.
Release tag: `v2026.10.17-ddos-fast-observer-rc1`. The deployed `release.json` identifies the exact code commit and bundle hash.

## Scope and architecture

Two artifacts are intentionally distinct:

1. **API candidate**, not deployed: fixes atomic telemetry and temporal continuity, integrates the priority stream with the existing `MitigationAutoEngine`, canonical `MitigationCommandService`, preflight, policy lock and verified readback. Its feature flag defaults OFF.
2. **Standalone OBSERVE service**: deployable without restarting or replacing the API. It imports the same fast collector, but imports no AUTO engine, command service, SSH client or Huawei executor. It rejects every mode other than OBSERVE at startup.

Operational flow:

```text
Operational PostgreSQL (read-only role, four inventory/config tables)
  -> explicit profile/device selection + vault decryption of SNMP credential
  -> targeted SNMP GET on NE8000 (HC counters, identity, admin/oper state, continuity)
  -> independent bounded scheduler / rate validation
  -> dedicated netvision_fast_observe PostgreSQL database
  -> 127.0.0.1:3355/health and /metrics, structured journal summaries
```

Future API flow, requiring a separate authorization and API rollout:

```text
Priority observations -> atomic PriorityTrafficSource -> existing AUTO engine
  -> existing profile/provenance/device/policy/peer/global-mode/executor/live-write gates
  -> existing canonical command service / policy lock
  -> preflight -> recent continuous UP telemetry recheck -> execution -> verifyActivation
```

The standalone observer database is deliberately **not** the actuator's telemetry source. Its store does not lock operational inventory rows. An enforce deployment uses `PrismaFastTrafficStore` and its transactional mapping lock instead.

## Corrections and sampling contract

- Interface and runtime sources fetch value and identity in one snapshot, eliminating the two-query race.
- Legacy reader returns the newest row including invalid quality. It never substitutes an older high rate for an invalid newest row.
- Observations carry unique ID, equipment/interface identity, validated ifIndex/ifName, raw unsigned counters, request start/end, reference timestamp, real interval, capacity, uptime, discontinuity and state.
- Unsigned Counter64 uses Decimal(20,0) storage, not signed PostgreSQL BIGINT. Wrap/decrease establishes a baseline; it never confirms an attack.
- Maximum confirmation age and gap: **45 seconds**. Missing/invalid/stale/future observations reset the sequence. A SNMP error is not zero traffic.
- Restart discards unproven persisted confirmation counts while retaining the consumed timestamp to prevent recounting. A new collector epoch after restart/discontinuity/error separates sequences.
- Same or older timestamps cannot increment or regress persisted identity. A fresh timestamp and stable continuity key are required.
- Threshold comparison is inclusive (`>=`), as required. The operational threshold and **triggerSamples=3** are unchanged.
- Contract determines mitigation threshold; hardware/aggregate capacity determines plausibility. A 156 Gbps observation is permitted on a 300 Gbps aggregate despite a 10 Gbps contract.
- Admin DOWN, oper DOWN and windows covering a state change do not confirm an attack. Return to UP requires a new baseline/continuous interval. No interface activation exists in this pipeline.
- Failed execution is subject to a 30-second scope cooldown and a new observation. Request IDs include observation identity. Physical preflight and existing reconciliation rules remain authoritative; no automatic REMOVE was added.

## Scheduler, scope and load

Defaults: normal observation every **20 seconds**, suspicion every **10 seconds**, GET timeout **1500 ms**, **0 retries**, global collection concurrency **2**. The observation canary limits concurrency to **1** for one device/two BHNET interfaces and explicitly uses **10 seconds even in NORMAL**, so the target cadence can be measured without an attack.

There is one in-flight batch per device. A batch contains at most four interfaces and `1 + 8 × interfaces` varbinds. The BHNET canary uses **one GET / 17 OIDs / 10 seconds**. No walks, discovery, optical, MPLS, PPP, BGP or SSH are executed on this path. The independent scheduler is necessary because the current global sweep awaits all those slow tasks sequentially.

The priority baseline and table are separate from conventional polling. Slow-poller persistence cannot change fast counter deltas. Commits are monotonic and deduplicated. Inventory identity is checked on every GET and, for the enforce store, locked during persistence and checked on read.

Selection requires explicit profile IDs, device allowlist, enabled AUTO IPv4 and a configured direction. It does not promote profiles, configure directions or bypass sweep execution controls. BHNET-3043 remains manual/legacy AUTO; 3044 remains sweep AUTO. IPv6/ALERT_ONLY and the 32 unconfigured profiles are excluded.

## Instrumentation and frontend

`GET /api/bgp/mitigation/fast-poller` is prepared in the API candidate with collection health, age, interval p50/p95/max (last 360 intervals), next measurement, raw quality counts, RX/TX, contract percentage, per-profile phase, confirmation progress, reasons, bounded transition history and response-budget violations.

Canonical activation results expose preflight/execution/readback timings. AUTO decisions include first abnormal timestamp, confirmation time, command duration, total response time and explicit 60-second violations. In-flight deadlines remain visible.

The standalone service exposes JSON diagnostics only on **127.0.0.1:3355**. `executionAvailable=false` and `observationOnly=true` are explicit. Normal repeated decisions are aggregated; sample progression and significant transitions are visible. Retention is seven days, pruned in bounded batches in the observation database only.

No frontend changes are deployed. The current BGP tabs and WeatherMap V2 are preserved. Visual integration of the new API is a later step.

## Isolated validation

All SNMP/Huawei traffic used by tests is synthetic. Real-clock validation sends actual SNMPv2c UDP packets to a GET-only fixture on **127.0.0.1**; no operational credentials or equipment are used.

| Controlled scenario                       | First abnormal observation to verified synthetic readback |
| ----------------------------------------- | --------------------------------------------------------: |
| Real clock + real loopback UDP            |                   **33,909 ms** (previous run: 33,833 ms) |
| Virtual clock, one profile                |                                             **33,850 ms** |
| Virtual clock, four simultaneous profiles |                  p50 **33,850 ms**, p95/max **42,525 ms** |

Real-clock confirmation intervals were **10,224 / 10,229 / 10,230 ms**. Synthetic command stages were approximately 3 seconds preflight, 4 seconds execution and 2 seconds readback. These are **not measurements of Huawei execution latency**.

The 18-host / 2,379-interface benchmark executes the real global scheduler with slow synthetic jobs concurrently with the real fast scheduler, source, engine and command/verification code. It materializes 32 unconfigured profiles and proves their exclusion. Sample interval p50 was 10 seconds, p95/max 20 seconds; simulated GET latency p50 175 ms, p95/max 900 ms for four protected profiles. CPU/heap in the JSON reports describe the local synthetic test process only.

Historical BHNET replay uses the real timestamps and rates and invents no intermediate data. Its long windows and DOWN state do not satisfy the corrected trigger. Separate ten-second hypothetical scenarios cover sustained attack, brief spike, normal return, timeout, DOWN and frozen counters. Additional tests cover late/duplicate UDP responses, retry, full unsigned Counter64, reset/wrap, remapping/removal, simultaneous cycles, PostgreSQL concurrent commits, stale gaps, restart, manual/sweep AUTO, policy scope, preflight/readback failure and explicit deadline violation.

The observer startup/stop/restart test uses a read-only source connection and separate local observation database, confirms collection stops and resumes, and verifies no mitigation event or profile change.

Reproducible commands (run inside this worktree):

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w @gmj/api
npm run typecheck -w @gmj/api
npm run typecheck -w @gmj/shared
npm run typecheck -w @gmj/web
# Disposable PostgreSQL only: 127.0.0.1:55439/netvision_ddos_fast_test
$env:FAST_TEST_DATABASE_URL='postgresql://fast_test:isolated_test_only@127.0.0.1:55439/netvision_ddos_fast_test?schema=public'
cd apps/api
npx vitest run --maxWorkers=2
$env:FAST_REALTIME_TEST='1'
npx vitest run src/worker/mitigation/mitigation-fast-realtime.test.ts --maxWorkers=1
```

The PostgreSQL tests reject remote or operational database URLs. The optional real-clock test is intentionally skipped by the ordinary suite and was run separately. Full API suite: **1,835 passed, zero failures**, plus the separately passed real-clock test. Shared/web type checks and API build passed. Frontend tests expose pre-existing snapshot/BGP test failures reproduced from the untouched base; this is not a green frontend release and no frontend rollout is included.

## Migration and operational isolation

`20261018020000_mitigation_priority_traffic/migration.sql` is additive. It creates the priority observation table and two indexes, with no modifications to existing profiles, runtime, thresholds or BGP data. It was applied and concurrency-tested on disposable PostgreSQL.

For the authorized observation deployment, apply **only this table definition to a NEW `netvision_fast_observe` database**, not the operational database. The operational `netvision` schema and `_prisma_migrations` are unchanged. A dedicated role gets SELECT only on `Device`, `Interface`, `SnmpCredential`, `BgpMitigationProfile`; its operational database connection defaults to read-only transactions. The role owns only the new observation database. Credentials are provisioned remotely without logs in `/etc/netvision-fast-observer.env` with root-only access.

The systemd service uses DynamicUser, no new privileges, read-only filesystem, private temp, memory/CPU bounds, and network allowlisting for loopback and the NE8000. It has no write path to the operational tables or routers.

## Activation and rollback runbook

1. Verify release commit/hash, standalone bundle's absence of engine/SSH/executor imports, successful isolated tests and free disk space.
2. Stage a new dedicated release under `/opt/netvision-fast-observer/releases/rc-<commit>`. Build with Linux Prisma binaries and copy runtime dependencies into the release. Existing production build tools are read only.
3. Create observation database/role; grant only the documented source SELECT permissions; set source database transaction default to read-only. Apply the additive observation table to the observation database only.
4. Provision `deploy/fast-observer.env.example` with exactly BHNET-3043 and 3044, OBSERVE, one device, one concurrent request, zero retries. Check source has no write privileges.
5. Install `deploy/netvision-fast-observer.service`; select the release through `/opt/netvision-fast-observer/current`; start/enable **only** this service. No API/Web restart or ENV change.
6. Check `curl -fsS http://127.0.0.1:3355/health` and `/metrics`, journal transitions, database timestamps and monotonic counters. Observe at least five minutes; compare CPU/BGP snapshots and conventional samples.
7. Test rollback: stop **only** `netvision-fast-observer`, confirm request/row counts stop, and confirm API PID/health remain unchanged. Restore by starting the same service and verifying the new baseline/collection epoch. No router action is part of rollback.

Emergency rollback:

```sh
sudo systemctl disable --now netvision-fast-observer.service
sudo systemctl is-active netvision-api.service
```

Leave observation data and the additive schema intact for review. A prior observer release may be selected through the current symlink with this service stopped. Never remove existing mitigations as software rollback. Credential/database teardown is a separate maintenance action.

## Acceptance for observation and future enforcement

Observation GO requires: standalone isolation tests, source read-only permissions, reversible service stop/start, fresh real GETs, stable counter identity, no operational profile/event changes, and no material CPU/BGP regression.

Automatic execution remains **NO-GO** until separately authorized. Pending work includes supervised read-only production observation under UP traffic, actual device latency/capacity characterization, frontend test remediation/integration, review of shared-policy behavior, explicit minimal profile approval, operational API migration/build rollout (including separately authorized restart), and supervised preflight/readback testing. Do not enable AUTO-ALL or change triggerSamples/thresholds to meet the latency target.

The BHNET subinterfaces were administratively DOWN before rollout; observing DOWN does not validate live UP-rate derivation on those links or establish restored connectivity. No interface state change is authorized.
