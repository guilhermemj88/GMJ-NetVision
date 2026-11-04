"""Remove only the two disposable containers created by this audit's lab.py."""
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[3]
art = root / '.artifacts/f1-f4'
art.mkdir(parents=True, exist_ok=True)
removed = []
for name, port in [('nv-auto-all-f1f4-55077', 55077), ('nv-auto-all-f1f4-55439', 55439)]:
    result = subprocess.run(['docker', 'inspect', name], capture_output=True, text=True)
    if result.returncode != 0:
        continue
    info = json.loads(result.stdout)[0]
    assert info['Config']['Labels']['netvision.audit'] == 'auto-all-f1-f4'
    assert info['Config']['Image'] == 'postgres:16-alpine'
    assert info['HostConfig']['PortBindings']['5432/tcp'] == [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]
    assert not info['HostConfig']['Binds']
    assert set(info['HostConfig']['Tmpfs']) == {'/var/lib/postgresql/data'}
    assert all(m['Type'] == 'tmpfs' for m in info['Mounts'])
    subprocess.run(['docker', 'rm', '-f', name], check=True, capture_output=True)
    removed.append({'name': name, 'id': info['Id'], 'tmpfsOnly': True})
(art / 'cleanup.json').write_text(json.dumps({'onlyAuditContainersRemoved': True, 'removed': removed}, indent=2) + '\n', encoding='utf8')
print(json.dumps({'removed': [r['name'] for r in removed], 'noProductionResourceTouched': True}))
