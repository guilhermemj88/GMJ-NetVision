"""Pos-restart da API (READ-ONLY). No IMPLANTAR, como root:
    python3 - <since-utc> < api-logs-contract-check.py
Le o journal desde o restart e confere o contrato `prefixes` no bundle ativo.
Nao chama endpoints de comando, nao dispara ACTIVATE/REMOVE/Telegram.
"""
import json
import os
import re
import subprocess
import sys

since = sys.argv[1]
pid = subprocess.check_output(["systemctl", "show", "netvision-api", "-p", "MainPID", "--value"], text=True).strip()
bundle = os.path.join(os.readlink(f"/proc/{pid}/cwd"), "dist/server.cjs")
log = subprocess.run(["journalctl", "-u", "netvision-api", "--since", since, "-o", "cat", "--no-pager"],
                     capture_output=True, text=True).stdout.splitlines()
mcp = subprocess.run(["journalctl", "-u", "netvision-mcp", "--since", since, "-o", "cat", "--no-pager"],
                     capture_output=True, text=True).stdout.splitlines()
KNOWN = re.compile(r"physicalTemplatePort|templateId.*side.*sortOrder|CATALOG_BOOTSTRAP")
errors = [line for line in log if re.search(r'"level":(50|60)', line)]
src = open(bundle, encoding="utf-8").read()
print(json.dumps({
    "readOnly": True,
    "since": since,
    "bundle": bundle,
    "apiLogLines": len(log),
    "apiErrorLines": len(errors),
    "apiErrorLinesKnownCatalogBootstrap": sum(1 for line in errors if KNOWN.search(line)),
    "apiErrorLinesUnexpected": [line[:240] for line in errors if not KNOWN.search(line)][:10],
    "fatalOrUnhandled": sum(1 for line in log if re.search(r"unhandled|uncaught|FATAL|Prisma Client could not", line, re.I)),
    "mitigationCommandLines": sum(1 for line in log if re.search(r"ACTIVATE|REMOVE|mitigation-command", line)),
    "mcpErrorLines": sum(1 for line in mcp if re.search(r'"level":(50|60)|Error', line)),
    "contract": {
        "receivedRoutesCommand": "routing-table peer ${" in src and " received`" in src,
        "scopeSelector": "selectMitigationScopePrefixes" in src,
        "scopeLocalAsPort": "scopePrefixesLocalAs" in src,
        "fieldsUnavailable": "fieldsUnavailable" in src,
    },
}))
