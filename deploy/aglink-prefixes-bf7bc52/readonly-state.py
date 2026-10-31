import json,subprocess,pathlib,hashlib,os,urllib.request,datetime,re
# READ-ONLY preflight. Nao imprime segredos: so variaveis de flag nominalmente permitidas.
def sh(*a):return subprocess.run(a,capture_output=True,text=True).stdout.strip()
def prop(unit,p):return sh('systemctl','show',unit,'--property='+p,'--value')
SAFE=re.compile(r'^(NETVISION_INSTALLATION_ID|MITIGATION_AUTO_[A-Z_]+|MITIGATION_(MODE|LIVE_WRITE[A-Z_]*|EXECUTOR[A-Z_]*|DEVICE_ALLOWLIST[A-Z_]*|ALLOWED[A-Z_]*)|SNMP_POLLING_ENABLED|DEMO_MODE|PORT|HOST|NODE_ENV)$')
out={'observedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'services':{}}
for u in ['netvision-api','netvision-mcp','netvision-web','netvision-fast-observer']:
    pid=prop(u,'MainPID');d={'active':prop(u,'ActiveState'),'pid':pid,'nRestarts':prop(u,'NRestarts'),'since':prop(u,'ActiveEnterTimestamp'),
       'dropIns':len([x for x in prop(u,'DropInPaths').split() if x]),'workingDirectory':prop(u,'WorkingDirectory'),'execStart':re.sub(r'\s+',' ',prop(u,'ExecStart'))[:300],
       'requires':prop(u,'Requires'),'partOf':prop(u,'PartOf'),'bindsTo':prop(u,'BindsTo'),'environmentFiles':prop(u,'EnvironmentFiles')}
    if pid and pid!='0':
        d['cwd']=os.readlink(f'/proc/{pid}/cwd')
        env=dict(x.split('=',1) for x in pathlib.Path(f'/proc/{pid}/environ').read_bytes().decode().split('\0') if '=' in x)
        d['flags']={k:v for k,v in sorted(env.items()) if SAFE.match(k)}
        d['hasDatabaseUrl']='DATABASE_URL' in env
        d['hasN8nWebhookUrl']='MITIGATION_N8N_WEBHOOK_URL' in env
        if u=='netvision-api':api_env=env
    out['services'][u]=d
a=out['services']['netvision-api'];rel=pathlib.Path(a['cwd'])
for f in ['dist/server.cjs','dist/server.cjs.map','dist/catalog/physical-catalog-v1.yaml']:
    p=rel/f;a.setdefault('artifacts',{})[f]=hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
src=rel.parent.parent/'SOURCE_SHA';a['releaseSourceSha']=src.read_text().strip() if src.exists() else None
a['releaseMigrationDirs']=len([x for x in (rel/'prisma/migrations').iterdir() if x.is_dir()]) if (rel/'prisma/migrations').exists() else None
out['releases']=sorted(x.name for x in pathlib.Path('/opt/netvision-auto-activate/releases').iterdir())
for name,url in [('api','http://127.0.0.1:3333/health'),('web','http://127.0.0.1:3000/'),('mcp','http://127.0.0.1:3335/health')]:
    try:
        r=urllib.request.urlopen(url,timeout=10);body=r.read(400).decode(errors='replace')
        out.setdefault('health',{})[name]={'status':r.status,'body':body if name!='web' else None}
    except Exception as e:out.setdefault('health',{})[name]={'error':type(e).__name__}
# DB: somente leitura
import urllib.parse
u=urllib.parse.urlsplit(api_env['DATABASE_URL'])
penv=dict(os.environ,PGPASSWORD=urllib.parse.unquote(u.password or ''),PGOPTIONS='-c default_transaction_read_only=on')
q="""select json_build_object('ro',current_setting('transaction_read_only'),
'migrations',(select count(*) from _prisma_migrations where finished_at is not null),
'migrationsUnfinished',(select count(*) from _prisma_migrations where finished_at is null and rolled_back_at is null),
'lastMigration',(select migration_name from _prisma_migrations order by finished_at desc nulls last limit 1),
'durableRecords',(select count(*) from "MitigationAutomationRecord"),
'profiles',(select count(*) from "BgpMitigationProfile"),
'aglink',(select row_to_json(t) from (select id,"policyName",mode,enabled,"mitigationRt" from "BgpMitigationProfile" where id='cmuoavm4e00bysslhqd0h3q7u') t))"""
r=subprocess.run(['psql','-h',u.hostname or '127.0.0.1','-p',str(u.port or 5432),'-U',urllib.parse.unquote(u.username),'-d',u.path.lstrip('/'),'-Atc',q],env=penv,capture_output=True,text=True)
try:out['db']=json.loads(r.stdout.strip())
except Exception:out['db']={'error':'query_failed','stderrSuppressed':True,'hint':r.stderr[:160].replace(u.password or '\0','***')}
st=os.statvfs('/');out['diskFreeBytes']=st.f_bavail*st.f_frsize
print(json.dumps(out))
