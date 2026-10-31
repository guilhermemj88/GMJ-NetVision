"""Gera o candidato n8n "RC7.1.2 + prefixos" a partir da versao EFETIVAMENTE publicada.

Base: o activeVersion do workflow SVh8Z-zUcSzQYOOJZ-DKP publicado no IMPLANTAR
(versionId 6a97fe4a-31ea-49e6-b892-1ac55f85d115, 58 nos / 59 arestas), lido de um
snapshot somente leitura que NAO e versionado (fica fora do repositorio).

Candidato = publicado + UMA alteracao: o no `Normalizar Evento OUT` passa a
renderizar os prefixos reais do escopo verificado na mensagem de mitigacao
verificada. Nenhum no, conexao, credencial, webhook, id, posicao ou ramo muda.

O gerador falha se a base nao for exatamente a publicada (id, activeVersionId,
contagens e hash do grafo medido ao vivo) ou se qualquer coisa alem de
`parameters.jsonOutput` do normalizador divergir.

Base efetiva: o RASCUNHO 1f1405f8 (salvo apos a publicacao), que difere do
publicado apenas na posicao de dois nos; o gerador recusa qualquer outra diferenca.

Uso: python -I tools/n8n/build-rc712.py <snapshot-do-editor.json>
"""

from __future__ import annotations

import copy
import difflib
import hashlib
import json
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parents[2] / "docs" / "n8n"
DST = DOCS / "GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json"
DIFF = DOCS / "RC7.1.2-PREFIXOS-NORMALIZER.diff"
MANIFEST = DOCS / "RC7.1.2-PREFIXOS-MANIFEST.json"
NODE = "Normalizar Evento OUT"

WORKFLOW_ID = "SVh8Z-zUcSzQYOOJZ-DKP"
ACTIVE_VERSION_ID = "6a97fe4a-31ea-49e6-b892-1ac55f85d115"
NODES = 58
EDGES = 59
# Hash do grafo publicado medido ao vivo (29/10 e 30/10) por leitura do
# workflow_history: sha256(json.dumps({nodes, connections}, sort_keys=True)).
GRAPH_SHA256 = "60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870"
# Rascunho salvo DEPOIS da publicacao (29/10 15:24), ainda nao publicado: so move
# dois nos no canvas. A base do candidato e esse rascunho, para que o PATCH nao
# apague a edicao mais recente do operador.
DRAFT_VERSION_ID = "1f1405f8-e9bc-4d2e-91bc-4106dbb07285"
DRAFT_GRAPH_SHA256 = "6bc74d79b499c68ac20c1fd273f75bd17bec3eae51694de29ac5d2b560bf9d23"
DRAFT_MOVED_NODES = {"Somente Status Mitigacao RC712?", "Telegram - Status Mitigacao RC712"}

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

# Campos de topo copiados do publicado: so o que o import/PATCH precisa.
# Ficam de fora estado de runtime e de compartilhamento (shared, scopes,
# activeVersion, staticData, checksum, versionId, contadores, datas).
TOP_LEVEL = ("id", "name", "nodes", "connections", "settings", "meta", "tags")


