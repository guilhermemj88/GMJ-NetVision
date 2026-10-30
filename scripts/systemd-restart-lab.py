"""Destructive ONLY inside the disposable Docker lab, never on a deployment host."""
import json
import os
from pathlib import Path
import subprocess
import time

assert os.environ.get('NETVISION_DISPOSABLE_SYSTEMD_LAB') == '1'
assert Path('/.dockerenv').exists()
assert Path('/phase01-disposable-marker').read_text().strip() == 'phase01-only'
API, MCP = 'phase01-lab-api.service', 'phase01-lab-mcp.service'


def ctl(*args):
    return subprocess.check_output(['systemctl', *args], text=True).strip()


def state():
    return {unit: dict(line.split('=', 1) for line in ctl('show', unit, '--property=MainPID,ActiveState,NRestarts').splitlines())
            for unit in [API, MCP]}


Path('/run/phase01-mcp.py').write_text('''import time,urllib.request
last=None
while True:
 try:
  with urllib.request.urlopen('http://127.0.0.1:18080',timeout=.2) as r: ok=r.status==200
 except Exception: ok=False
 if ok!=last:
  with open('/run/phase01-connectivity.log','a') as f:f.write(str(ok)+'\\n')
 last=ok
 time.sleep(.1)
''')
Path('/etc/systemd/system/' + API).write_text('''[Unit]
Description=Disposable fake API
[Service]
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/python3 -m http.server 18080 --bind 127.0.0.1
Restart=on-failure
RestartSec=1
''')
Path('/etc/systemd/system/' + MCP).write_text(f'''[Unit]
Description=Disposable fake MCP
Requires={API}
After={API}
[Service]
ExecStart=/usr/bin/python3 /run/phase01-mcp.py
Restart=on-failure
RestartSec=1
''')
ctl('daemon-reload')
ctl('start', MCP)
time.sleep(.5)
results = {'systemd': ctl('--version').splitlines()[0], 'initial': state(), 'cases': []}
for operation in ['restart', 'try-restart']:
    before = state()
    ctl(operation, API)
    after = state()
    assert before[MCP]['MainPID'] != after[MCP]['MainPID']
    results['cases'].append({'operation': operation, 'before': before, 'after': after, 'mcpRestarted': True})
before = state()
ctl('stop', API)
after = state()
assert after[MCP]['ActiveState'] == 'inactive'
results['cases'].append({'operation': 'stop', 'before': before, 'after': after, 'mcpStopped': True})
ctl('start', MCP)
time.sleep(.5)
for label in ['candidate-swap-simulation', 'rollback-simulation']:
    before = state()
    ctl('restart', '--job-mode=ignore-dependencies', API)
    time.sleep(.5)
    after = state()
    assert before[MCP]['MainPID'] == after[MCP]['MainPID']
    assert before[API]['MainPID'] != after[API]['MainPID']
    results['cases'].append({'operation': label, 'jobMode': 'ignore-dependencies', 'before': before, 'after': after})
# Keep Requires; exercise normal restart after bypass and automatic API recovery.
before = state()
subprocess.check_call(['kill', '-KILL', before[API]['MainPID']])
time.sleep(5)
after = state()
assert after[API]['ActiveState'] == 'active'
assert before[API]['MainPID'] != after[API]['MainPID']
results['cases'].append({'operation': 'API-process-crash', 'before': before, 'after': after})
results['fakeMcpConnectivityTransitions'] = Path('/run/phase01-connectivity.log').read_text().splitlines()
assert 'False' in results['fakeMcpConnectivityTransitions'] and results['fakeMcpConnectivityTransitions'][-1] == 'True'
results['limitations'] = ['Fake services only; does not establish real MCP transport recovery',
                          '259.9 lab differs from 259.5 production; no production authorization']
print(json.dumps(results, indent=2))
