/**
 * 数据访问层：基于 Node 内置 `node:sqlite`（零原生依赖，需 --experimental-sqlite）。
 *
 * 设计：把 SQL 收敛在服务内，业务模块只调用仓储方法。
 * 生产环境可替换为 PostgreSQL + TypeORM，业务层不受影响（同 crawler-service 的做法）。
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SQLite 支持的 journal_mode 取值，用于校验 SQLITE_JOURNAL_MODE */
const ALLOWED_JOURNAL_MODES = ['wal', 'delete', 'truncate', 'persist', 'memory', 'off'] as const;

/**
 * 决定日志模式。
 *
 * 多进程共享同一文件库时，WAL 在 Windows 上有已知缺陷：两个实例**同时**打开，
 * 可能有一方的连接被永久置为只读（SQLITE_READONLY，errcode 8），此后该连接
 * 执行任何写语句都失败，且**重试无效**（实测 0/5），必须关闭重开才能恢复。
 * 实测 Windows 下 WAL 约 40% 的轮次会踩中，而 delete 模式 6/6 轮零失败。
 *
 * 因此：Windows 默认 delete，其余平台默认 wal；均可用 SQLITE_JOURNAL_MODE 覆盖。
 * （journal_mode 是库文件的持久属性，同一文件跨平台使用不会冲突）
 */
export function resolveJournalMode(location: string): string {
  const raw = (process.env.SQLITE_JOURNAL_MODE || '').trim().toLowerCase();
  if (raw) {
    if (!(ALLOWED_JOURNAL_MODES as readonly string[]).includes(raw)) {
      throw new Error(
        `SQLITE_JOURNAL_MODE 非法：${raw}（可选：${ALLOWED_JOURNAL_MODES.join(' / ')}）`,
      );
    }
    return raw;
  }
  if (location === ':memory:') return 'memory';
  return process.platform === 'win32' ? 'delete' : 'wal';
}

