import pathlib, subprocess, os, json, time
root=pathlib.Path(__file__).resolve().parents[3]
art=root/'.artifacts/f1-f4'
art.mkdir(parents=True,exist_ok=True)
env=os.environ.copy()
for key in list(env):
    if 'DATABASE_URL' in key or key in ['NETVISION_PHASE01_TEST_DB','FAST_REALTIME_TEST','CODEX_AUDIT_RC13_BASELINE']:
        del env[key]
user='nv_final_audit'
for key,port,db in [
 ('MITIGATION_BASELINE_TEST_DATABASE_URL',55077,'mitigation_baseline_test'),
 ('SINGLE_PILOT_TEST_DATABASE_URL',55077,'single_pilot_test'),
 ('SINGLE_PILOT_READINESS_DATABASE_URL',55077,'aglink_persistence_readiness'),
 ('NETVISION_PHASE01_TEST_DB',55077,'phase01'),
 ('FAST_TEST_DATABASE_URL',55439,'netvision_ddos_fast_test'),
 ('TELEMETRY_TEST_DATABASE_URL',55439,'netvision_ddos_telemetry_test')]:
    env[key]=f'postgresql://{user}@127.0.0.1:{port}/{db}?schema=public'
env['DATABASE_URL']='postgresql://nv_final_audit@127.0.0.1:55077/audit_initial?schema=public'
env['FAST_REALTIME_TEST']='1'
env['NO_COLOR']='1'
started=time.monotonic()
args=[str(root/'node_modules/.bin/vitest.cmd'),'run','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile.json='+str(art/'suite.json')]
with (art/'suite.log').open('w',encoding='utf8') as log:
    r=subprocess.run(args,cwd=root/'apps/api',env=env,stdout=log,stderr=subprocess.STDOUT)
(art/'suite-execution.json').write_text(json.dumps({'exitCode':r.returncode,'wallSeconds':time.monotonic()-started,'workers':1,'fastRealtimeEnabled':True,'databaseTargets':'loopback-only disposable PostgreSQL16, six explicit test URL variables','productionConnectionConfigured':False},indent=2)+'\n',encoding='utf8')
print(json.dumps({'exitCode':r.returncode,'wallSeconds':round(time.monotonic()-started,1)}))
