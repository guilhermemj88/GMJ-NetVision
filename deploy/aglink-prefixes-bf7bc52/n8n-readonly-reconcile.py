"""GATE n8n (READ-ONLY). Rodar como root no host do n8n: python3 - < n8n-readonly-reconcile.py

SQLite aberto com mode=ro + query_only; nao le credenciais nem execucoes.
Decide se o candidato RC7.1.2+prefixos ainda pode ser aplicado sem sobrescrever nada.
"""
import datetime
import hashlib
import json
import pathlib
import sqlite3
import subprocess

WF = "SVh8Z-zUcSzQYOOJZ-DKP"
ACTIVE = "6a97fe4a-31ea-49e6-b892-1ac55f85d115"
ACTIVE_GRAPH = "60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870"
DRAFT = "1f1405f8-e9bc-4d2e-91bc-4106dbb07285"
DRAFT_GRAPH = "6bc74d79b499c68ac20c1fd273f75bd17bec3eae51694de29ac5d2b560bf9d23"


def graph(nodes, connections):
    raw = json.dumps({"nodes": nodes, "connections": connections}, sort_keys=True)
    return hashlib.sha256(raw.encode()).hexdigest()


def edges(c):
    return sum(len(t) for v in c.values() for outs in v.values() for t in outs)


info = json.loads(subprocess.check_output(["docker", "inspect", "n8n"], text=True))[0]
root = pathlib.Path(next(m["Source"] for m in info["Mounts"] if m["Destination"] == "/home/node/.n8n"))
db = sqlite3.connect("file:" + str(root / "database.sqlite") + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
db.execute("PRAGMA query_only=ON")
db.execute("BEGIN")
w = dict(db.execute(
    "SELECT id,name,active,versionId,activeVersionId,updatedAt,nodes,connections FROM workflow_entity WHERE id=?",
    (WF,)).fetchone())
h = dict(db.execute(
    "SELECT nodes,connections FROM workflow_history WHERE workflowId=? AND versionId=?",
    (WF, w["activeVersionId"])).fetchone())
try:
    pub = db.execute(
        "SELECT id,versionId,event,createdAt FROM workflow_publish_history WHERE workflowId=? ORDER BY id DESC LIMIT 1",
        (WF,)).fetchone()
except sqlite3.OperationalError:
    pub = None
db.rollback()

an, ac = json.loads(h["nodes"]), json.loads(h["connections"])
dn, dc = json.loads(w["nodes"]), json.loads(w["connections"])
result = {
    "observedUtc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "readOnly": True,
    "container": {"running": info["State"]["Running"], "restartCount": info["RestartCount"],
                  "startedAt": info["State"]["StartedAt"], "image": info["Config"]["Image"]},
    "workflow": {k: w[k] for k in ("id", "name", "active", "versionId", "activeVersionId", "updatedAt")},
    "lastPublication": dict(pub) if pub else None,
    "active": {"nodes": len(an), "edges": edges(ac), "graphSha256": graph(an, ac)},
    "draft": {"nodes": len(dn), "edges": edges(dc), "graphSha256": graph(dn, dc)},
    "credentialValuesRead": False,
}
ok = (
    w["activeVersionId"] == ACTIVE and result["active"]["graphSha256"] == ACTIVE_GRAPH
    and len(an) == 58 and edges(ac) == 59
    and w["versionId"] == DRAFT and result["draft"]["graphSha256"] == DRAFT_GRAPH
)
result["gate"] = "GO_CANDIDATE_APPLIES" if ok else "STOP_RECONCILE"
print(json.dumps(result))
