import express from 'express';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const app = express();
app.use(express.json({ limit: '15mb' }));

const port = Number(process.env.PORT || process.env.LEAPCELL_LOAD_UI_PORT || 3366);
const host = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const generatedDir = path.join(ROOT, '.generated/live-runner');
const liveEventToken = randomUUID();

let proc = null;
let state = { running: false, startedAt: null, endedAt: null, exitCode: null, dashboardPort: 3360, deleteAfterFinish: false };
const logLines = [];
const sseClients = new Set();
const dashboardSseClients = new Set();
const liveCards = new Map();

function pushLog(line) {
  const text = String(line ?? '').replace(/\r?\n$/, '');
  if (!text) return;
  const row = `[${new Date().toISOString()}] ${text}`;
  logLines.push(row);
  while (logLines.length > 5000) logLines.shift();
  for (const res of sseClients) res.write(`data: ${JSON.stringify({ line: row })}\n\n`);
}

function cleanupGeneratedArtifacts() {
  if (!fs.existsSync(generatedDir)) return;
  for (const file of fs.readdirSync(generatedDir)) {
    if (file.startsWith('k6-') || file.startsWith('live-runner-') || file.startsWith('live-run-summary-') || file.startsWith('live-run-events-')) {
      try { fs.unlinkSync(path.join(generatedDir, file)); } catch {}
    }
  }
}

