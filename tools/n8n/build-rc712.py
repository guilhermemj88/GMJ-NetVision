"""Gera o workflow n8n RC7.1.2 (somente apresentacao de prefixos) a partir do RC7.1.

RC7.1.2 = RC7.1 + UMA alteracao: o no `Normalizar Evento OUT` passa a renderizar
os prefixos reais do escopo verificado na mensagem de mitigacao verificada.
Nenhum no, conexao, credencial, webhook ou ramo e adicionado/removido.

Uso: python tools/n8n/build-rc712.py
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parents[2] / "docs" / "n8n"
SRC = DOCS / "GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json"
DST = DOCS / "GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json"
NODE = "Normalizar Evento OUT"

ANCHOR = "  if (b.peer)\n    lines.push(`<b>Peer principal:</b> ${esc(b.peer)}`);\n"

BLOCK = """
  // ==========================================================
  // ESCOPO VERIFICADO - prefixos REAIS da mitigacao (campo aditivo)
  // Sem lista => "indisponivel". Nunca inferir de profile/policy.
  // ==========================================================
  const scopePrefixes = Array.isArray(b.prefixes)
    ? b.prefixes.filter((p) => typeof p === 'string' && p.length > 0)
    : [];

  lines.push('');

  if (scopePrefixes.length > 0) {
    lines.push(`<b>Prefixos (${scopePrefixes.length}):</b>`);
    for (const item of scopePrefixes) lines.push(`\\u2022 ${esc(item)}`);
  } else {
    lines.push('<b>Prefixos:</b> <i>indispon\\u00edvel</i>');
  }
"""

OUTPUT_ANCHOR = "    RT: b.rt ?? null,\n"
OUTPUT_ADD = (
    "    RT: b.rt ?? null,\n"
    "    PREFIXOS: scopePrefixes,\n"
    "    QTD_PREFIXOS: scopePrefixes.length,\n"
)


def main() -> int:
    source = json.loads(SRC.read_text(encoding="utf-8"))
    target = copy.deepcopy(source)
    target["name"] = "GMJ NetVision - Telegram RC7.1.2 (prefixos do escopo verificado)"

    node = next((item for item in target["nodes"] if item["name"] == NODE), None)
    if node is None:
        print(f"ERRO: no {NODE} ausente", file=sys.stderr)
        return 1

    code = node["parameters"]["jsonOutput"]
    if ANCHOR not in code:
        print("ERRO: ancora do corpo da mensagem nao encontrada", file=sys.stderr)
        return 1
    if OUTPUT_ANCHOR not in code:
        print("ERRO: ancora de saida nao encontrada", file=sys.stderr)
        return 1

    code = code.replace(ANCHOR, ANCHOR + BLOCK, 1)
    code = code.replace(OUTPUT_ANCHOR, OUTPUT_ADD, 1)
    node["parameters"]["jsonOutput"] = code

    DST.write_text(
        json.dumps(target, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    # Verificacao estrutural: nada alem do normalizador pode ter mudado.
    check = json.loads(DST.read_text(encoding="utf-8"))
    if check["connections"] != source["connections"]:
        print("ERRO: conexoes mudaram", file=sys.stderr)
        return 1
    by_name = {item["name"]: item for item in source["nodes"]}
    if len(check["nodes"]) != len(source["nodes"]):
        print("ERRO: quantidade de nos mudou", file=sys.stderr)
        return 1
    for item in check["nodes"]:
        if item["name"] == NODE:
            continue
        if item.get("parameters") != by_name[item["name"]].get("parameters"):
            print(f"ERRO: no alterado fora do normalizador: {item['name']}", file=sys.stderr)
            return 1

    print(f"OK: {DST.name} ({len(check['nodes'])} nos, apenas {NODE} alterado)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
