/**
 * 外部发信器（scripts/smtp-sender.mjs）测试：零第三方依赖。
 * - 纯函数：点 stuffing / RFC2047 / 聚合 / digest 渲染 / 邮件组装 / env 校验
 * - 集成：node:net 起 mock SMTP 服务器 + 临时 SQLite 库，真实跑通 pending → sent / failed
 *
 * 运行：node --experimental-sqlite test/smtp_sender.js（Node 22）
 */

import * as net from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
import {
  buildMessage, configFromEnv, dotStuff, encWord,
  drainPendingOnce, groupPending, renderDigest, smtpSend,
} from '../scripts/smtp-sender.mjs';

let pass = 0;
let fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e?.message || String(e) });
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '值不等'}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// ------------------------------------------------------------------ mock SMTP 服务器

/**
 * 极简 SMTP：EHLO（AUTH LOGIN）→ 331/235 → MAIL/RCPT/DATA → 收正文 → 221。
 * opts.badPass 时密码步回 535，用于失败分支。收到的每封邮件存入 mails[]。
 */
function startMockSmtp({ badPass = false } = {}) {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let mode = null; // 'data' 时收正文
    let dataLines = [];
    const send = (s) => sock.write(s + '\r\n');
    send('220 mock ESMTP');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (mode === 'data') {
          if (line === '.') {
            mails.push(dataLines.join('\r\n'));
            dataLines = [];
            mode = null;
            send('250 OK queued');
          } else {
            dataLines.push(line);
          }
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) send('250-mock\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME');
        else if (cmd === 'AUTH LOGIN') send('331 VXN');
        else if (cmd === 'QUIT') send('221 bye');
        else if (cmd.startsWith('MAIL FROM')) send('250 sender ok');
        else if (cmd.startsWith('RCPT TO')) send('250 rcpt ok');
        else if (cmd === 'DATA') { mode = 'data'; send('354 go'); }
        else if (mode === null && /^[A-Za-z0-9+/=]{4,}$/.test(line)) {
          // AUTH 的 base64 阶段：第一发用户名，第二发密码
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          if (decoded === 'u1') send('331 UGQ');
          else if (decoded === 'p1' && !badPass) send('235 ok');
          else send('535 5.7.8 Authentication failed');
        }
        else send('250 ignore');
      }
    });
    sock.on('error', () => { /* 客户端随时断开 */ });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      mails,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// ------------------------------------------------------------------ 临时库

const SCHEMA = `
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT DEFAULT '',
  nickname TEXT DEFAULT '', role TEXT DEFAULT 'user', created_at TEXT, updated_at TEXT);
CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, keywords TEXT DEFAULT '[]',
  cities TEXT DEFAULT '[]', education TEXT DEFAULT '', channel TEXT DEFAULT 'email', enabled INTEGER DEFAULT 1,
  require_all_keywords INTEGER DEFAULT 0, webhook_url TEXT DEFAULT '', last_run_at TEXT DEFAULT '',
  schedule TEXT DEFAULT '', next_run_at TEXT DEFAULT '', locked_at TEXT DEFAULT '', locked_by TEXT DEFAULT '',
  created_at TEXT, updated_at TEXT);
CREATE TABLE subscription_deliveries (id INTEGER PRIMARY KEY, subscription_id INTEGER, user_id INTEGER,
  job_id INTEGER, channel TEXT DEFAULT 'email', status TEXT DEFAULT 'pending', score REAL DEFAULT 0,
  title TEXT DEFAULT '', payload TEXT DEFAULT '{}', error TEXT DEFAULT '', created_at TEXT, sent_at TEXT DEFAULT '');
`;

