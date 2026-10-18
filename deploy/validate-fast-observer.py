"""Read-only rollout checks. Writes a report only inside the observer release audit directory."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

release = Path(sys.argv[1]).resolve()
if not str(release).startswith('/opt/netvision-fast-observer/releases/rc-'):
    raise SystemExit('Dedicated observer release required')

def query(database, sql):
    p = subprocess.run(['sudo','-u','postgres','psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',database],
                       input='BEGIN READ ONLY;\n'+sql+'\nCOMMIT;',text=True,capture_output=True,check=True)
    return p.stdout.strip()

health = json.load(urllib.request.urlopen('http://127.0.0.1:3355/health', timeout=10))
started = health['startedAt'].replace("'", "''")
metrics = json.loads(query('netvision_fast_observe', f'''
WITH rows AS (
 SELECT *, extract(epoch FROM ("collectedAt"-lag("collectedAt") OVER w))*1000 AS gap,
 "uptimeTicks"-lag("uptimeTicks") OVER w AS uptime_delta
 FROM "MitigationTrafficObservation" WHERE "collectedAt">='{started}' WINDOW w AS(PARTITION BY "interfaceId" ORDER BY "collectedAt")
), stats AS (
 SELECT "interfaceId", min("interfaceName") AS name,count(*) AS observations,
 min("collectedAt") AS first,max("collectedAt") AS last,
 percentile_cont(.5) WITHIN GROUP(ORDER BY gap) AS interval_p50_ms,
 percentile_cont(.95) WITHIN GROUP(ORDER BY gap) AS interval_p95_ms,max(gap) AS interval_max_ms,
 percentile_cont(.5) WITHIN GROUP(ORDER BY extract(epoch FROM("collectedAt"-"requestStartedAt"))*1000) AS get_p50_ms,
 percentile_cont(.95) WITHIN GROUP(ORDER BY extract(epoch FROM("collectedAt"-"requestStartedAt"))*1000) AS get_p95_ms,
 max(extract(epoch FROM("collectedAt"-"requestStartedAt"))*1000) AS get_max_ms,
 count(*)-count(DISTINCT id) AS duplicates,count(*) FILTER(WHERE gap<=0) AS out_of_order,
 count(*) FILTER(WHERE uptime_delta<=0) AS uptime_regressions,count(DISTINCT "discontinuityTicks") AS discontinuity_values,
 count(DISTINCT "ifIndex") AS ifindex_values,count(DISTINCT "inOctets") AS input_counter_values,
 count(DISTINCT "outOctets") AS output_counter_values,count(*) FILTER(WHERE quality='VALID') AS valid_rate_samples,
 count(*) FILTER(WHERE quality='ADMIN_DOWN') AS admin_down_samples,
 min("inOctets")::text AS raw_in_octets,min("outOctets")::text AS raw_out_octets,
 max("speedBps")::text AS physical_capacity_bps
 FROM rows GROUP BY "interfaceId"
) SELECT json_agg(stats ORDER BY "interfaceId") FROM stats;'''))
profiles = query('netvision', '''SELECT coalesce(json_agg(p ORDER BY id),'[]') FROM "BgpMitigationProfile" p
WHERE id IN ('cmuoavm4x00c3sslhworjdb9i','cmuoavm5i00c8sslhed09lt8p');''')
before = json.loads((release/'audit/before.json').read_text())
permissions = json.loads(query('netvision', '''SELECT json_agg(x) FROM (SELECT name,
has_table_privilege('netvision_fast_observer',quote_ident(name),'SELECT') AS can_read,
has_table_privilege('netvision_fast_observer',quote_ident(name),'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write
FROM unnest(ARRAY['Device','Interface','SnmpCredential','BgpMitigationProfile','BgpMitigationRuntime','BgpMitigationEvent']) AS name)x;'''))
api_pid = subprocess.check_output(['systemctl','show','netvision-api','-p','MainPID','--value'],text=True).strip()
api_env = dict(p.split('=',1) for p in Path('/proc/'+api_pid+'/environ').read_text().split('\0') if '=' in p)
api_hash = hashlib.sha256(Path('/opt/GMJ-NetVision-production-alarm-chart/apps/api/dist/server.cjs').read_bytes()).hexdigest()
op_samples = json.loads(query('netvision','''SELECT json_agg(x) FROM (
 SELECT i.id,i.name,m.timestamp,m."inOctets"::text AS raw_in_octets,m."outOctets"::text AS raw_out_octets,m."txBps",m."operStatus"
 FROM "Interface" i JOIN LATERAL(SELECT * FROM "InterfaceMetricSample" m WHERE m."interfaceId"=i.id ORDER BY timestamp DESC LIMIT 1)m ON TRUE
 WHERE i.id IN ('cmsxk21el03odssimb81m5hjw','cmsxk21ep03ofssim8b1155z4'))x;'''))
correlation = [{"interfaceId":r['interfaceId'],"counterMatch":any(p['id']==r['interfaceId'] and p['raw_in_octets']==r['raw_in_octets'] and p['raw_out_octets']==r['raw_out_octets'] for p in op_samples)} for r in metrics]
events = query('netvision', f'''SELECT count(*) FROM "BgpMitigationEvent" WHERE "profileId" IN
('cmuoavm4x00c3sslhworjdb9i','cmuoavm5i00c8sslhed09lt8p') AND "createdAt">='{started}';''')
report = {'capturedAt':datetime.now(timezone.utc).isoformat(),'release':health['release'],'health':health,'telemetry':metrics,
          'correlationWithConventionalPolling':correlation,'conventionalSamples':op_samples,
          'checks':{'sourceWritePrivileges':any(p['can_write'] for p in permissions),'apiPidUnchanged':api_pid==before['apiPid'],
                    'apiBundleUnchanged':api_hash==before['apiBundleSha256'],
                    'executionFlagsUnchanged':all(api_env.get(k)==v for k,v in before['flags'].items()),
                    'profilesUnchanged':hashlib.sha256(profiles.encode()).hexdigest()==before['profileSha256'],
                    'operationalMigrationCountUnchanged':query('netvision','SELECT count(*) FROM _prisma_migrations;')==before['operationalMigrationCount'],
                    'newBhnetMitigationEvents':int(events)},
          'service':subprocess.check_output(['systemctl','show','netvision-fast-observer','-p','MainPID','-p','NRestarts','-p','CPUUsageNSec','-p','MemoryCurrent'],text=True),
          'sourcePermissions':permissions,
          'manifest':json.loads((release/'runtime/release.json').read_text())}
(release/'audit/observation-validation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))
