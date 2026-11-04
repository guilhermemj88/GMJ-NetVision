import subprocess, pathlib, os, json, time, sys
root=pathlib.Path(__file__).resolve().parents[3]
art=root/'.artifacts/f1-f4'
art.mkdir(parents=True,exist_ok=True)
image='postgres:16-alpine'
user='nv_final_audit'
configs=[('nv-auto-all-f1f4-55077',55077,['mitigation_baseline_test','single_pilot_test','aglink_persistence_readiness','phase01']),('nv-auto-all-f1f4-55439',55439,['netvision_ddos_fast_test','netvision_ddos_telemetry_test','netvision_ddos_observe_test','fast_observation_test','fast_source_test'])]
evidence=[]
for name,port,dbs in configs:
    r=subprocess.run(['docker','run','-d','--name',name,'--label','netvision.audit=auto-all-f1-f4','--memory','768m','--cpus','2','--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=512m','-p',f'127.0.0.1:{port}:5432','-e',f'POSTGRES_USER={user}','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=audit_initial',image],capture_output=True,text=True)
    assert r.returncode==0, 'Container creation failed; do not reuse an existing container automatically'
    info=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
    assert info['Config']['Labels']['netvision.audit']=='auto-all-f1-f4'
    assert info['HostConfig']['PortBindings']['5432/tcp']==[{'HostIp':'127.0.0.1','HostPort':str(port)}]
    assert all(m['Type']=='tmpfs' for m in info['Mounts'])
    assert not info['HostConfig']['Binds']
    assert set(info['HostConfig']['Tmpfs']) == {'/var/lib/postgresql/data'}
    ready=False
    for _ in range(40):
        if subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U',user],capture_output=True).returncode==0:
            ready=True;break
        time.sleep(.5)
    assert ready
    version=subprocess.check_output(['docker','exec',name,'psql','-U',user,'-d','audit_initial','-Atc','SHOW server_version'],text=True).strip()
    for db in dbs:
        existing=subprocess.check_output(['docker','exec',name,'psql','-U',user,'-d','audit_initial','-Atc',"SELECT datname FROM pg_database WHERE datname='"+db+"'"],text=True).strip()
        if not existing: subprocess.run(['docker','exec',name,'createdb','-U',user,db],check=True,capture_output=True)
        env=os.environ.copy();env['DATABASE_URL']=f'postgresql://{user}@127.0.0.1:{port}/{db}?schema=public'
        started=time.monotonic()
        r=subprocess.run([str(root/'node_modules/.bin/prisma.cmd'),'migrate','deploy','--schema','apps/api/prisma/schema.prisma'],cwd=root,env=env,capture_output=True,text=True,encoding='utf8',errors='replace')
        (art/f'migration-{db}.log').write_text(r.stdout+r.stderr,encoding='utf8')
        assert r.returncode==0, 'Disposable migration failed: '+db
        count=subprocess.check_output(['docker','exec',name,'psql','-U',user,'-d',db,'-Atc','SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'],text=True).strip()
        assert count=='43'
        evidence.append({'container':name,'port':port,'database':db,'imageId':info['Image'],'version':version,'completedMigrations':int(count),'migrationMs':round((time.monotonic()-started)*1000),'loopbackOnly':True,'tmpfsOnly':True})
        print(db+' 43 migrations ready',flush=True)
(art/'postgres-environment.json').write_text(json.dumps(evidence,indent=2)+'\n',encoding='utf8')
