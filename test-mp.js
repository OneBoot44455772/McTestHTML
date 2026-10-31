'use strict';
/* 联机协议回归测试：node test-mp.js  （需先启动 server.js） */
const WebSocket = require('ws');

const URL = 'ws://127.0.0.1:' + (process.env.PORT || 3000) + '/ws';
const results = [];
let failures = 0;

function check(name, ok, extra) {
  results.push((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '  → ' + extra : ''));
  if (!ok) failures++;
}

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const box = { ws, name, inbox: [], waiters: [] };
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      const i = box.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) { const w = box.waiters.splice(i, 1)[0]; clearTimeout(w.timer); w.res(m); }
      else box.inbox.push(m);
    });
    ws.on('open', () => resolve(box));
    ws.on('error', reject);
  });
}

function waitFor(box, pred, ms) {
  const found = box.inbox.findIndex(pred);
  if (found >= 0) return Promise.resolve(box.inbox.splice(found, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(box.name + ' 等待超时')), ms || 1500);
    box.waiters.push({ pred, res: resolve, timer });
  });
}

(async () => {
  // 1. A 加入
  const A = await client('A');
  A.ws.send(JSON.stringify({ t: 'join', name: '<b>Alice</b>' }));
  const wA = await waitFor(A, (m) => m.t === 'welcome');
  check('A 收到 welcome', !!wA.id);
  check('昵称已过滤 HTML 标签', wA.name === 'bAlice/b', JSON.stringify(wA.name));
  check('welcome 带颜色', typeof wA.color === 'number', String(wA.color));
  check('初始无人在线', Array.isArray(wA.players) && wA.players.length === 0, String(wA.players.length));

  // 2. B 加入，A 收到广播
  const B = await client('B');
  B.ws.send(JSON.stringify({ t: 'join', name: 'Bob' }));
  const wB = await waitFor(B, (m) => m.t === 'welcome');
  check('B 收到 welcome 且看到 A', wB.players.length === 1 && wB.players[0].id === wA.id);
  const jA = await waitFor(A, (m) => m.t === 'join');
  check('A 收到 B 的 join 广播', jA.player.name === 'Bob');

  // 3. B 移动 → A 收到 state
  B.ws.send(JSON.stringify({ t: 'state', x: 12.345, y: 30, z: -4, yaw: 1.2345, pitch: 0.5 }));
  const sA = await waitFor(A, (m) => m.t === 'state');
  check('A 收到 B 的位置', sA.id === wB.id && Math.abs(sA.x - 12.35) < 0.01, JSON.stringify(sA));

  // 4. B 改方块 → A 收到 edit
  B.ws.send(JSON.stringify({ t: 'edit', x: 80, y: 33, z: 81, b: 8 }));
  const eA = await waitFor(A, (m) => m.t === 'edit');
  check('A 收到方块编辑', eA.x === 80 && eA.y === 33 && eA.b === 8);

  // 5. 非法编辑被丢弃
  B.ws.send(JSON.stringify({ t: 'edit', x: 999, y: 33, z: 1, b: 8 }));
  B.ws.send(JSON.stringify({ t: 'edit', x: 1, y: 33, z: 1, b: 99 }));
  await new Promise((r) => setTimeout(r, 200));
  check('越界/非法方块被服务端丢弃', !A.inbox.some((m) => m.t === 'edit'));

  // 6. 聊天
  B.ws.send(JSON.stringify({ t: 'chat', text: 'hello <script>x</script>' }));
  const cA = await waitFor(A, (m) => m.t === 'chat');
  check('A 收到聊天并过滤标签', cA.text.indexOf('<') === -1 && cA.name === 'Bob', JSON.stringify(cA.text));

  // 7. 新客户端 C 加入应拿到编辑历史
  const C = await client('C');
  C.ws.send(JSON.stringify({ t: 'join', name: 'Carol' }));
  const wC = await waitFor(C, (m) => m.t === 'welcome');
  check('C 收到历史编辑', wC.edits.some((e) => e[0] === 80 && e[1] === 33 && e[2] === 81 && e[3] === 8), JSON.stringify(wC.edits).slice(0, 80));
  check('C 看到 2 位在线玩家', wC.players.length === 2, String(wC.players.length));

  // 8. B 离开 → A/C 收到 leave
  B.ws.close();
  const lA = await waitFor(A, (m) => m.t === 'leave');
  check('B 断开后广播 leave', lA.id === wB.id);

  // 9. 未 join 就发 state 应被忽略
  const D = await client('D');
  D.ws.send(JSON.stringify({ t: 'state', x: 1, y: 2, z: 3 }));
  await new Promise((r) => setTimeout(r, 200));
  check('未 join 的连接不能发位置', !A.inbox.some((m) => m.t === 'state' && m.x === 1));

  A.ws.close(); C.ws.close(); D.ws.close();

  console.log(results.join('\n'));
  console.log(failures ? `\n✗ ${failures} 项失败` : '\n✓ 全部通过');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log(results.join('\n'));
  console.error('\n测试异常:', e.message);
  process.exit(1);
});
