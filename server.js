'use strict';
/* 方块世界 · 联机服务端
 * 用法：node server.js  （默认 3000 端口，可用 PORT=8080 node server.js 改）
 * 依赖：ws（已在同目录 node_modules 中）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MAX_NAME = 14;
const MAX_CHAT = 120;
const MAX_EDIT_HISTORY = 20000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/* ---------------- 静态文件 ---------------- */
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (urlPath === '/api/players') {
    const list = [];
    for (const p of players.values()) list.push({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z });
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ online: list.length, players: list, edits: edits.size }));
  }

  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
});

/* ---------------- 世界状态 ---------------- */
let nextId = 1;
const players = new Map();          // id -> { id, ws, name, x, y, z, yaw, pitch, color }
const edits = new Map();            // "x,y,z" -> blockId

const COLORS = [0x3f7cc4, 0xc4553f, 0x3fa06a, 0xb08b3f, 0x8a4fc4, 0xc43f8f, 0x3fb3c4, 0xc4a33f];

function pub(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch };
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of players) {
    if (id !== exceptId && p.ws.readyState === 1) p.ws.send(data);
  }
}

function clean(str, max) {
  return String(str == null ? '' : str)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .trim()
    .slice(0, max);
}

/* ---------------- WebSocket ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const id = nextId++;
  const color = COLORS[id % COLORS.length];
  const self = { id, ws, name: '玩家' + id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, color };
  let joined = false;
  let lastMove = 0;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'join': {
        if (joined) return;
        joined = true;
        self.name = clean(m.name, MAX_NAME) || ('玩家' + id);
        const others = [];
        for (const p of players.values()) others.push(pub(p));
        players.set(id, self);

        send(ws, {
          t: 'welcome',
          id,
          name: self.name,
          color,
          players: others,
          edits: Array.from(edits, (kv) => {
            const c = kv[0].split(',');
            return [+c[0], +c[1], +c[2], kv[1]];
          })
        });
        broadcast({ t: 'join', player: pub(self) }, id);
        log(`${self.name} 加入（在线 ${players.size}）`);
        break;
      }

      case 'state': {
        if (!joined) return;
        const now = Date.now();
        if (now - lastMove < 35) return;          // 限流：约 28 条/秒
        lastMove = now;
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.z)) return;
        self.x = +m.x.toFixed(2); self.y = +m.y.toFixed(2); self.z = +m.z.toFixed(2);
        self.yaw = Number.isFinite(m.yaw) ? +m.yaw.toFixed(3) : 0;
        self.pitch = Number.isFinite(m.pitch) ? +m.pitch.toFixed(3) : 0;
        broadcast({ t: 'state', id, x: self.x, y: self.y, z: self.z, yaw: self.yaw, pitch: self.pitch }, id);
        break;
      }

      case 'edit': {
        if (!joined) return;
        const x = m.x | 0, y = m.y | 0, z = m.z | 0, b = m.b | 0;
        if (x < 0 || x >= 160 || z < 0 || z >= 160 || y < 0 || y >= 64) return;
        if (b < 0 || b > 8) return;
        const key = x + ',' + y + ',' + z;
        if (b === 0) edits.delete(key); else edits.set(key, b);
        if (edits.size > MAX_EDIT_HISTORY) {
          const first = edits.keys().next().value;
          edits.delete(first);
        }
        broadcast({ t: 'edit', x, y, z, b }, id);
        break;
      }

      case 'chat': {
        if (!joined) return;
        const text = clean(m.text, MAX_CHAT);
        if (!text) return;
        broadcast({ t: 'chat', id, name: self.name, text });
        log(`[聊天] ${self.name}: ${text}`);
        break;
      }

      case 'rename': {
        if (!joined) return;
        const name = clean(m.name, MAX_NAME);
        if (!name) return;
        self.name = name;
        broadcast({ t: 'rename', id, name });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (players.has(id)) {
      players.delete(id);
      broadcast({ t: 'leave', id });
      log(`${self.name} 离开（在线 ${players.size}）`);
    }
  });

  ws.on('error', () => {});
});

// 心跳，防止 NAT / 代理把空闲连接掐掉
const heartbeat = setInterval(() => {
  for (const p of players.values()) {
    if (p.ws.readyState === 1) p.ws.ping();
  }
}, 25000);

wss.on('close', () => clearInterval(heartbeat));

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}] ${msg}`);
}

server.listen(PORT, () => {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  console.log('==============================================');
  console.log('  方块世界 · 联机服务已启动');
  console.log(`  本机：   http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  局域网： http://${ip}:${PORT}`));
  console.log('  把上面的局域网地址发给朋友，同一 WiFi 就能进');
  console.log('  Ctrl+C 结束服务');
  console.log('==============================================');
});
