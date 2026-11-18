#!/bin/bash
# Chama uma ferramenta via MCP DEV (JSON-RPC). Uso: call.sh <tool> '<json-args>'
# Com VSI_CALL_OUT=<arquivo> grava a resposta INTEIRA nesse arquivo (0600) e imprime so um resumo:
# a resposta de diagnose_vsi com `facts` passa de 60 mil caracteres e nao pode ser cortada.
set -eu
umask 077
python3 - "$1" "$2" <<'PY'
import json,os,sys,urllib.request
tool,args=sys.argv[1],json.loads(sys.argv[2])
body=json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":tool,"arguments":args}}).encode()
req=urllib.request.Request("http://127.0.0.1:%s/mcp" % os.environ.get("VSI_MCP_PORT","43902"),data=body,headers={"content-type":"application/json","accept":"application/json, text/event-stream"})
raw=urllib.request.urlopen(req,timeout=130).read().decode()
for line in raw.splitlines():
    if line.startswith("data:"): raw=line[5:].strip()
text=json.dumps(json.loads(raw),ensure_ascii=False,indent=1)
out=os.environ.get("VSI_CALL_OUT")
if out:
    with open(out,"w",encoding="utf-8") as f: f.write(text+"\n")
    print("resposta completa em %s (%d caracteres)" % (out,len(text)))
else:
    print(text[:60000])
PY
