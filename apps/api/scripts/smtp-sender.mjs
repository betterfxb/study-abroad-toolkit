/**
 * 邮件渠道的外部发信器（gateway 不内置 SMTP 客户端，见 notifications.service.ts 注释）。
 *
 * 职责：轮询 subscription_deliveries 中 channel='email' 且 status='pending' 的记录，
 *   按 (subscription_id, created_at) 聚合成**每批一封** digest（网关一次执行会按岗位
 *   逐行落库、各行共享同一 payload，逐行发信会把一封汇总拆成 N 封重复邮件），
 *   SMTP 发送成功后整批标 sent、失败标 failed。
 *   failed 不自动重试——错误多为凭据/网络级，盲目重试只会打爆信箱；
 *   运维处理后手工 UPDATE status='pending' 即可重新入队。
 *
 * 零第三方依赖：SMTP 协议直接走 node:net / node:tls（AUTH LOGIN / AUTH PLAIN，
 *   支持隐式 TLS(465) / STARTTLS(587) / 明文(仅本地联调)）。
 *
 * 配置（env；缺任一关键项直接报错退出，绝不静默降级——对齐 CLAUDE §六「S3 快速失败」口径）：
 *   DB_PATH             与网关同一个库文件
 *   SMTP_HOST / SMTP_PORT
 *   SMTP_SECURE         1=隐式TLS(465) / starttls=升级(587) / 0=明文；缺省按端口推断
 *   SMTP_USER / SMTP_PASS / SMTP_FROM（可带显示名，如 '留学生助手 <bot@example.com>'）
 *   MAILER_INTERVAL_MS  常驻轮询间隔，默认 60000
 *
 * 用法：
 *   node scripts/smtp-sender.mjs --once    # 单轮（适合挂系统计划任务）
 *   node scripts/smtp-sender.mjs           # 常驻循环
 *
 * 与网关并发安全：node:sqlite 写锁互斥 + busy_timeout 5s；本程序只 UPDATE 已入库
 *   记录的 status/error/sent_at 三列（网关只 INSERT 或改写非 email 行），无业务竞态。
 */

import { DatabaseSync } from 'node:sqlite';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ------------------------------------------------------------------ 纯函数（可单测）

/** RFC 5321 点 Stuffing：正文行首单个 '.' 须翻倍（base64 传输下为语义兜底） */
export function dotStuff(text) {
  return text.replace(/^\./gm, '..');
}

/** RFC 2047 编码字（UTF-8 Base64），中文主题/显示名用；纯 ASCII 原样返回 */
export function encWord(s) {
  if ([...s].every((c) => c >= ' ' && c <= '~')) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** pending 行聚合成批：同订阅 + 同 created_at（同一次执行写入）= 同一封 digest */
export function groupPending(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.subscription_id}|${r.created_at}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return [...map.values()];
}

/** 渲染 digest 正文（纯文本）；payload 坏数据兜底为空列表，不让一行错误卡住整批 */
export function renderDigest(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || '{}');
  } catch { /* 坏 JSON 按空列表 */ }
  const items = Array.isArray(payload.items) ? payload.items : [];
  const lines = [
    `你在订阅「${row.subscription_name || '岗位订阅'}」中关注的岗位有 ${items.length} 条新匹配：`,
    '',
  ];
  for (const it of items) {
    lines.push(
      `· ${it.company || '—'}　${it.title || '—'}（${it.city || '—'}）`,
      `  薪资：${it.salary || '面议'}　学历：${it.education_req || '—'}　截止：${it.deadline || '—'}`,
      `  匹配度：${Math.round((it.score ?? 0) * 100)}%　${it.reason || ''}`,
      `  原文：${it.url || '—'}`,
      '',
    );
  }
  lines.push('—— 本邮件由「留学生助手」岗位订阅自动发出，回复无效。');
  return lines.join('\n');
}

function formatFrom(from) {
  const m = /^([^<]+?)\s*<([^>]+)>$/.exec(from.trim());
  return m ? `${encWord(m[1].trim())} <${m[2]}>` : `<${from}>`;
}

