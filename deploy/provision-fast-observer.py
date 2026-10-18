"""Provision the authorized OBSERVE canary only. Run as root on IMPLANTAR.

Creates a dedicated database/role and read grants. Does not alter operational
tables, API environment, services, BGP or device configuration. Secrets never print.
"""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from urllib.parse import quote, urlparse

release = Path(sys.argv[1]).resolve()
if not str(release).startswith('/opt/netvision-fast-observer/releases/rc-'):
    raise SystemExit('Dedicated observer release path required')

def sql(database, statement):
    result = subprocess.run(['sudo', '-u', 'postgres', 'psql', '-X', '-q', '-A', '-t',
                             '-v', 'ON_ERROR_STOP=1', '-d', database],
                            input=statement, text=True, capture_output=True)
    if result.returncode:
        # Do not echo SQL or connection secrets in case the database reports them.
        raise RuntimeError('Observer database provisioning failed')
    return result.stdout.strip()

pid = subprocess.check_output(['systemctl', 'show', 'netvision-api', '-p', 'MainPID', '--value'], text=True).strip()
api_env = dict(part.split('=', 1) for part in Path('/proc/' + pid + '/environ').read_text().split('\0') if '=' in part)
source_config = urlparse(api_env['DATABASE_URL'])
if source_config.path != '/netvision' or source_config.hostname not in ('localhost', '127.0.0.1'):
    raise SystemExit('Expected local IMPLANTAR operational database')
profiles = ['cmuoavm4x00c3sslhworjdb9i', 'cmuoavm5i00c8sslhed09lt8p']
profile_query = '''SELECT coalesce(json_agg(p ORDER BY id),'[]') FROM "BgpMitigationProfile" p
WHERE id IN ('cmuoavm4x00c3sslhworjdb9i','cmuoavm5i00c8sslhed09lt8p');'''
snapshot = sql('netvision', profile_query)
records = json.loads(snapshot)
if len(records) != 2 or any(p['mode'] != 'AUTO' or p['triggerSamples'] != 3 or p['addressFamily'] != 'IPV4' for p in records):
    raise SystemExit('Operational profile scope changed: review required')
if {p['id']: p['autoPromotedBySweep'] for p in records} != {profiles[0]: False, profiles[1]: True}:
    raise SystemExit('Unexpected AUTO provenance')

audit = release / 'audit'
audit.mkdir(exist_ok=True)
witness = {'apiPid': pid, 'profileSha256': hashlib.sha256(snapshot.encode()).hexdigest(),
           'operationalMigrationCount': sql('netvision', 'SELECT count(*) FROM _prisma_migrations;'),
           'apiBundleSha256': hashlib.sha256(Path('/opt/GMJ-NetVision-production-alarm-chart/apps/api/dist/server.cjs').read_bytes()).hexdigest(),
           'flags': {k: api_env.get(k) for k in ['MITIGATION_MODE', 'MITIGATION_LIVE_WRITE_ENABLED', 'MITIGATION_AUTO_EXECUTION_ENABLED']}}
(audit / 'before.json').write_text(json.dumps(witness, indent=2))

env_file = Path('/etc/netvision-fast-observer.env')
role = 'netvision_fast_observer'
database = 'netvision_fast_observe'
if env_file.exists():
    raise SystemExit('Observer environment already exists; refuse implicit reprovision')
if sql('postgres', "SELECT 1 FROM pg_roles WHERE rolname='netvision_fast_observer';") or sql('postgres', "SELECT 1 FROM pg_database WHERE datname='netvision_fast_observe';"):
    raise SystemExit('Observer role/database already exists; review ownership before proceeding')
password = secrets.token_urlsafe(32)
sql('postgres', f"CREATE ROLE {role} LOGIN NOINHERIT CONNECTION LIMIT 6 PASSWORD '{password}';")
sql('postgres', f'CREATE DATABASE {database} OWNER {role};')
sql('netvision', f'''GRANT CONNECT ON DATABASE netvision TO {role};
GRANT USAGE ON SCHEMA public TO {role};
GRANT SELECT ON "Device", "Interface", "SnmpCredential", "BgpMitigationProfile" TO {role};
ALTER ROLE {role} IN DATABASE netvision SET default_transaction_read_only=on;''')
migration = release / 'build/apps/api/prisma/migrations/20261018020000_mitigation_priority_traffic/migration.sql'
sql(database, 'BEGIN; SET ROLE ' + role + ';\n' + migration.read_text() + '\nCOMMIT;')
port = source_config.port or 5432
def url(name):
    return f'postgresql://{role}:{quote(password)}@127.0.0.1:{port}/{name}?schema=public&connection_limit=2&pool_timeout=5'
values = dict(line.split('=', 1) for line in (release / 'build/deploy/fast-observer.env.example').read_text().splitlines() if line and not line.startswith('#'))
values.update({'DATABASE_URL': url(database), 'MITIGATION_FAST_SOURCE_DATABASE_URL': url('netvision'),
               'CREDENTIAL_ENCRYPTION_KEY': api_env['CREDENTIAL_ENCRYPTION_KEY'],
               'MITIGATION_FAST_RELEASE': json.loads((release / 'runtime/release.json').read_text())['commit']})
if any('\n' in v or '\r' in v for v in values.values()):
    raise SystemExit('Invalid environment value')
fd = os.open(env_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, 'w') as handle:
    handle.write(''.join(k + '=' + v + '\n' for k, v in values.items()))
permissions = sql('netvision', '''SELECT json_agg(x) FROM (SELECT name,
has_table_privilege('netvision_fast_observer',quote_ident(name),'SELECT') AS can_read,
has_table_privilege('netvision_fast_observer',quote_ident(name),'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write
FROM unnest(ARRAY['Device','Interface','SnmpCredential','BgpMitigationProfile','BgpMitigationRuntime','BgpMitigationEvent']) AS name) x;''')
if any(p['can_write'] for p in json.loads(permissions)):
    raise SystemExit('Unexpected operational write privilege')
(audit / 'source-permissions.json').write_text(permissions)
print(json.dumps({'provisioned': True, 'database': database, 'sourceWritePrivileges': False,
                  'apiRestarted': False, 'migrationSha256': hashlib.sha256(migration.read_bytes()).hexdigest()}))
