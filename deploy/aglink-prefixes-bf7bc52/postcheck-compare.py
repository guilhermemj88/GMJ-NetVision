"""Compara dois retratos READ-ONLY (readonly-state.py) antes/depois da troca da API.

Uso: python -I postcheck-compare.py antes.json depois.json [--expect api=bf7bc52|api=4637696]
Falha (exit 1) se qualquer invariante quebrar. Nao fala com servidor nenhum.
"""

import json
import sys

RELEASES = {
    "bf7bc52": ("bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59",
                "09b12192d7ff1ba5ad625b823b2d4d8d1d4caacf8d906d4ca6819ddfaa0df634"),
    "4637696": ("463769620a2f39f9803b60a43314851fe3a77e0e",
                "5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d"),
}
UNCHANGED_SERVICES = ("netvision-web", "netvision-fast-observer")


def main(argv: list[str]) -> int:
    before = json.load(open(argv[1], encoding="utf-8"))
    after = json.load(open(argv[2], encoding="utf-8"))
    expect = argv[3].split("=", 1)[1] if len(argv) > 3 else "bf7bc52"
    sha, bundle = RELEASES[expect]
    checks: list[tuple[str, bool]] = []
    api_b, api_a = before["services"]["netvision-api"], after["services"]["netvision-api"]

    checks.append(("API release", api_a["releaseSourceSha"] == sha))
    checks.append(("API bundle sha256", api_a["artifacts"]["dist/server.cjs"] == bundle))
    checks.append(("API flags identicas", api_a["flags"] == api_b["flags"]))
    checks.append(("AUTO execution/lifecycle/remove = 0",
                   all(api_a["flags"].get(k) == "0" for k in (
                       "MITIGATION_AUTO_EXECUTION_ENABLED", "MITIGATION_AUTO_LIFECYCLE_ENABLED",
                       "MITIGATION_AUTO_REMOVE_ENABLED"))))
    checks.append(("persistencia = 1", api_a["flags"].get("MITIGATION_AUTO_PERSISTENCE_ENABLED") == "1"))
    checks.append(("allowlist AUTO vazia", api_a["flags"].get("MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS") == ""))
    checks.append(("EnvironmentFiles identicas", api_a["environmentFiles"] == api_b["environmentFiles"]))
    for name in ("netvision-api", "netvision-mcp"):
        svc = after["services"][name]
        checks.append((f"{name} active/NRestarts=0", svc["active"] == "active" and svc["nRestarts"] == "0"))
    for name in UNCHANGED_SERVICES:
        b, a = before["services"][name], after["services"][name]
        checks.append((f"{name} PID/cwd inalterados", (b["pid"], b["cwd"]) == (a["pid"], a["cwd"])))
    checks.append(("MCP release inalterada", before["services"]["netvision-mcp"]["cwd"] == after["services"]["netvision-mcp"]["cwd"]))
    for name in ("api", "web", "mcp"):
        checks.append((f"health {name} 200", after["health"][name].get("status") == 200))
    checks.append(("API demoMode=false", '"demoMode":false' in (after["health"]["api"].get("body") or "")))
    db_b, db_a = before["db"], after["db"]
    checks.append(("migrations inalteradas", (db_b["migrations"], db_b["lastMigration"]) == (db_a["migrations"], db_a["lastMigration"])))
    checks.append(("migrations pendentes = 0", db_a["migrationsUnfinished"] == 0))
    checks.append(("perfis = 39 e AGLINK igual", db_a["profiles"] == db_b["profiles"] and db_a["aglink"] == db_b["aglink"]))

    bad = [name for name, ok in checks if not ok]
    for name, ok in checks:
        print(("PASS " if ok else "FAIL ") + name)
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
