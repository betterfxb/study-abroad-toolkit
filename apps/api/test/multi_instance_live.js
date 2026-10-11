/**
 * 多实例调度互斥验证（**真实双进程 + 共享 SQLite 文件**）。
 *
 * 为什么需要这个测试：
 *   e2e.js 里对 `claimDue` 的断言是**同进程**内两个 SchedulerService 实例的比较，
 *   它证明了条件 UPDATE 的语义，但没有证明「两个真实进程各跑一个调度器时不会重复推送」。
 *   本脚本起两个网关进程、共用同一个 DB 文件、各自跑一个调度器，
 *   用本地 webhook 接收器计数来验证**恰好一次**。
 *
 * 断言：
 *   ① 两个网关都活着（排除「其实只有一个实例」的假象）；
 *   ② webhook 接收器**只收到 1 次**推送；
 *   ③ 两个实例的 tick 结果里，执行次数合计**恰好为 1**（另一个让出或根本没看到）。
 *
 * 前置：
 *   cd apps/api && npm run build        # 需要 dist/main.js
 *   cd apps/crawler && DATABASE_URL="sqlite+aiosqlite:///./dev.db" \
 *     python -m uvicorn app.main:app --port 8100     # 订阅需要真实岗位才能推送
 *
 * 运行： node --experimental-sqlite test/multi_instance_live.js
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const CRAWLER = process.env.CRAWLER_BASE || 'http://127.0.0.1:8100';
const JWT_SECRET = 'multi-instance-test-secret';
const TICK_MS = 5000;
/** 观察窗口：tick 每 5s 一次，窗口取 25s 保证两个实例各被采到多轮 */
const WAIT_MS = 25000;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) { passed += 1; console.log(`  [PASS] ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  [FAIL] ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言网关调用成功，失败时把原始响应打出来（多实例下可能是 SQLITE_BUSY 等瞬态错误） */
function checkApi(name, res) {
  const good = Boolean(res) && res.code === 0;
  check(name, good);
  if (!good) console.log(`      原始响应：${JSON.stringify(res).slice(0, 400)}`);
  return good;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function waitReady(port, ms = 30000) {
  // 端口反查实例 ID：调用点只需给端口，避免每个 waitReady 都要重复传实例名
  const instanceId = portToInstance.get(port);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // 进程已退出就不必再等，直接判失败（日志会在 finally 里打印）
    if (instanceId !== undefined && childExits.has(instanceId)) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  return false;
}

async function api(port, method, p, { body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** 子进程输出缓冲，就绪失败时打印出来便于定位 */
const childLogs = new Map();
/** 子进程退出码：instanceId -> { code, signal } */
const childExits = new Map();
/** 端口 -> 实例 ID，供 waitReady 反查进程存活状态 */
const portToInstance = new Map();

function startGateway(port, dbPath, instanceId) {
  const child = spawn(process.execPath, ['--experimental-sqlite', 'dist/main.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbPath,
      JWT_SECRET,
      CRAWLER_BASE: CRAWLER,
      SCHEDULER_INTERVAL_MS: String(TICK_MS),
      SCHEDULER_INSTANCE_ID: instanceId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const buf = [];
  childLogs.set(instanceId, buf);
  portToInstance.set(port, instanceId);
  const onData = (d) => {
    buf.push(String(d));
    if (buf.length > 300) buf.shift();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code, signal) => childExits.set(instanceId, { code, signal }));
  return child;
}

async function main() {
  console.log('='.repeat(64));
  console.log('多实例调度互斥验证（双进程 + 共享 SQLite）');
  console.log('='.repeat(64));

  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
    console.log('\n缺少 dist/main.js，请先执行： npm run build');
    process.exit(2);
  }

  // 0) 采集服务必须在线，否则订阅匹配不到岗位、推不出东西
  try {
    const h = await fetch(`${CRAWLER}/internal/health`);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
    console.log(`\n采集服务在线：${CRAWLER}`);
  } catch (e) {
    console.log(`\n采集服务不可用（${CRAWLER}）：${e.message}`);
    console.log('请先启动： cd apps/crawler && DATABASE_URL="sqlite+aiosqlite:///./dev.db" \\');
    console.log('             python -m uvicorn app.main:app --port 8100');
    console.log('\n跳过（退出码 0，不计为失败）');
    process.exit(0);
  }

  // 1) 准备隔离环境
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-multi-'));
  const dbPath = path.join(tmpDir, 'gateway.db');
  const [portA, portB, recvPort] = [await freePort(), await freePort(), await freePort()];
  console.log(`临时库：${dbPath}`);
  console.log(`实例 A：:${portA} · 实例 B：:${portB} · webhook 接收器：:${recvPort}`);

  const hits = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ at: Date.now(), body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => receiver.listen(recvPort, '127.0.0.1', r));

  const children = [
    startGateway(portA, dbPath, 'multi-inst-A'),
    startGateway(portB, dbPath, 'multi-inst-B'),
  ];

  try {
    const [okA, okB] = await Promise.all([waitReady(portA), waitReady(portB)]);
    check('实例 A 启动就绪', okA);
    check('实例 B 启动就绪', okB);
    if (!okA || !okB) {
      for (const id of ['multi-inst-A', 'multi-inst-B']) {
        console.log(`\n--- ${id} 输出 ---`);
        console.log((childLogs.get(id) || []).join('').slice(-2500) || '(无输出)');
      }
      throw new Error('网关未能就绪');
    }

    // 2) 注册用户 → 提权为管理员 → 重新登录拿 admin token
    const email = `multi-${Date.now()}@e2e.dev`;
    const reg = await api(portA, 'POST', '/api/v1/auth/register', {
      body: { email, password: 'Multi12345', nickname: '多实例' },
    });
    if (!checkApi('注册用户', reg)) throw new Error('注册失败，无法继续');

    const probe = new DatabaseSync(dbPath);
    probe.exec('PRAGMA busy_timeout = 5000;');
    probe.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
    probe.close();

    const login = await api(portA, 'POST', '/api/v1/auth/login', {
      body: { email, password: 'Multi12345' },
    });
    if (!checkApi('管理员登录成功', login)) throw new Error('登录失败，无法继续');
    const token = login.data.access_token;
    check('拿到管理员 token', typeof token === 'string' && token.length > 20);

    // 3) 建一条指向本地接收器的 webhook 订阅
    const sub = await api(portA, 'POST', '/api/v1/subscriptions', {
      token,
      body: {
        name: '多实例互斥探针',
        keywords: '实习',
        channel: 'webhook',
        webhook_url: `http://127.0.0.1:${recvPort}/hook`,
        schedule: 'every:1m',
      },
    });
    check('创建 webhook 订阅', sub.code === 0);
    const subId = sub.data.id;

    // 4) 强制置为「早已到期」——让两个实例的下一轮 tick 都会看到它
    const force = new DatabaseSync(dbPath);
    force.exec('PRAGMA busy_timeout = 5000;');
    force.prepare('UPDATE subscriptions SET next_run_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', subId);
    force.close();
    console.log('\n已将 next_run_at 置为过期，开始观察两个实例的 tick …');

    // 5) 轮询两个实例的调度状态，收集每一轮 tick 结果
    //
    // 注意：`last_result` 只保留最近一轮，会被下一轮覆盖，因此必须高频轮询（< tick 间隔）。
    // 提前退出条件是「两个实例都被采到 **且** 已发生推送」——只满足一个就继续等，
    // 否则可能在另一个实例的 tick 被观察到之前就退出，导致漏采。
    // key 用 `实例:时刻` —— 只按时刻会在 Windows 上撞车（系统时钟粒度约 15ms，
    // 两个同时启动的 setInterval 很容易落在同一毫秒，导致一方的 tick 被静默丢弃）
    const seen = new Map(); // `${instance}:${at}` -> { instance, scanned, ran, failed, skipped }
    /** 每个实例最近一次 status 快照：累计计数器用它断言，不受逐轮采样影响 */
    const snapshot = new Map();
    const collect = async () => {
      for (const [name, port] of [['A', portA], ['B', portB]]) {
        const st = await api(port, 'GET', '/api/v1/scheduler/status', { token });
        if (!st || st.code !== 0) {
          console.log(`  · 实例 ${name} status 查询失败：${JSON.stringify(st).slice(0, 200)}`);
          continue;
        }
        snapshot.set(name, st.data);
        const r = st.data?.last_result;
        if (r && !seen.has(`${name}:${r.at}`)) {
          seen.set(`${name}:${r.at}`, { instance: name, ...r });
          if (r.scanned > 0) {
            console.log(`  · 实例 ${name} tick@${r.at} 到期 ${r.scanned}`
              + ` 执行 ${r.ran} 失败 ${r.failed} 让出 ${r.skipped}`);
          }
        }
      }
    };

    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
      await collect();
      const instances = new Set([...seen.values()].map((t) => t.instance));
      if (hits.length > 0 && instances.size >= 2) break;
      await sleep(800);
    }
    await collect();

    // 6) 断言
    const ticks = [...seen.values()];
    const scannedTicks = ticks.filter((t) => t.scanned > 0);
    // 互斥判定用累计计数器：单调递增，不会被「最近一轮」覆盖，比逐轮采样可靠
    const sa = snapshot.get('A') || {};
    const sb = snapshot.get('B') || {};
    const execA = (sa.ran_total || 0) + (sa.failed_total || 0);
    const execB = (sb.ran_total || 0) + (sb.failed_total || 0);
    const execTotal = execA + execB;
    const aliveA = await api(portA, 'GET', '/health').then((r) => r.code === 0).catch(() => false);
    const aliveB = await api(portB, 'GET', '/health').then((r) => r.code === 0).catch(() => false);

    console.log(`\n观察窗口内共采集到 ${ticks.length} 轮 tick，其中 ${scannedTicks.length} 轮看到到期项`);
    console.log(`累计指标：A 执行 ${execA}（tick ${sa.ticks || 0} 次）· B 执行 ${execB}（tick ${sb.ticks || 0} 次）`);
    console.log(`webhook 接收器收到 ${hits.length} 次推送`);

    check('两个实例都存活（排除单实例假象）', aliveA && aliveB);
    check('两个实例都跑过 tick', (sa.ticks || 0) >= 1 && (sb.ticks || 0) >= 1);
    check('至少一个实例看到到期项', (sa.scanned_total || 0) + (sb.scanned_total || 0) >= 1);
    check('执行次数合计恰好为 1（互斥核心）', execTotal === 1);
    check('webhook 只被推送 1 次（端到端无重复）', hits.length === 1);

    if (hits.length) {
      const payload = JSON.parse(hits[0].body);
      check('推送载荷含订阅名', payload?.subscription?.name === '多实例互斥探针');
      check('推送载荷含岗位条目', Array.isArray(payload?.items) && payload.items.length > 0);
      console.log(`  推送内容：${payload?.items?.length} 个岗位 · 例：`
        + `${payload?.items?.[0]?.company} / ${payload?.items?.[0]?.title}`);
    }

    // 7) 落库侧复核：该订阅的推送记录也应只有条目数一致的一份
    const verify = new DatabaseSync(dbPath);
    verify.exec('PRAGMA busy_timeout = 5000;');
    const rows = verify.prepare(
      'SELECT COUNT(*) AS c FROM subscription_deliveries WHERE subscription_id = ?',
    ).get(subId);
    verify.close();
    check('推送记录条数等于岗位数（未重复落库）', Number(rows.c) === (hits.length ? JSON.parse(hits[0].body).items.length : 0));

    const stA = await api(portA, 'GET', '/api/v1/scheduler/status', { token });
    check('状态暴露实例标识', stA?.data?.instance_id === 'multi-inst-A');
    check('状态暴露锁 TTL', stA?.data?.lock_ttl_ms === 300000);
  } finally {
    // 有失败项时把两个实例的日志吐出来，便于定位（多实例问题往往藏在启动时序里）
    if (failed > 0) {
      for (const id of ['multi-inst-A', 'multi-inst-B']) {
        const lines = (childLogs.get(id) || []).join('');
        if (lines.trim()) {
          console.log(`\n--- ${id} 日志（尾部 3000 字符）---`);
          console.log(lines.slice(-3000));
        }
      }
    }
    for (const c of children) {
      try { c.kill(); } catch { /* ignore */ }
    }
    await new Promise((r) => receiver.close(r));
    await sleep(500);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed) {
    console.log('失败项：');
    failures.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('全部通过');
  }
  console.log('='.repeat(64));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
