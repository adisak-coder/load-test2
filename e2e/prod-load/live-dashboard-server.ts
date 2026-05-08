import express from 'express';
import { WebSocketServer } from 'ws';

export interface DashboardEvent {
  userId: string;
  status: string;
  phase: string;
  imageBase64?: string;
  lastSeenAt: string;
  error?: string;
  metrics?: Record<string, number | string | boolean | null>;
  comparison?: {
    submissionId?: string;
    writingProof?: string;
    botAnswersProof?: string;
    sameCount?: number;
    diffCount?: number;
  };
}

export function startLiveDashboardServer(port: number): { broadcast: (event: DashboardEvent) => void } {
  const app = express();

  app.get('/', (_req, res) => {
    res.send(`<!doctype html><html><head><meta charset=\"utf-8\"/><title>Live Runner</title>
<style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:ui-sans-serif,system-ui}header{position:sticky;top:0;padding:10px 14px;background:#020617;border-bottom:1px solid #1e293b}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;padding:10px}.card{background:#020617;border:1px solid #1e293b;border-radius:8px;overflow:hidden}.meta{display:flex;justify-content:space-between;font-size:12px;padding:6px 8px;border-bottom:1px solid #1e293b}.err{color:#fca5a5}.cmp{border-top:1px solid #1e293b;padding:6px 8px;font-size:11px}.cmp summary{cursor:pointer;color:#93c5fd}.cmp pre{margin:6px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#cbd5e1;background:#0f172a;border:1px solid #1e293b;border-radius:6px;padding:6px}.bot summary{color:#86efac}img{display:block;width:100%;background:#111827;aspect-ratio:16/9}</style>
</head><body><header><strong>Live Exam Runner</strong> <span id=\"count\"></span></header><div id=\"grid\"></div>
<script>const ws=new WebSocket('ws://'+location.host);const grid=document.getElementById('grid');const count=document.getElementById('count');const cards=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);let c=cards.get(m.userId);if(!c){c=document.createElement('div');c.className='card';c.innerHTML='<div class=\"meta\"><span class=\"u\"></span><span class=\"s\"></span></div><div class=\"meta\"><span class=\"p\"></span><span class=\"t\"></span></div><div class=\"meta err\"></div><details class=\"cmp bot\"><summary>Bot Answers</summary><pre></pre></details><details class=\"cmp\"><summary>Writing Compare (same=- diff=-)</summary><pre></pre></details><img/>';cards.set(m.userId,c);grid.appendChild(c);}c.querySelector('.u').textContent='User '+m.userId;c.querySelector('.s').textContent=m.status;c.querySelector('.p').textContent=m.phase;c.querySelector('.t').textContent=new Date(m.lastSeenAt).toLocaleTimeString();c.querySelector('.err').textContent=m.error||'';const botCmp=c.querySelector('.cmp.bot');const botPre=c.querySelector('.cmp.bot pre');if(m.comparison&&m.comparison.botAnswersProof){botCmp.style.display='block';botPre.textContent=m.comparison.botAnswersProof;}else{botCmp.style.display='none';botPre.textContent='';}const cmp=c.querySelector('.cmp:not(.bot)');const cmpSummary=cmp.querySelector('summary');const cmpPre=c.querySelector('.cmp:not(.bot) pre');const same=m.comparison&&typeof m.comparison.sameCount==='number'?m.comparison.sameCount:'-';const diff=m.comparison&&typeof m.comparison.diffCount==='number'?m.comparison.diffCount:'-';cmpSummary.textContent='Writing Compare (same='+same+' diff='+diff+')';if(m.comparison&&m.comparison.writingProof){cmp.style.display='block';cmpPre.textContent=(m.comparison.submissionId?('submissionId: '+m.comparison.submissionId+'\\n\\n'):'')+m.comparison.writingProof;}else{cmp.style.display='none';cmpPre.textContent='';}if(m.imageBase64){c.querySelector('img').src='data:image/jpeg;base64,'+m.imageBase64;}count.textContent='— '+cards.size+' users';};</script></body></html>`);
  });

  const server = app.listen(port, () => {
    console.log(`[live-dashboard] http://localhost:${port}`);
  });
  const wss = new WebSocketServer({ server });
  const lastByUser = new Map<string, DashboardEvent>();

  wss.on('connection', (socket) => {
    for (const event of lastByUser.values()) {
      socket.send(JSON.stringify(event));
    }
  });

  const broadcast = (event: DashboardEvent) => {
    const prev = lastByUser.get(event.userId);
    const merged: DashboardEvent = {
      ...(prev ?? {}),
      ...event,
      ...(event.imageBase64 ? { imageBase64: event.imageBase64 } : prev?.imageBase64 ? { imageBase64: prev.imageBase64 } : {}),
    } as DashboardEvent;
    lastByUser.set(event.userId, merged);
    const payload = JSON.stringify(merged);
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  };

  return { broadcast };
}
