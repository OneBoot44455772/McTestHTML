'use strict';
/* 幽灵客户端：持续跟随浏览器玩家，站到他正前方 4 格（用于联机画面验证） */
const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 3000;
const URL = 'ws://127.0.0.1:' + PORT + '/ws';

function api() {
  return new Promise((resolve) => {
    http.get('http://127.0.0.1:' + PORT + '/api/players', (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  const ws = new WebSocket(URL);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'join', name: '小明' }));

  let me = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'welcome') me = m.id;
  });

  let last = '', tick = 0;
  let built = false;
  const timer = setInterval(async () => {
    const d = await api();
    if (!d || !d.players) return;
    const p = d.players.find((x) => x.id !== me && (x.x || x.z));
    if (!p) return;

    ws.send(JSON.stringify({ t: 'state', x: p.x, y: p.y, z: p.z - 4, yaw: Math.PI, pitch: 0 }));
    const tag = p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1);
    if (tag !== last) { last = tag; console.log('跟随玩家 →', tag); }

    tick++;
    if (tick === 9) ws.send(JSON.stringify({ t: 'chat', text: '大家好，我是小明，刚上线' }));
    if (tick === 17) ws.send(JSON.stringify({ t: 'chat', text: '这堵墙我搭的，来一起盖房子？' }));
    if (!built) {
      built = true;
      const bx = Math.round(p.x) - 3;
      const bz = Math.round(p.z) - 10;
      const by = Math.floor(p.y) - 1;
      let n = 0;
      for (let dy = 0; dy < 5; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          ws.send(JSON.stringify({ t: 'edit', x: bx + dx, y: by + dy, z: bz, b: 7 }));
          n++;
        }
      }
      console.log('砌墙', n, '块 @', bx, by, bz);
      ws.send(JSON.stringify({ t: 'chat', text: '大家好，我是小明，刚到这个世界' }));
    }
  }, 300);

  setTimeout(() => { clearInterval(timer); ws.close(); process.exit(0); }, 90000);
})();