function freshDb() {
  const p = join(tmpdir(), `mailer_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}.db`);
  const db = new DatabaseSync(p);
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO users(id, email, created_at, updated_at) VALUES (1, 'a@test.local', 'x', 'x'), (2, 'b@test.local', 'x', 'x');
    INSERT INTO subscriptions(id, user_id, name) VALUES (10, 1, '北京数据分析');
  `);
  return { db, p };
}

const payloadOf = (n) => JSON.stringify({
  subject: '【北京数据分析】为你找到 ' + n + ' 个新实习岗位',
  count: n,
  items: Array.from({ length: n }, (_, i) => ({
    id: i + 1, company: '字节跳动', title: '数据分析实习生', city: '北京',
    salary: '300/天', education_req: '本科', deadline: '2026-12-01',
    url: 'https://example.com/j/' + i, source: '校招内推君', score: 0.8 + i / 100, reason: '关键词全命中',
  })),
});

function seedBatch(db, { rows, createdAt = '2026-10-19T00:00:00.000Z', status = 'pending', channel = 'email' }) {
  const st = db.prepare(
    `INSERT INTO subscription_deliveries(subscription_id, user_id, job_id, channel, status, score, title, payload, error, created_at, sent_at)
     VALUES (10, 1, ?, ?, ?, 0.9, ?, ?, '', ?, '')`,
  );
  const ids = [];
  for (let i = 0; i < rows; i += 1) {
    const r = st.run(i + 1, channel, status, '【北京数据分析】为你找到 ' + rows + ' 个新实习岗位', payloadOf(rows), createdAt);
    ids.push(Number(r.lastInsertRowid));
  }
  return ids;
}

// ------------------------------------------------------------------ 套件

console.log('\n外部发信器（smtp-sender）\n');

await test('dotStuff：行首单点翻倍，其余不动', () => {
  eq(dotStuff('.hidden'), '..hidden');
  eq(dotStuff('a.b\n.bx'), 'a.b\n..bx');
});

await test('encWord：ASCII 原样，中文走 RFC2047 B 编码', () => {
  eq(encWord('Hello Jobs'), 'Hello Jobs');
  const enc = encWord('你好岗位');
  ok(enc.startsWith('=?UTF-8?B?') && enc.endsWith('?='), '应为编码字: ' + enc);
  eq(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8'), '你好岗位');
});

await test('groupPending：同订阅同刻聚为一批，异刻分桶', () => {
  const rows = [
    { subscription_id: 10, created_at: 't1' }, { subscription_id: 10, created_at: 't1' },
    { subscription_id: 10, created_at: 't2' }, { subscription_id: 11, created_at: 't1' },
  ];
  const g = groupPending(rows);
  eq(g.length, 3);
  eq(g[0].length, 2);
});

await test('renderDigest：岗位行完整，payload 坏 JSON 兜底空列表', () => {
  const good = renderDigest({ subscription_name: 'S', payload: payloadOf(2) });
  ok(good.includes('字节跳动') && good.includes('2 条新匹配'), '正文缺岗位信息');
  const bad = renderDigest({ subscription_name: 'S', payload: '{oops' });
  ok(bad.includes('0 条新匹配'), '坏 payload 应兜底');
});

await test('buildMessage：头齐全 + base64 正文可还原 + 结束点行', () => {
  const msg = buildMessage({ from: '留学生助手 <bot@example.com>', to: 'a@test.local', subject: '中文主题', text: '正文\r第二行' });
  const head = msg.split('\r\n\r\n')[0];
  ok(head.includes('Subject: =?UTF-8?B?'), '主题应编码');
  ok(head.includes('Content-Transfer-Encoding: base64'), '应 base64');
  const b64 = msg.split('\r\n\r\n')[1].replace('\r\n.', '').replace(/\r\n/g, '');
  ok(Buffer.from(b64, 'base64').toString('utf8').includes('正文'), '正文应可还原');
  ok(msg.endsWith('\r\n.'), 'DATA 应以点行结束');
});

await test('configFromEnv：缺项报错列出清单，端口推断 mode', () => {
  let err = '';
  try { configFromEnv({}); } catch (e) { err = e.message; }
  ok(err.includes('DB_PATH') && err.includes('SMTP_HOST'), '应列出缺失项: ' + err);
  const c = configFromEnv({ DB_PATH: 'x', SMTP_HOST: 'h', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f' });
  eq(c.smtp.mode, '1');
});

await test('smtpSend 全流程：mock 服务器收到完整邮件（AUTH→MAIL→RCPT→DATA）', async () => {
  const mock = await startMockSmtp();
  try {
    const r = await smtpSend({
      host: '127.0.0.1', port: mock.port, mode: '0',
      user: 'u1', pass: 'p1', from: 'bot@example.com', to: 'a@test.local',
      subject: '测试主题', text: '第一行\n.点开头行',
    });
    ok(r.ok, '应成功: ' + r.error);
    eq(mock.mails.length, 1);
    const mail = mock.mails[0];
    ok(mail.includes('To: <a@test.local>'), '收件人应在头里');
    const b64 = mail.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    ok(Buffer.from(b64, 'base64').toString('utf8').includes('.点开头行'), '正文应含原文');
  } finally { await mock.close(); }
});

await test('drainPendingOnce：一批 3 行 → 一封 digest，整批标 sent', async () => {
  const { db, p } = freshDb();
  const ids = seedBatch(db, { rows: 3 });
  const mock = await startMockSmtp();
  try {
    const r = await drainPendingOnce({
      db,
      smtp: { host: '127.0.0.1', port: mock.port, mode: '0', user: 'u1', pass: 'p1', from: 'bot@example.com' },
    });
    eq(r.batches, 1);
    eq(r.sent, 3);
    eq(mock.mails.length, 1, '一封邮件足矣（同批共享 payload）');
    const st = db.prepare('SELECT status, sent_at, error FROM subscription_deliveries WHERE id=?').get(ids[0]);
    eq(st.status, 'sent');
    ok(st.sent_at && !st.error, '应记 sent_at');
  } finally { await mock.close(); db.close(); unlinkSync(p); }
});

await test('drainPendingOnce：两批两封；非 email 渠道与非 pending 不动', async () => {
  const { db, p } = freshDb();
  seedBatch(db, { rows: 2, createdAt: '2026-10-19T00:00:00.000Z' });
  seedBatch(db, { rows: 1, createdAt: '2026-10-19T01:00:00.000Z' });
  const wid = seedBatch(db, { rows: 1, channel: 'webhook', createdAt: '2026-10-19T02:00:00.000Z' })[0];
  const mock = await startMockSmtp();
  try {
    const r = await drainPendingOnce({
      db,
      smtp: { host: '127.0.0.1', port: mock.port, mode: '0', user: 'u1', pass: 'p1', from: 'bot@example.com' },
    });
    eq(r.batches, 2, '两个 created_at 两批');
    eq(mock.mails.length, 2);
    const w = db.prepare('SELECT status FROM subscription_deliveries WHERE id=?').get(wid);
    eq(w.status, 'pending', 'webhook 行不应被 email 发信器处理');
  } finally { await mock.close(); db.close(); unlinkSync(p); }
});

await test('失败分支：AUTH 被拒 → 整批 failed + error；再跑不重复发', async () => {
  const { db, p } = freshDb();
  seedBatch(db, { rows: 2 });
  const mock = await startMockSmtp({ badPass: true });
  try {
    const r = await drainPendingOnce({
      db,
      smtp: { host: '127.0.0.1', port: mock.port, mode: '0', user: 'u1', pass: 'p1', from: 'bot@example.com' },
    });
    eq(r.failed, 2);
    eq(mock.mails.length, 0);
    const st = db.prepare('SELECT status, error FROM subscription_deliveries LIMIT 1').get();
    eq(st.status, 'failed');
    ok(/535|应答异常/.test(st.error), 'error 应带服务器原因: ' + st.error);
    const r2 = await drainPendingOnce({
      db,
      smtp: { host: '127.0.0.1', port: mock.port, mode: '0', user: 'u1', pass: 'p1', from: 'bot@example.com' },
    });
    eq(r2.scanned, 0, 'failed 不再自动重试');
  } finally { await mock.close(); db.close(); unlinkSync(p); }
});

await test('连接不可达：快速失败并落 error（不挂死）', async () => {
  const { db, p } = freshDb();
  seedBatch(db, { rows: 1 });
  const r = await drainPendingOnce({
    db,
    smtp: { host: '127.0.0.1', port: 1, mode: '0', user: '', pass: '', from: 'bot@example.com', timeoutMs: 3000 },
  });
  eq(r.failed, 1);
  db.close(); unlinkSync(p);
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('外部发信器测试全部通过 ✓');