function pushDashboardEvent(event) {
  if (!event || typeof event !== 'object') return;
  const userId = String(event.userId || 'unknown');
  const merged = {
    ...(liveCards.get(userId) || {}),
    ...event,
    userId,
    lastSeenAt: event.lastSeenAt || new Date().toISOString(),
  };
  liveCards.set(userId, merged);
  const payload = JSON.stringify({ type: 'event', event: merged });
  for (const res of dashboardSseClients) res.write(`data: ${payload}\n\n`);
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><title>Load Runner UI</title>
<style>
body{font-family:ui-sans-serif,system-ui;background:#081225;color:#e5e7eb;margin:0}
header{padding:12px 16px;background:#020617;border-bottom:1px solid #1f2937}
main{display:grid;grid-template-columns:420px 1fr;gap:12px;padding:12px}
.panel{background:#0b1730;border:1px solid #1f2937;border-radius:10px;padding:10px}
label{display:block;font-size:12px;margin-top:8px;color:#93c5fd}
input,select{width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#020617;color:#e5e7eb}
button{margin-top:10px;padding:8px 12px;border:none;border-radius:6px;background:#2563eb;color:white;cursor:pointer}
button:disabled{opacity:.5;cursor:not-allowed}
button.stop{background:#dc2626}
pre{height:280px;overflow:auto;background:#020617;padding:8px;border-radius:6px;border:1px solid #334155}
iframe{width:100%;height:72vh;border:1px solid #334155;border-radius:8px;background:#020617}
.small{font-size:12px;color:#94a3b8}
.row{display:flex;gap:8px}
.group{border:1px solid #263247;border-radius:8px;padding:8px;margin-top:8px}
.group h3{margin:0 0 4px 0;font-size:13px;color:#bfdbfe}
.hint{font-size:11px;color:#cbd5e1}
.warn{font-size:12px;color:#fca5a5;margin-top:8px;min-height:16px}
</style></head><body>
<header><strong>Load Runner Control</strong> <span class="small" id="status"></span></header>
<main>
<div class="panel">
<div class="group">
<h3>1) Required First</h3>
<div class="hint">Set these first for browser/hybrid modes.</div>
<label>Mode</label><select id="testMode"><option value="headed">headed test</option><option value="headless" selected>headless test</option><option value="hybrid">hybrid (browser + k6)</option><option value="k6">k6 test</option></select>
<label>Register URL</label><input id="registerUrl" placeholder="https://.../student/<scheduleId>/register" />
<label>Users File</label><input id="usersFile" value="e2e/prod-load/live-users.500.csv" />
<div class="warn" id="requiredHint"></div>
</div>
<div class="group">
<h3>2) Run Size</h3>
<div class="row"><div style="flex:1"><label>User Count</label><input id="userCount" value="100"/></div><div style="flex:1"><label>User Offset</label><input id="userOffset" value="0"/></div></div>
<div class="row"><div style="flex:1"><label>Headed Users</label><input id="headedUsers" value="3"/></div><div style="flex:1"><label>Max Concurrent</label><input id="maxConcurrent" value="10"/></div></div>
</div>
<div class="group">
<h3>3) Preview Quality</h3>
<div class="row"><div style="flex:1"><label>Live Mode</label><input id="liveMode" value="balanced"/></div><div style="flex:1"><label>Dashboard Port (internal)</label><input id="dashboardPort" value="3360"/></div></div>
<div class="row"><div style="flex:1"><label>Screenshot ms</label><input id="screenshotMs" value="1000"/></div><div style="flex:1"><label>JPEG Quality</label><input id="jpegQuality" value="45"/></div></div>
</div>
<div class="group">
<h3>4) Optional k6</h3>
<label>k6 Base URL</label><input id="k6BaseUrl" placeholder="https://your-host"/>
<div class="row"><div style="flex:1"><label>K6 Script</label><input id="k6Script" value="k6/prod-start-exam-200.js"/></div><div style="flex:1"><label>K6 Students</label><input id="k6Students" value="100"/></div></div>
</div>
<label><input type="checkbox" id="deleteAfterFinish" checked/> Delete artifacts after finish</label>
<div class="row"><button id="startBtn">Start</button><button class="stop" id="stopBtn">Stop</button></div>
<label>Logs</label><pre id="logs"></pre>
</div>
<div class="panel"><div class="small" id="dashLabel">Dashboard (proxied): /dashboard</div><iframe id="dash" src="/dashboard"></iframe></div>
</main>
<script>
const statusEl=document.getElementById('status'); const logsEl=document.getElementById('logs'); const startBtn=document.getElementById('startBtn');
const requiredHint=document.getElementById('requiredHint');
const v=(id)=>document.getElementById(id).value; const c=(id)=>document.getElementById(id).checked;
async function refresh(){ const r=await fetch('/api/state'); const s=await r.json(); statusEl.textContent=s.running?'RUNNING':'IDLE'; }
function validateForm(){
  const mode=v('testMode');
  const registerUrl=v('registerUrl').trim();
  const usersFile=v('usersFile').trim();
  if(mode==='k6'){ requiredHint.textContent='k6 mode: Register URL and Users File are optional.'; startBtn.disabled=false; return; }
  if(!registerUrl || !usersFile){ requiredHint.textContent='Required first: Register URL + Users File.'; startBtn.disabled=true; return; }
  requiredHint.textContent='Ready to start.';
  startBtn.disabled=false;
}

document.getElementById('startBtn').onclick=async()=>{ const payload={registerUrl:v('registerUrl'),usersFile:v('usersFile'),testMode:v('testMode'),userCount:Number(v('userCount')),userOffset:Number(v('userOffset')),headedUsers:Number(v('headedUsers')),maxConcurrentUsers:Number(v('maxConcurrent')),dashboardPort:Number(v('dashboardPort')),liveMode:v('liveMode'),screenshotMs:Number(v('screenshotMs')),jpegQuality:Number(v('jpegQuality')),k6BaseUrl:v('k6BaseUrl'),k6Script:v('k6Script'),k6Students:Number(v('k6Students')),deleteAfterFinish:c('deleteAfterFinish')}; const resp=await fetch('/api/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)}); const data=await resp.json().catch(()=>({})); if(!resp.ok){ alert(data.error||('Start failed: HTTP '+resp.status)); return; } alert('Started'); await refresh(); };
document.getElementById('stopBtn').onclick=async()=>{ await fetch('/api/stop',{method:'POST'}); await refresh(); };
['testMode','registerUrl','usersFile'].forEach((id)=>document.getElementById(id).addEventListener('input',validateForm));
const es=new EventSource('/api/logs'); es.onmessage=(e)=>{ const m=JSON.parse(e.data); logsEl.textContent+=m.line+'\\n'; logsEl.scrollTop=logsEl.scrollHeight;};
validateForm();
refresh(); setInterval(refresh,3000);
</script></body></html>`);
});

app.get('/dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"/><title>Live Runner</title>
<style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:ui-sans-serif,system-ui}header{position:sticky;top:0;padding:10px 14px;background:#020617;border-bottom:1px solid #1e293b}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;padding:10px}.card{background:#020617;border:1px solid #1e293b;border-radius:8px;overflow:hidden}.meta{display:flex;justify-content:space-between;font-size:12px;padding:6px 8px;border-bottom:1px solid #1e293b}.err{color:#fca5a5}img{display:block;width:100%;background:#111827;aspect-ratio:16/9}</style>
</head><body><header><strong>Live Exam Runner</strong> <span id="count"></span></header><div id="grid"></div>
<script>
const grid=document.getElementById('grid');const count=document.getElementById('count');const cards=new Map();
function upsert(m){let c=cards.get(m.userId);if(!c){c=document.createElement('div');c.className='card';c.innerHTML='<div class="meta"><span class="u"></span><span class="s"></span></div><div class="meta"><span class="p"></span><span class="t"></span></div><div class="meta err"></div><img/>';cards.set(m.userId,c);grid.appendChild(c);}c.querySelector('.u').textContent='User '+m.userId;c.querySelector('.s').textContent=m.status||'';c.querySelector('.p').textContent=m.phase||'';c.querySelector('.t').textContent=m.lastSeenAt?new Date(m.lastSeenAt).toLocaleTimeString():'';c.querySelector('.err').textContent=m.error||'';if(m.imageBase64){c.querySelector('img').src='data:image/jpeg;base64,'+m.imageBase64;}count.textContent='— '+cards.size+' users';}
const es=new EventSource('/api/live-events');es.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==='snapshot'){for(const item of m.events||[]) upsert(item);}if(m.type==='event'&&m.event) upsert(m.event);};
</script></body></html>`);
});

app.get('/api/state', (_req, res) => res.json(state));
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  sseClients.add(res);
  for (const line of logLines.slice(-400)) res.write(`data: ${JSON.stringify({ line })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/live-events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  dashboardSseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', events: Array.from(liveCards.values()) })}\n\n`);
  req.on('close', () => dashboardSseClients.delete(res));
});

app.post('/api/live-event', (req, res) => {
  const token = req.get('x-live-event-token');
  if (token !== liveEventToken) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  pushDashboardEvent(req.body || {});
  res.json({ ok: true });
});

app.post('/api/start', (req, res) => {
  pushLog(`[api/start] payload=${JSON.stringify(req.body || {})}`);
  if (proc) return res.status(409).json({ error: 'already running' });
  const b = req.body || {};
  const mode = String(b.testMode || 'headless');
  const dashboardPort = Number(b.dashboardPort || 3360);
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const wantsHeaded = mode === 'headed' || Number(b.headedUsers || 0) > 0;
  const env = {
    ...process.env,
    REGISTER_URL: String(b.registerUrl || ''),
    USERS_FILE: String(b.usersFile || ''),
    USER_COUNT: String(b.userCount || 100),
    USER_OFFSET: String(b.userOffset || 0),
    HEADED_USERS: String(b.headedUsers || 0),
    MAX_CONCURRENT_USERS: String(b.maxConcurrentUsers || 10),
    DASHBOARD_PORT: String(dashboardPort),
    LIVE_MODE: String(b.liveMode || 'balanced'),
    SCREENSHOT_INTERVAL_MS: String(b.screenshotMs || 1000),
    JPEG_QUALITY: String(b.jpegQuality || 45),
    HEADLESS: mode === 'headed' ? 'false' : 'true',
    DELETE_ARTIFACTS_ON_FINISH: b.deleteAfterFinish ? 'true' : 'false',
    K6_CONFIRM_PROD: 'true',
    K6_SCRIPT: String(b.k6Script || 'k6/prod-start-exam-200.js'),
    K6_STUDENTS: String(b.k6Students || b.userCount || 100),
    K6_BASE_URL: String(b.k6BaseUrl || ''),
    LIVE_EVENT_ENDPOINT: `http://127.0.0.1:${port}/api/live-event`,
    LIVE_EVENT_TOKEN: liveEventToken,
  };

  if (mode !== 'k6') {
    if (!env.REGISTER_URL) return res.status(400).json({ error: 'REGISTER_URL is required.' });
    if (!env.USERS_FILE) return res.status(400).json({ error: 'USERS_FILE is required.' });
  }

  if (mode === 'headless') env.HEADED_USERS = '0';
  if (mode === 'headed') env.HEADED_USERS = String(Math.max(1, Number(env.HEADED_USERS || '1')));
  if (!hasDisplay && wantsHeaded && mode !== 'k6') {
    const requestedConcurrent = Math.max(1, Number(env.MAX_CONCURRENT_USERS || '10'));
    const safeConcurrent = Number(process.env.HEADED_SAFE_MAX_CONCURRENT || 10);
    if (requestedConcurrent > safeConcurrent) {
      pushLog(
        `[warn] Headed concurrency ${requestedConcurrent} is too high for no-display runtime; capping MAX_CONCURRENT_USERS=${safeConcurrent}.`,
      );
      env.MAX_CONCURRENT_USERS = String(safeConcurrent);
    }
  }

  let cmd = ['npm', 'run', 'e2e:live-runner'];
  if (mode === 'hybrid') cmd = ['npm', 'run', 'e2e:live-with-k6'];
  if (mode === 'k6') cmd = ['k6', 'run', env.K6_SCRIPT];
  if (!hasDisplay && wantsHeaded && mode !== 'k6') {
    const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
    if (probe.error) {
      return res.status(500).json({
        error:
          'Headed mode requires an X server. xvfb-run is not available in this runtime; install xvfb or switch to headless mode.',
      });
    }
    pushLog('[info] No DISPLAY found; running headed browser under xvfb-run virtual display.');
    cmd = ['xvfb-run', '-a', '--server-args=-screen 0 1920x1080x24', ...cmd];
  }

  liveCards.clear();

  try {
    proc = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushLog(`[spawn-error] ${msg}`);
    return res.status(500).json({ error: msg });
  }

  state = { ...state, running: true, startedAt: new Date().toISOString(), endedAt: null, exitCode: null, dashboardPort, deleteAfterFinish: !!b.deleteAfterFinish };
  pushLog(`[start] ${cmd.join(' ')}`);
  proc.stdout.on('data', (d) => pushLog(d.toString()));
  proc.stderr.on('data', (d) => pushLog(`[stderr] ${d.toString()}`));
  proc.on('exit', (code) => {
    state = { ...state, running: false, endedAt: new Date().toISOString(), exitCode: code ?? 0 };
    pushLog(`[exit] code=${code ?? 0}`);
    proc = null;
    if (state.deleteAfterFinish) cleanupGeneratedArtifacts();
  });

  res.json({ ok: true });
});

app.post('/api/stop', (_req, res) => {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch {}
  }
  res.json({ ok: true });
});

app.listen(port, host, () => {
  console.log(`[load-runner-ui] http://${host}:${port}`);
});
