/**
 * PG 迁移静态核查（零第三方依赖，本机无 PG 也可跑）。
 *
 *   node db/tests/pg_migration_check.js
 *
 * 核查 db/migrations/0002_gateway_pg.sql：
 *   命名符合 migrate.py 的 VERSION_RE / 无 SQLite 方言残留 /
 *   新表与索引齐全 / 时间列全 TIMESTAMPTZ / 幂等写法 /
 *   调度 SKIP LOCKED 参考存在 / schema.sql 已串起 0002。
 *
 * 约定：纯文本断言，不连数据库；失败即非零退出。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = join(ROOT, 'db', 'migrations', '0002_gateway_pg.sql');
const SCHEMA = join(ROOT, 'db', 'schema.sql');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}`);
  }
}

// 与 db/migrate.py 的 VERSION_RE 同形：^(\d{4}_[a-z0-9_]+)\.sql$
const VERSION_RE = /^(\d{4}_[a-z0-9_]+)\.sql$/;

console.log('[1] 文件与命名');
check('0002 文件存在', existsSync(MIG));
check('文件名符合 VERSION_RE（migrate.py 可发现）', VERSION_RE.test('0002_gateway_pg.sql'));

const sql = readFileSync(MIG, 'utf8');
// 剥离行注释与块注释：头注释会点名禁用的方言，不能计入残留
const codeOnly = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const lower = codeOnly.toLowerCase();
// 文档类断言（约束名/改写指引多写在注释里）用全文
const fullLower = sql.toLowerCase();

console.log('[2] 无 SQLite 方言残留（仅扫描非注释代码）');
for (const token of ['autoincrement', 'insert or ignore', 'pragma ', 'backtick']) {
  if (token === 'backtick') {
    check('无反引号标识符', !sql.includes('`'));
  } else {
    check(`无 ${token}`, !lower.includes(token));
  }
}
check('无 created_at TEXT（时刻列须 TIMESTAMPTZ）', !sql.includes('created_at TEXT'));

console.log('[3] 新表与补列齐全');
for (const t of [
  'schema_migrations',
  'refresh_tokens',
  'profiles',
  'subscriptions',
  'subscription_deliveries',
  'documents',
  'idempotency',
]) {
  check(`建表 ${t}`, lower.includes(`create table if not exists ${t}`));
}
check('users 补 role 列', lower.includes('add column if not exists role'));
check('users_role_check 约束', sql.includes('users_role_check'));
check('institutions 补 platform/deadline', lower.includes('platform varchar(64)') && lower.includes('deadline date'));
check('applications 补 institution_name/platform/progress/notes',
  ['institution_name', 'platform varchar(64)', 'progress integer', 'notes text'].every((s) => lower.includes(s)));
check('applications_status_check 合并 draft/not_started', sql.includes('applications_status_check'));
check('recommenders 补 status/invited_at', lower.includes('invited_at timestamptz'));
check('resumes 补 name/source_text/parsed/version',
  ['source_text text', 'parsed jsonb', 'version integer'].every((s) => lower.includes(s)));

console.log('[4] 索引与幂等键');
check('idx_subscriptions_due 到期索引', sql.includes('idx_subscriptions_due'));
check('推送幂等 UNIQUE(subscription_id, job_id)',
  sql.replace(/\s+/g, ' ').includes('UNIQUE (subscription_id, job_id)'));
check('院校唯一键 idx_institutions_name_program', sql.includes('idx_institutions_name_program'));
check('幂等 upsert 文档含 ON CONFLICT', sql.includes('ON CONFLICT'));

console.log('[5] 幂等写法（可重跑）');
const createTables = (sql.match(/create table /gi) || []).length;
const createTablesGuarded = (sql.match(/create table if not exists /gi) || []).length;
check(`建表全带 IF NOT EXISTS（${createTablesGuarded}/${createTables}）`,
  createTables > 0 && createTables === createTablesGuarded);
const createIndexes = (sql.match(/create (unique )?index /gi) || []).length;
const createIndexesGuarded = (sql.match(/create (unique )?index if not exists /gi) || []).length;
check(`建索引全带 IF NOT EXISTS（${createIndexesGuarded}/${createIndexes}）`,
  createIndexes > 0 && createIndexes === createIndexesGuarded);
// 行首匹配：排除 EXECUTE format('ALTER TABLE ...') 字符串字面量内的误伤
const alters = sql.match(/^\s*alter table if exists \w+\s*\n?\s*add column if not exists /gim) || [];
const alterStatements = (sql.match(/^\s*alter table /gim) || []).length;
// 约束合并走 DO 块（ALTER TABLE ... ADD CONSTRAINT），豁免 IF NOT EXISTS 计数
const alterInDo = (sql.match(/^\s*alter table (applications|recommenders|users)\s*\n?\s*add constraint/gim) || []).length;
check(`补列全带 IF EXISTS + IF NOT EXISTS（${alters.length} 补列 / ${alterInDo} 约束合并走 DO 块）`,
  alters.length > 0 && alters.length + alterInDo === alterStatements);

console.log('[6] 调度与切库指引');
check('SKIP LOCKED 参考存在', sql.includes('FOR UPDATE SKIP LOCKED'));
check('空串→NULL 改写点有标注', sql.includes("='''") || sql.includes("= ''") || fullLower.includes('is null'));
check('热循环警示（失败也推进）', fullLower.includes('热循环') || fullLower.includes('失败也'));

console.log('[7] 串接');
const schemaSql = readFileSync(SCHEMA, 'utf8');
check('schema.sql 已串起 0002', schemaSql.includes('0002_gateway_pg.sql'));

console.log('----------------------------------------------------');
console.log(`通过 ${passed} 项，失败 ${failed} 项${failed ? '，失败：' + failures.join('；') : '，全部通过'}`);
process.exit(failed ? 1 : 0);
