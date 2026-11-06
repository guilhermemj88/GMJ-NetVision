"""Read real persisted/HTTP/browser evidence; inject lease loss only with explicit --lose-lease."""
import collections, datetime, hashlib, json, os, pathlib, subprocess, sys, time, urllib.parse

OUT=pathlib.Path(os.environ['HOMOLOG_EVIDENCE_DIR'])
CONFIG=json.loads(pathlib.Path(os.environ['HOMOLOG_CONFIG_PATH']).read_text())
URL=urllib.parse.urlsplit(CONFIG['databaseUrl'])
assert URL.hostname=='127.0.0.1' and URL.port==55448 and URL.path.startswith('/pilot_auto_all_homolog_')
CID=CONFIG['containerId']; DB=URL.path[1:]
info=json.loads(subprocess.check_output(['docker','inspect',CID],text=True))[0]
assert info['Id']==CID and info['Config']['Labels']['gmj.task']=='pilot-auto-all-homolog-20261105'
assert info['HostConfig']['PortBindings']['5432/tcp']==[{'HostIp':'127.0.0.1','HostPort':'55448'}]
def read(name):return json.loads((OUT/name).read_text(encoding='utf-8'))
def sql(query):
    return subprocess.check_output(['docker','exec',CID,'psql','-U','pilot_homolog','-d',DB,'-Atc',query],text=True).strip()
def rows(query):return json.loads(sql('SELECT coalesce(json_agg(t),\'[]\'::json) FROM ('+query+') t'))
def evidence(name,value):
    (OUT/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')

profiles=rows('SELECT id, mode, "triggerPercent", "triggerSamples", "recoveryPercent", "recoverySamples" FROM "BgpMitigationProfile"')
assert len(profiles)==23 and all(p['mode']=='AUTO' and p['triggerPercent']==95 and p['triggerSamples']==3 for p in profiles)
records=rows('SELECT id,kind,status,payload FROM "MitigationAutomationRecord"')
outbox=[r for r in records if r['kind']=='outbox']
commands=[r for r in records if r['kind'] in ('command','manual-command')]
assert not commands, 'A command was scheduled despite HOLD'
assert int(sql('SELECT count(*) FROM "BgpAdminActionLog"'))==0
assert int(sql('SELECT count(*) FROM "BgpMitigationEvent" WHERE verified=true'))==0
snapshot=read('timeline.json')[-1]
assert len(snapshot['all']['clients'])==23 and all(c['eligible'] for c in snapshot['all']['clients'])
assert snapshot['second']['requests']==0 and not snapshot['secondaryEngine']['decisions']
assert not snapshot['all']['phases']['physicalExecutionAuthorized']

if '--lose-lease' in sys.argv:
    assert len(outbox)==46
    if not all(r['status']=='SENT' for r in outbox):
        assert '--allow-policy-pending' in sys.argv, 'Explicitly record the deferred real-time window before fault injection'
        assert collections.Counter(r['status'] for r in outbox)=={'SENT':23,'PENDING':23}
    lease=snapshot['all']['lease']; assert lease['acquired'] and not lease['lost']
    pid=lease['holderBackendPid']; assert isinstance(pid,int) and pid>0
    ownership=rows(f"SELECT pid,datname,usename FROM pg_stat_activity WHERE pid={pid} AND datname=current_database() AND usename=current_user")
    assert len(ownership)==1
    at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    assert sql(f'SELECT pg_terminate_backend({pid})')=='t'
    evidence('lease-fault-injection.json',{'atUtc':at,'containerId':CID,'database':DB,'pid':pid,'ownerVerified':ownership,'terminated':True})
    print('Injected connection loss into the verified task-only lease backend',pid)
    raise SystemExit(0)

http=read('http-growth.json')['received']; groups=collections.defaultdict(list)
for item in http:
    body=item['body']; assert body['event']=='MITIGATION_DETECTION_BLOCKED'
    assert body['profileId'] in {p['id'] for p in profiles}
    assert body['verified'] is False and body['growth'] is not None
    assert body['growth']['thresholdPct']==95 and body['growth']['currentUtilizationPct']>=95
    groups[body['eventId']].append(item)
assert all(len({v['raw'] for v in group})==1 for group in groups.values()), 'Retry payload changed'
summary={'synthetic':True,'database':DB,'containerId':CID,'profiles':23,
    'eligible':23,'monitoredInterfaces':snapshot['poller']['monitoredInterfaces'],
    'events':len(groups),'httpReceipts':len(http),'outboxStates':dict(collections.Counter(r['status'] for r in outbox)),
    'retriedEvents':sum(len(v)>1 for v in groups.values()),'identicalRawRetries':True,
    'baselines':sorted({v[0]['body']['growth']['baselineAverage5mPct'] for v in groups.values()}),
    'commandRecords':len(commands),'secondaryCollections':snapshot['second']['requests'],
    'secondaryDecisions':len(snapshot['secondaryEngine']['decisions']),
    'primaryLease':snapshot['all']['lease'],
    'payloadSha256':{key:hashlib.sha256(v[0]['raw'].encode()).hexdigest() for key,v in groups.items()}}
if '--final' in sys.argv:
    assert len(groups)==46 and len(outbox)==46
    assert all(len(v)>=2 for v in groups.values())
    if '--allow-policy-pending' in sys.argv:
        assert collections.Counter(r['status'] for r in outbox)=={'SENT':23,'PENDING':23}
        summary['realTimeThirtyMinuteWindow']='PENDENTE: user requested immediate close without waiting; records preserved'
    else:
        assert all(r['status']=='SENT' for r in outbox) and all(any(x['ack'] for x in v) for v in groups.values())
    by_profile=collections.defaultdict(list)
    for group in groups.values():by_profile[group[0]['body']['profileId']].append(group[0])
    for group in by_profile.values():
        assert len(group)==2
        group.sort(key=lambda x:x['at'])
        assert group[0]['body']['growth']['baselineAverage5mPct']==20
        assert group[1]['body']['growth']['baselineAverage5mPct']>=40
        assert group[0]['body']['growth']['thresholdReachedAt']!=group[1]['body']['growth']['thresholdReachedAt']
    browser=read('playwright.json');assert browser['realBrowser'] and not browser['interception']
    replay=read('growth-replay.json');assert replay['allIdentical'] and replay['events']==46
    names={c['name'] for c in browser['captures']}
    assert {'normal','1-3','2-3','3-3','second-baseline','lease-lost'}.issubset(names)
    assert all(c['rows']==23 and pathlib.Path(c['file']).exists() for c in browser['captures'])
    assert not browser['errors'], browser['errors']
    assert snapshot['all']['lease']['lost'] and not snapshot['poller']['running']
    summary['go']='ISOLATED_AUTO_ALL_HOLD_ONLY'
evidence('integration-summary.json',summary)
print(json.dumps(summary,indent=2))
