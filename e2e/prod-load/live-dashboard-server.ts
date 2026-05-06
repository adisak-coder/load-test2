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
}

export function startLiveDashboardServer(port: number): { broadcast: (event: DashboardEvent) => void } {
  const app = express();

  app.get('/', (_req, res) => {
    res.send(`<!doctype html><html><head><meta charset=\"utf-8\"/><title>Live Runner</title>
<style>body{margin:0;background:#0b1220;color:#e2e8f0;font-family:ui-sans-serif,system-ui}header{position:sticky;top:0;padding:10px 14px;background:#020617;border-bottom:1px solid #1e293b}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;padding:10px}.card{background:#020617;border:1px solid #1e293b;border-radius:8px;overflow:hidden}.meta{display:flex;justify-content:space-between;font-size:12px;padding:6px 8px;border-bottom:1px solid #1e293b}.err{color:#fca5a5}img{display:block;width:100%;background:#111827;aspect-ratio:16/9}</style>
</head><body><header><strong>Live Exam Runner</strong> <span id=\"count\"></span></header><div id=\"grid\"></div>
<script>const ws=new WebSocket('ws://'+location.host);const grid=document.getElementById('grid');const count=document.getElementById('count');const cards=new Map();ws.onmessage=(e)=>{const m=JSON.parse(e.data);let c=cards.get(m.userId);if(!c){c=document.createElement('div');c.className='card';c.innerHTML='<div class=\"meta\"><span class=\"u\"></span><span class=\"s\"></span></div><div class=\"meta\"><span class=\"p\"></span><span class=\"t\"></span></div><div class=\"meta err\"></div><img/>';cards.set(m.userId,c);grid.appendChild(c);}c.querySelector('.u').textContent='User '+m.userId;c.querySelector('.s').textContent=m.status;c.querySelector('.p').textContent=m.phase;c.querySelector('.t').textContent=new Date(m.lastSeenAt).toLocaleTimeString();c.querySelector('.err').textContent=m.error||'';if(m.imageBase64){c.querySelector('img').src='data:image/jpeg;base64,'+m.imageBase64;}count.textContent='— '+cards.size+' users';};</script></body></html>`);
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
