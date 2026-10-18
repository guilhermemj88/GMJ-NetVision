#!/usr/bin/env bash
# Run only in the disposable local build container described in the release report.
set -euo pipefail
test "$(pwd)" = /work
export NEXT_TELEMETRY_DISABLED=1
export NODE_OPTIONS=--max-old-space-size=4096
apt-get update -qq
apt-get install -y --no-install-recommends openssl ca-certificates >/dev/null
npm ci --ignore-scripts --no-audit --no-fund
npm run build -w @gmj/api
npm run build -w @gmj/web
mkdir -p release/apps/api/src release/web
tar -xf /source/candidate-source.tar -C release
cp -a apps/api/dist release/apps/api/
cp -a apps/api/src/generated release/apps/api/src/
cp -a apps/api/prisma release/apps/api/
cp -a apps/api/package.json release/apps/api/
cp -a apps/web/.next/standalone/. release/web/
mkdir -p release/web/apps/web/.next
cp -a apps/web/.next/static release/web/apps/web/.next/
if test -d apps/web/public; then cp -a apps/web/public release/web/apps/web/; fi
mkdir -p rollback/apps/api/src
tar -xf /source/rollback-api-source.tar -C rollback
cp -a apps/api/src/generated rollback/apps/api/src/
(cd rollback/apps/api && /work/node_modules/.bin/tsup)
cp rollback/apps/api/dist/server.cjs release/apps/api/dist/rollback-server.cjs
npm prune --omit=dev --ignore-scripts --no-audit --no-fund
cp -a node_modules packages package.json package-lock.json release/
cp -a deploy docs release/
node <<'NODE'
const fs=require('fs'),cp=require('child_process');
const {PrismaClient}=require('./release/apps/api/src/generated/prisma');
async function probe(){
  const db=new PrismaClient({datasources:{db:{url:process.env.LINUX_SMOKE_DATABASE_URL}}});
  try{console.log(JSON.stringify({linuxPrismaSmoke:await db.$queryRawUnsafe('SELECT current_database() AS database, version() AS version')}));}finally{await db.$disconnect();}
  const base={...process.env,DEMO_MODE:'true',MITIGATION_MODE:'SIMULATION_ONLY',MITIGATION_FAST_BRIDGE_MODE:'OFF',SNMP_POLLING_ENABLED:'false',CREDENTIAL_ENCRYPTION_KEY:require('crypto').randomBytes(32).toString('base64')};
  async function service(script,cwd,port,url){
    const child=cp.spawn(process.execPath,[script],{cwd,env:{...base,PORT:String(port),HOSTNAME:'127.0.0.1'},stdio:'ignore'});
    try{let ok=false;for(let n=0;n<100;n++){try{const r=await fetch(url,{signal:AbortSignal.timeout(500)});if(r.ok){ok=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ok)throw Error('Linux service smoke failed: '+script);}
    finally{const exit=child.exitCode!==null?Promise.resolve():new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;}
  }
  await service('/work/release/apps/api/dist/server.cjs','/work/release',3333,'http://127.0.0.1:3333/health');
  await service('/work/release/apps/api/dist/rollback-server.cjs','/work/release',3333,'http://127.0.0.1:3333/health');
  await service('/work/release/web/apps/web/server.js','/work/release/web/apps/web',3000,'http://127.0.0.1:3000/login');
  fs.writeFileSync('release/BUILD.json',JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,sourceCommit:process.env.RELEASE_COMMIT,apiSmoke:true,webSmoke:true,prismaSmoke:true,baselineRollbackSmoke:true,baselineSource:'fc790ade3455f2c16eeff372a8a9168deffb0d7d',productionModified:false},null,2));
}
probe().catch(e=>{console.error(e.message);process.exitCode=1});
NODE
tar -czf /out/netvision-fast-bridge-linux-candidate.tar.gz -C release .
sha256sum /out/netvision-fast-bridge-linux-candidate.tar.gz > /out/SHA256SUMS
cp release/BUILD.json /out/BUILD.json