/** 组装完整邮件。正文 base64 传输，规避 8BIT/引号类编码争议；末尾含 DATA 结束点行 */
export function buildMessage({ from, to, subject, text }) {
  const headers = [
    `From: ${formatFrom(from)}`,
    `To: <${to}>`,
    `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = dotStuff(text).replace(/\r?\n/g, '\r\n');
  const b64 = Buffer.from(body, 'utf8').toString('base64').replace(/(.{1,76})/g, '$1\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${b64}\r\n.`;
}

// ------------------------------------------------------------------ SMTP 客户端

/**
 * 发送一封邮件。返回 { ok, error? }。
 * mode：'1'/1=隐式TLS(465)；'starttls'=明文连接升级TLS(587)；'0'/0=明文（本地/测试）。
 * 命令-应答严格配对：每步校验期望码，非期望立即失败并带服务器原文。
 */
export function smtpSend({ host, port, mode, user, pass, from, to, subject, text, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    let finished = false;
    const settle = (ok, error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch { /* ignore */ }
      resolve({ ok, error });
    };

    let sock = null;
    let buf = Buffer.alloc(0);
    let cont = []; // 多行应答的 'NNN-' 延续行（EHLO 能力列表在延续行里）
    let queue = null; // { expect, resolve }
    let timer = null;

    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(false, `SMTP 超时（${timeoutMs}ms 无响应）`), timeoutMs);
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) return;
        const line = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 2);
        if (/^[0-9]{3}-/.test(line)) { cont.push(line); continue; }
        if (!/^[0-9]{3} /.test(line)) continue;
        const full = [...cont, line].join(' | ');
        cont = [];
        if (queue) {
          const q = queue;
          queue = null;
          if (q.expect && !line.startsWith(q.expect)) {
            settle(false, `SMTP 应答异常：${full}（期望 ${q.expect}）`);
            return;
          }
          q.resolve(full);
        }
      }
    };

    const send = (payload, expect) => new Promise((res, rej) => {
      if (finished) return rej(new Error('closed'));
      queue = { expect, resolve: res };
      arm();
      sock.write(payload + '\r\n');
    });
    const awaitGreeting = () => new Promise((res) => {
      queue = { expect: '220', resolve: res };
      arm();
    });

    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    const addr = /<([^>]+)>/.exec(from)?.[1] || String(from).trim();

    const run = async () => {
      await awaitGreeting();
      let ehlo = await send('EHLO mailer', '250');

      if (mode === 'starttls') {
        await send('STARTTLS', '220');
        sock = await new Promise((res, rej) => {
          const s = tls.connect({ socket: sock, servername: host }, () => res(s));
          s.once('error', rej);
        });
        buf = Buffer.alloc(0); cont = [];
        sock.on('data', onData);
        ehlo = await send('EHLO mailer', '250');
      }

      if (user) {
        if (/AUTH[^\r\n|]*LOGIN/i.test(ehlo)) {
          await send('AUTH LOGIN', '331');
          await send(b64(user), '331');
          await send(b64(pass), '235');
        } else if (/AUTH[^\r\n|]*PLAIN/i.test(ehlo)) {
          await send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, '235');
        } else {
          return settle(false, 'SMTP 服务器未提供 AUTH LOGIN/PLAIN 能力');
        }
      }

      await send(`MAIL FROM:<${addr}>`, '250');
      await send(`RCPT TO:<${to}>`, '250');
      await send('DATA', '354');
      await send(buildMessage({ from, to, subject, text }), '250'); // 以 \r\n.\r\n 结束
      try { await send('QUIT', '221'); } catch { /* 收尾失败不影响投递结果 */ }
      settle(true);
    };

    const secure = mode === '1' || mode === 1;
    sock = secure
      ? tls.connect({ host, port, servername: host })
      : net.createConnection({ host, port });
    sock.once('error', (e) => settle(false, `连接失败：${e.message}`));
    const start = () => {
      sock.on('data', onData);
      run().catch((e) => settle(false, e?.message || String(e)));
    };
    if (secure) sock.once('secureConnect', start);
    else sock.once('connect', start);
  });
}

// ------------------------------------------------------------------ 消费循环

/** 查 pending → 聚合 → 逐批发送 → 回写状态。返回 { scanned, batches, sent, failed } */
export async function drainPendingOnce({ db, smtp, log = () => {} }) {
  const rows = db.prepare(
    `SELECT d.id, d.subscription_id, d.user_id, d.created_at, d.title, d.payload,
            u.email AS user_email, s.name AS subscription_name
       FROM subscription_deliveries d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN subscriptions s ON s.id = d.subscription_id
      WHERE d.channel = 'email' AND d.status = 'pending'
      ORDER BY d.created_at, d.id`,
  ).all();

  const batches = groupPending(rows);
  let sent = 0;
  let failed = 0;
  for (const batch of batches) {
    const row = batch[0];
    const subject = row.title || '岗位订阅更新';
    const r = await smtpSend({ ...smtp, to: row.user_email, subject, text: renderDigest(row) });
    const ids = batch.map((b) => b.id);
    const ph = ids.map(() => '?').join(',');
    if (r.ok) {
      db.prepare(`UPDATE subscription_deliveries SET status='sent', sent_at=? WHERE id IN (${ph})`)
        .run(new Date().toISOString(), ...ids);
      sent += ids.length;
      log(`已发送 #${ids.join(',')} → ${row.user_email}（${subject}）`);
    } else {
      const err = String(r.error || '发送失败').slice(0, 200);
      db.prepare(`UPDATE subscription_deliveries SET status='failed', error=? WHERE id IN (${ph})`)
        .run(err, ...ids);
      failed += ids.length;
      log(`发送失败 #${ids.join(',')}：${err}`);
    }
  }
  return { scanned: rows.length, batches: batches.length, sent, failed };
}

/** env → 配置；缺关键项抛错（快速失败，不静默不降级） */
export function configFromEnv(env = process.env) {
  const need = ['DB_PATH', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`缺少配置：${missing.join(' / ')}`);
  const mode = env.SMTP_SECURE
    || (Number(env.SMTP_PORT) === 465 ? '1' : Number(env.SMTP_PORT) === 587 ? 'starttls' : 'starttls');
  return {
    dbPath: env.DB_PATH,
    smtp: {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT),
      mode,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    },
    intervalMs: Number(env.MAILER_INTERVAL_MS || 60000),
  };
}

// ------------------------------------------------------------------ CLI

function main() {
  const cfg = configFromEnv();
  const db = new DatabaseSync(cfg.dbPath);
  db.exec('PRAGMA busy_timeout = 5000;');
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

  let stop = false;
  process.on('SIGTERM', () => { stop = true; });
  process.on('SIGINT', () => { stop = true; });

  const tick = async () => {
    const r = await drainPendingOnce({ db, smtp: cfg.smtp, log });
    if (r.scanned) log(`本轮：${r.batches} 批，发出 ${r.sent} 条记录，失败 ${r.failed} 条`);
  };

  if (process.argv.includes('--once')) {
    tick().then(() => db.close()).catch((e) => { console.error(e?.message || e); process.exit(1); });
    return;
  }
  const loop = async () => {
    while (!stop) {
      try { await tick(); } catch (e) { log(`轮询异常：${e?.message || e}`); }
      await new Promise((r) => setTimeout(r, cfg.intervalMs));
    }
    db.close();
  };
  log('外部发信器启动');
  loop();
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) main();