def graph_sha256(nodes: list, connections: dict) -> str:
    raw = json.dumps({"nodes": nodes, "connections": connections}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def edges(connections: dict) -> int:
    return sum(len(t) for v in connections.values() for outs in v.values() for t in outs)


def fail(message: str) -> int:
    print(f"ERRO: {message}", file=sys.stderr)
    return 1


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        return fail("uso: build-rc712.py <snapshot-publicado.json>")
    snapshot = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    snapshot = snapshot.get("data", snapshot)

    published = snapshot.get("activeVersion") or {}
    if snapshot.get("id") != WORKFLOW_ID:
        return fail(f"workflow inesperado: {snapshot.get('id')}")
    if snapshot.get("activeVersionId") != ACTIVE_VERSION_ID:
        return fail(f"activeVersionId inesperado: {snapshot.get('activeVersionId')}")
    if published.get("versionId") != ACTIVE_VERSION_ID:
        return fail("activeVersion do snapshot nao e a versao publicada")
    base_nodes, base_conn = published["nodes"], published["connections"]
    if len(base_nodes) != NODES or edges(base_conn) != EDGES:
        return fail(f"contagem inesperada: {len(base_nodes)} nos / {edges(base_conn)} arestas")
    if graph_sha256(base_nodes, base_conn) != GRAPH_SHA256:
        return fail("hash do grafo publicado diverge do medido ao vivo")

    # Rascunho: precisa ser o 1f1405f8 e diferir do publicado SOMENTE na posicao
    # dos dois nos movidos. Qualquer outra diferenca exige reconciliacao manual.
    if snapshot.get("versionId") != DRAFT_VERSION_ID:
        return fail(f"rascunho inesperado: {snapshot.get('versionId')}")
    if graph_sha256(snapshot["nodes"], snapshot["connections"]) != DRAFT_GRAPH_SHA256:
        return fail("hash do rascunho diverge do registrado")
    if snapshot["connections"] != base_conn:
        return fail("rascunho altera conexoes")
    if [n["name"] for n in snapshot["nodes"]] != [n["name"] for n in base_nodes]:
        return fail("rascunho altera o conjunto de nos")
    for draft, pub in zip(snapshot["nodes"], base_nodes):
        keys = {k for k in set(draft) | set(pub) if draft.get(k) != pub.get(k)}
        if keys and (keys != {"position"} or draft["name"] not in DRAFT_MOVED_NODES):
            return fail(f"rascunho altera {draft['name']}: {sorted(keys)}")
    base_nodes = snapshot["nodes"]

    target = {key: copy.deepcopy(snapshot[key]) for key in TOP_LEVEL}
    target["nodes"] = copy.deepcopy(base_nodes)
    target["connections"] = copy.deepcopy(base_conn)
    target["pinData"] = {}
    target["active"] = False

    node = next((item for item in target["nodes"] if item["name"] == NODE), None)
    if node is None:
        return fail(f"no {NODE} ausente")
    before = node["parameters"]["jsonOutput"]
    if before.count(ANCHOR) != 1:
        return fail("ancora do corpo da mensagem nao encontrada (ou repetida)")
    if before.count(OUTPUT_ANCHOR) != 1:
        return fail("ancora de saida nao encontrada (ou repetida)")
    if "scopePrefixes" in before or "b.prefixes" in before:
        return fail("normalizador publicado ja referencia prefixos")
    after = before.replace(ANCHOR, ANCHOR + BLOCK, 1).replace(OUTPUT_ANCHOR, OUTPUT_ADD, 1)
    node["parameters"]["jsonOutput"] = after

    DST.write_text(
        json.dumps(target, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    # Verificacao estrutural relida do disco: so jsonOutput do normalizador muda.
    check = json.loads(DST.read_text(encoding="utf-8"))
    if check["connections"] != base_conn:
        return fail("conexoes mudaram")
    if [item["name"] for item in check["nodes"]] != [item["name"] for item in base_nodes]:
        return fail("conjunto/ordem de nos mudou")
    for new, old in zip(check["nodes"], base_nodes):
        if new["name"] == NODE:
            rest_new = {k: v for k, v in new.items() if k != "parameters"}
            rest_old = {k: v for k, v in old.items() if k != "parameters"}
            params_new = {k: v for k, v in new["parameters"].items() if k != "jsonOutput"}
            params_old = {k: v for k, v in old["parameters"].items() if k != "jsonOutput"}
            if rest_new != rest_old or params_new != params_old:
                return fail("normalizador mudou fora de parameters.jsonOutput")
        elif new != old:
            return fail(f"no alterado fora do normalizador: {new['name']}")

    diff = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        f"publicado/{ACTIVE_VERSION_ID}+rascunho/{DRAFT_VERSION_ID}/{NODE}/jsonOutput",
        f"candidato/{NODE}/jsonOutput",
    )
    DIFF.write_text("".join(diff), encoding="utf-8", newline="\n")

    manifest = {
        "workflowId": WORKFLOW_ID,
        "baseActiveVersionId": ACTIVE_VERSION_ID,
        "baseNodes": NODES,
        "baseEdges": EDGES,
        "baseGraphSha256": GRAPH_SHA256,
        "draftVersionId": DRAFT_VERSION_ID,
        "draftGraphSha256": DRAFT_GRAPH_SHA256,
        "draftDeltaVsPublished": sorted(f"{name}.position" for name in DRAFT_MOVED_NODES),
        "candidateNodes": len(check["nodes"]),
        "candidateEdges": edges(check["connections"]),
        "candidateGraphSha256": graph_sha256(check["nodes"], check["connections"]),
        "candidateFileSha256": hashlib.sha256(DST.read_bytes()).hexdigest(),
        "changedNode": NODE,
        "changedField": "parameters.jsonOutput",
        "normalizerBeforeSha256": hashlib.sha256(before.encode()).hexdigest(),
        "normalizerAfterSha256": hashlib.sha256(after.encode()).hexdigest(),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")

    print(f"OK: {DST.name} ({len(check['nodes'])} nos / {edges(check['connections'])} arestas,")
    print(f"    publicado {ACTIVE_VERSION_ID} + rascunho {DRAFT_VERSION_ID};")
    print(f"    vs rascunho: apenas {NODE}.parameters.jsonOutput alterado)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
