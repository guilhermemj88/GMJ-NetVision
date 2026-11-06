"""Create only this task's disposable, loopback PostgreSQL. No existing DB is used."""
import json, os, pathlib, secrets, socket, subprocess, time

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(os.environ['HOMOLOG_EVIDENCE_DIR']).resolve()
OUT.mkdir(parents=True, exist_ok=True)
PORT = 55448
DATABASES = ['pilot_auto_all_homolog_20261105', 'pilot_snapshot_negative_20261105']
NAME = 'gmj-pilot-homolog-' + secrets.token_hex(5)
assert PORT not in (55433, 55439, 55077)
with socket.socket() as probe:
    probe.bind(('127.0.0.1', PORT))
context = subprocess.check_output(['docker', 'context', 'inspect'], text=True)
assert 'dockerDesktopLinuxEngine' in context, 'Expected local Docker Desktop, not a remote context'
existing = json.loads(subprocess.check_output(['docker', 'ps', '--no-trunc', '--format', '{{json .}}'], text=True).replace('\n', ',').rstrip(',').join(['[', ']']))
password = secrets.token_urlsafe(24)
cid = subprocess.check_output(['docker', 'run', '-d', '--name', NAME,
    '--label', 'gmj.task=pilot-auto-all-homolog-20261105', '--tmpfs', '/var/lib/postgresql/data',
    '-p', f'127.0.0.1:{PORT}:5432', '-e', 'POSTGRES_USER=pilot_homolog',
    '-e', 'POSTGRES_PASSWORD='+password, '-e', 'POSTGRES_DB=homolog_control', 'postgres:16-alpine'], text=True).strip()
for _ in range(40):
    if subprocess.run(['docker', 'exec', cid, 'pg_isready', '-U', 'pilot_homolog'], capture_output=True).returncode == 0:
        break
    time.sleep(.5)
info = json.loads(subprocess.check_output(['docker', 'inspect', cid], text=True))[0]
assert info['Id'] == cid and info['Name'] == '/'+NAME and NAME != 'nv-autoatest-pg'
assert info['Config']['Labels']['gmj.task'] == 'pilot-auto-all-homolog-20261105'
assert '/var/lib/postgresql/data' in info['HostConfig']['Tmpfs']
assert info['HostConfig']['PortBindings']['5432/tcp'] == [{'HostIp':'127.0.0.1', 'HostPort':str(PORT)}]
env = {k:v for k,v in os.environ.items() if not any(s in k for s in ('DATABASE_URL','NETVISION_','MITIGATION_','ZABBIX_'))}
urls = {db:f'postgresql://pilot_homolog:{password}@127.0.0.1:{PORT}/{db}?schema=public' for db in DATABASES}
preflight = {'containerId':cid,'name':NAME,'host':'127.0.0.1','port':PORT,'databases':DATABASES,
    'tmpfs':True,'identityVerifiedBeforeSchema':True,'existingContainersUntouched':existing,
    'originalDatabaseUrlPresent':bool(os.environ.get('DATABASE_URL')),
    'originalFastDatabaseUrlPresent':bool(os.environ.get('FAST_TEST_DATABASE_URL'))}
(OUT/'postgres-preflight.json').write_text(json.dumps(preflight,indent=2)+'\n')
for db in DATABASES:
    subprocess.run(['docker','exec',cid,'createdb','-U','pilot_homolog',db],check=True)
    env['DATABASE_URL'] = urls[db]
    with (OUT/(db+'-schema.log')).open('w',encoding='utf-8') as log:
        subprocess.run(['node','node_modules/prisma/build/index.js','db','push','--skip-generate',
            '--schema','apps/api/prisma/schema.prisma'],cwd=ROOT,env=env,check=True,stdout=log,stderr=subprocess.STDOUT)
    count = subprocess.check_output(['docker','exec',cid,'psql','-U','pilot_homolog','-d',db,'-Atc',
        'SELECT count(*) FROM "BgpMitigationProfile"'],text=True).strip()
    assert count == '0'
config = {'containerId':cid,'containerName':NAME,'databaseUrl':urls[DATABASES[0]],
          'negativeDatabaseUrl':urls[DATABASES[1]],'port':PORT,'deviceId':'synthetic-loopback-router',
          'apiPort':4321,'secondApiPort':4322,'webPort':4323,'webhookPort':4324,'sshPort':4325,
          'credentialKey':__import__('base64').b64encode(secrets.token_bytes(32)).decode(),
          'adminPassword':'SyntheticAdmin-'+secrets.token_hex(10)}
(OUT/'local-config.json').write_text(json.dumps(config,indent=2)+'\n')
print(json.dumps(preflight,indent=2))