/** 是否为「连接级只读」故障：重试同语句无效，必须重开连接 */
export function isReadonlyError(e: any): boolean {
  return e?.errcode === 8 || /readonly database/i.test(e?.message || '');
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS institutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  program TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  institution_id INTEGER,
  institution_name TEXT NOT NULL DEFAULT '',
  program TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  progress INTEGER NOT NULL DEFAULT 0,
  deadline TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recommenders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  org TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  invited_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',
  cities TEXT NOT NULL DEFAULT '[]',
  education TEXT NOT NULL DEFAULT '',
  channel TEXT NOT NULL DEFAULT 'email',
  enabled INTEGER NOT NULL DEFAULT 1,
  require_all_keywords INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT NOT NULL DEFAULT '',
  last_run_at TEXT NOT NULL DEFAULT '',
  -- 定时调度：'' = 不自动执行；否则见 common/schedule.ts 的表达式语法
  schedule TEXT NOT NULL DEFAULT '',
  -- 下次执行时刻（ISO 8601）。落库以便调度器用 SQL 直查到期项，避免每轮全表遍历
  next_run_at TEXT NOT NULL DEFAULT '',
  -- 分布式调度：实例抢占锁。locked_at 早于 TTL 视为陈旧（持有者已崩溃），可被他人抢占
  locked_at TEXT NOT NULL DEFAULT '',
  locked_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 订阅推送记录：UNIQUE(subscription_id, job_id) 保证同一岗位不会重复推送
CREATE TABLE IF NOT EXISTS subscription_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  status TEXT NOT NULL DEFAULT 'pending',
  score REAL NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT '',
  UNIQUE(subscription_id, job_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_key TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT '',
  parsed TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 插件填写会话与日志（契约 §4.2 / §4.3；与 0001 PG 的 fill_sessions/fill_logs 同形）
CREATE TABLE IF NOT EXISTS fill_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  application_id INTEGER,
  system_code TEXT NOT NULL DEFAULT '',
  step_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  stats TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS fill_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  field_key TEXT,
  selector TEXT NOT NULL DEFAULT '',
  value_hash TEXT NOT NULL DEFAULT '',
  confidence REAL,
  result TEXT NOT NULL DEFAULT 'skipped',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_applications_user ON applications(user_id, status);
CREATE INDEX IF NOT EXISTS idx_recommenders_app ON recommenders(application_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes(user_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_sub ON subscription_deliveries(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_user ON subscription_deliveries(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_fill_sessions_user ON fill_sessions(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_fill_logs_session ON fill_logs(session_id);
`;

/** 旧库补列：SQLite 的 ALTER TABLE 不支持 IF NOT EXISTS，需先查 PRAGMA */
const ADDED_COLUMNS: [string, string, string][] = [
  ['subscriptions', 'require_all_keywords', 'INTEGER NOT NULL DEFAULT 0'],
  ['subscriptions', 'webhook_url', "TEXT NOT NULL DEFAULT ''"],
  ['subscriptions', 'last_run_at', "TEXT NOT NULL DEFAULT ''"],
  ['subscriptions', 'schedule', "TEXT NOT NULL DEFAULT ''"],
  ['subscriptions', 'next_run_at', "TEXT NOT NULL DEFAULT ''"],
  ['subscriptions', 'locked_at', "TEXT NOT NULL DEFAULT ''"],
  ['subscriptions', 'locked_by', "TEXT NOT NULL DEFAULT ''"],
];

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DB');
  private db!: DatabaseSync;
  /** 内存库（测试）或文件库（运行）；由 DB_PATH 环境变量控制 */
  private readonly location = process.env.DB_PATH || ':memory:';
  /** 实际生效的日志模式；重开连接时按需补一次 PRAGMA */
  private journalMode = 'delete';
  /** 事务嵌套深度。只读故障恢复要关连接，事务中不能做，故用它拦住 */
  private txDepth = 0;

  async onModuleInit() {
    this.journalMode = resolveJournalMode(this.location);
    this.open();

    // ① 日志模式切换需要排他锁，多实例同时启动会互相抢；失败只告警——退化成 delete 也完全可用。
    // ② 初始化阶段的 DDL / 播种同理，且等待窗口更长，故再叠一层重试。
    if (this.location !== ':memory:') {
      await this.retryExec(
        `PRAGMA journal_mode = ${this.journalMode};`,
        `日志模式=${this.journalMode}`,
        true,
      );
    }
    await this.retryExec(SCHEMA_SQL, '建表');
    // ③ 院校唯一索引：并发播种靠它 + INSERT OR IGNORE 保证幂等。
    //    旧库若已有重复数据会建不上——降级为告警。
    await this.retryExec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_unique ON institutions(name, program);',
      '院校唯一索引',
      true,
    );
    await this.retryRun(() => this.ensureColumns(), '补列');
    await this.retryRun(() => this.seedInstitutions(), '院校种子数据');

    this.logger.log(`SQLite 已就绪：${this.location}（日志模式 ${this.journalMode}）`);
  }

  /** 打开连接。忙等待必须先设：多实例共享文件时写冲突会立即抛 SQLITE_BUSY */
  private open() {
    this.db = new DatabaseSync(this.location);
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  /**
   * 关闭并重开连接 —— 从「连接级只读」故障中恢复的唯一手段。
   * 事务进行中不可调用（会丢掉未提交的更改），由调用方用 txDepth 拦住。
   */
  private reopen() {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.open();
    // journal_mode 是库文件持久属性，重开后通常无需再切；仅当期望 WAL 时补一次，
    // 失败忽略（此刻多半是别的实例正持锁，保持原模式即可）
    if (this.location !== ':memory:' && this.journalMode === 'wal') {
      try {
        this.db.exec('PRAGMA journal_mode = wal;');
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 带退避重试地执行一段 SQL。
   * @param optional 为 true 时，最终仍失败只告警不抛错（用于「已有实例做过」的幂等操作）
   */
  private async retryExec(sql: string, label: string, optional = false): Promise<void> {
    await this.retryRun(() => this.db.exec(sql), label, optional);
  }

  private async retryRun(fn: () => void, label: string, optional = false): Promise<void> {
    const attempts = 6;
    for (let i = 1; i <= attempts; i += 1) {
      try {
        fn();
        return;
      } catch (e: any) {
        const msg = e?.message || String(e);
        // 连接级只读故障：重试同语句无效（实测 0/5），必须立刻重开连接再重试
        if (isReadonlyError(e) && this.txDepth === 0) {
          this.logger.warn(`${label} 命中 SQLITE_READONLY，重开连接后重试`);
          try {
            this.reopen();
          } catch {
            /* 交给下一轮重试 */
          }
        }
        if (i === attempts) {
          if (optional) {
            this.logger.warn(`${label} 未成功（可忽略）：${msg}`);
            return;
          }
          throw e;
        }
        const wait = 150 * i;
        this.logger.warn(`${label} 第 ${i} 次失败：${msg}，${wait}ms 后重试`);
        await sleep(wait);
      }
    }
  }

  /** 为已存在的旧库补齐后加的列（幂等） */
  private ensureColumns() {
    for (const [table, column, ddl] of ADDED_COLUMNS) {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!cols.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
        this.logger.log(`已补列 ${table}.${column}`);
      }
    }
  }

  onModuleDestroy() {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * 执行写语句，返回 { changes, lastInsertRowid }。
   * 运行期同样可能撞上连接级只读（见 resolveJournalMode 注释），
   * 此时重开连接再试一次，避免实例「带病运行」到重启为止。
   */
  run(sql: string, ...params: any[]) {
    try {
      return this.db.prepare(sql).run(...params);
    } catch (e: any) {
      if (!isReadonlyError(e) || this.txDepth > 0) throw e;
      this.logger.warn(`写操作命中 SQLITE_READONLY，重开连接后重试：${sql.slice(0, 60)}`);
      this.reopen();
      return this.db.prepare(sql).run(...params);
    }
  }

  /** 查询单行 */
  get<T = any>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  /** 查询多行 */
  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /** 事务包裹。txDepth 用于阻止事务中途重开连接（会丢掉未提交的更改） */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    this.txDepth += 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 连接已坏时 ROLLBACK 也可能失败，忽略 */
      }
      throw e;
    } finally {
      this.txDepth -= 1;
    }
  }

  /** 预置院校项目（PoC 种子数据） */
  private seedInstitutions() {
    const row = this.get<{ c: number }>('SELECT COUNT(*) AS c FROM institutions');
    if (row && row.c > 0) return;
    const now = new Date().toISOString();
    const seed: [string, string, string, string, string][] = [
      ['Massachusetts Institute of Technology', 'US', 'MS in Computer Science', 'applyweb', '2026-12-15'],
      ['Stanford University', 'US', 'MS in Computer Science', 'slate', '2026-12-01'],
      ['Carnegie Mellon University', 'US', 'MS in Software Engineering', 'applyweb', '2026-12-10'],
      ['University of California, Berkeley', 'US', 'MEng in EECS', 'slate', '2026-12-08'],
      ['University of Toronto', 'CA', 'MSc in Applied Computing', 'liaison', '2027-01-15'],
      ['Imperial College London', 'UK', 'MSc in Computing', 'generic', '2026-11-30'],
      ['National University of Singapore', 'SG', 'MComp in AI', 'generic', '2026-11-20'],
      ['ETH Zurich', 'CH', 'MSc in Computer Science', 'generic', '2026-12-15'],
    ];
    let inserted = 0;
    this.tx(() => {
      for (const [name, country, program, platform, deadline] of seed) {
        const res = this.run(
          `INSERT OR IGNORE INTO institutions(name, country, program, platform, deadline, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          name, country, program, platform, deadline, now,
        );
        if (Number(res.changes) > 0) inserted += 1;
      }
    });
    // 多实例并发播种时，后到者可能一条都插不进去——静默即可
    if (inserted > 0) this.logger.log(`院校种子数据已写入：${inserted} 条`);
  }
}
