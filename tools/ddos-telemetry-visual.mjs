import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = process.cwd();
const bridgeVisual = process.argv.includes('--bridge');
const out = path.join(root, '.artifacts/telemetry-visual');
await fs.mkdir(out, { recursive: true });
let entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MitigationDirectionReviewPanel} from '../../apps/web/src/components/bgp/mitigation-direction-review';
import {MitigationTelemetryFacts} from '../../apps/web/src/components/bgp/mitigation-telemetry';
const at=new Date().toISOString(); const p={id:'play-v4',customer:'PLAY CONNECT',interfaceId:'if-play',interfaceName:'Eth-Trunk1.3024',addressFamily:'IPV4',mode:'ALERT_ONLY',autoTrafficDirection:null};
const v6={...p,id:'play-v6',addressFamily:'IPV6'};
const d={profileId:p.id,interfaceId:p.interfaceId,interfaceName:p.interfaceName,ifIndex:151,adminStatus:'UP',operStatus:'UP',source:'LEGACY',sampleId:'reference',sampleAt:at,sampleAgeMs:0,maxAgeMs:45000,rxBps:'148026493',txBps:'1188475611',direction:null,directionSource:null,telemetryAvailable:true,reasons:['DIRECTION_NOT_CONFIGURED'],blockedReason:'DIRECTION_NOT_CONFIGURED',mode:'ALERT_ONLY',promotedBySweep:false,executionAuthorized:false,executionBlocks:['PROFILE_MODE_NOT_AUTO'],sharedCounterProfileIds:[p.id,v6.id]};
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><main><h1>BGP · Mitigação DDoS</h1><p>AMBIENTE ISOLADO · valores de referência da auditoria · sem conexão com produção</p><section className="sample"><h2>PLAY CONNECT · Eth-Trunk1.3024</h2><p>Banda contratada: 10 Gbps · capacidade física: 300 Gbps</p><MitigationTelemetryFacts entry={d} generatedAt={at}/></section><MitigationDirectionReviewPanel profiles={[p,v6]} entries={[d,{...d,profileId:v6.id}]}/></main></QueryClientProvider>);`;
if (bridgeVisual) {
  const report = { generatedAt: '__NOW__', mode: 'SHADOW', profileIds: ['fast-v4'], enforceProfileIds: [], executionAvailable: false, samples: [{ profileId: 'fast-v4', source: 'FAST', available: true, reason: null, sampleAt: '__NOW__', rxBps: '232000000', txBps: '9500000000', intervalMs: 10000 }], decisions: [{ profileId: 'fast-v4', outcome: 'WOULD_ACTIVATE', reason: 'GLOBAL_MODE_SIMULATION_ONLY', samplesOver: 3, requiredSamples: 3, thresholdBps: '9000000000', verified: false, decisionMs: 8, sampleToDecisionMs: 240 }], shadow: { state: 'RUNNING', lastError: null }, engine: null, responseBudgetMs: 60000 };
  entry = "import {MitigationFastBridgeFacts} from '../../apps/web/src/components/bgp/mitigation-fast-bridge';\nconst bridge=" + JSON.stringify(report).replaceAll('"__NOW__"', 'new Date().toISOString()') + ';\n' + entry;
  entry = entry.replace('<MitigationDirectionReviewPanel profiles=', '<section className="sample"><h2>Pipeline FAST · CENÁRIO SINTÉTICO · direção TX</h2><MitigationFastBridgeFacts profileId="fast-v4" report={bridge}/></section><MitigationDirectionReviewPanel profiles=');
}
await fs.writeFile(path.join(out, 'entry.tsx'), entry);
await build({
  entryPoints: [path.join(out, 'entry.tsx')],
  outfile: path.join(out, 'bundle.js'),
  bundle: true,
  platform: 'browser',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_API_URL': '""',
    'process.env.API_INTERNAL_URL': '""',
  },
  alias: { '@': path.join(root, 'apps/web/src') },
  logLevel: 'silent',
});
const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><style>*{box-sizing:border-box}body{margin:0;background:#070e1c;color:#dce7f5;font:14px/1.55 Arial,sans-serif}main{max-width:1180px;margin:auto;padding:24px;display:grid;gap:20px}h1{font-size:24px;margin:0}h2{font-size:18px}.sample{padding:16px;border:1px solid #334155;border-radius:10px;background:#111827}button{border:1px solid #4c8ed4;border-radius:6px;background:#164371;color:#e2efff;padding:9px 14px;cursor:pointer}button:disabled{opacity:.45;cursor:default}input{accent-color:#4aaaff}label{overflow-wrap:anywhere}small{color:#b3c3d9}@media(max-width:600px){main{padding:12px}h1{font-size:20px}}</style><div id="root"></div><script src="/bundle.js"></script></html>`;
const server = http.createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  if (req.url === '/bundle.js' || req.url === '/bundle.css') {
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
    return res.end(await fs.readFile(path.join(out, req.url.slice(1))));
  }
  if (req.url === '/api/bgp/mitigation/directions/preview') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { changes } = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        previewId: '00000000-0000-4000-8000-000000000001',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        changes: changes.map((c) => ({
          ...c,
          interfaceName: 'Eth-Trunk1.3024',
          addressFamily: c.profileId.endsWith('v6') ? 'IPV6' : 'IPV4',
          mode: 'ALERT_ONLY',
          before: null,
          after: c.direction,
          effectiveAfter: c.direction,
          sourceAfter: 'PROFILE',
          impact: 'SHADOW_EVALUATION_ONLY',
        })),
      }),
    );
  }
  res.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
const browser = await chromium.launch({
  executablePath:
    process.env.PLAYWRIGHT_CHROME_PATH ??
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const evidence = [];
try {
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto('http://127.0.0.1:' + port);
    await page.getByRole('heading', { name: 'REVISAR DIREÇÕES RX/TX' }).waitFor();
    if (width === 1440 || width === 390) {
      await page.getByLabel('Direção play-v4', { exact: true }).selectOption('TX');
      await page.getByRole('button', { name: 'GERAR PRÉVIA (1)' }).click();
      await page.getByRole('heading', { name: 'PRÉVIA COMPLETA — 1 alterações' }).waitFor();
    }
    const sizes = await page.evaluate(() => ({
      viewport: globalThis.innerWidth,
      document: globalThis.document.documentElement.scrollWidth,
    }));
    if (sizes.document > sizes.viewport) throw Error('Horizontal overflow at ' + width);
    const filename = (bridgeVisual ? 'ddos-fast-bridge-' : 'ddos-telemetry-') + width + '.png';
    await fs.mkdir(path.join(root, 'docs/evidence'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/evidence', filename), fullPage: true });
    evidence.push({ width, ...sizes, filename, preview: width === 1440 || width === 390 });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
await fs.writeFile(
  path.join(root, 'docs/benchmarks/' + (bridgeVisual ? 'ddos-fast-bridge-visual.json' : 'ddos-telemetry-visual.json')),
  JSON.stringify(evidence, null, 2) + '\n',
);
console.log(JSON.stringify(evidence));
