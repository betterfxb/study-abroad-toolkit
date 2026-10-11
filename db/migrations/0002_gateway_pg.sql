-- =============================================================
-- 0002_gateway_pg · 网关运行时表 PG 化 + 切库前置
--
-- 背景：网关本地用 node:sqlite（表结构见
--   apps/api/src/db/database.service.ts 的 SCHEMA_SQL），与
--   0001_init.sql 有三处分歧：
--   ① users 缺 role（管理鉴权 user.role==='admin' 依赖它）；
--   ② 网关订阅模型（subscriptions/subscription_deliveries，
--      含 schedule/next_run_at/locked_at 调度三件套）与 0001 的
--      push_subscriptions 完全不同；
--   ③ institutions/applications/recommenders/resumes 列集不一致，
--      另缺 refresh_tokens/profiles/documents/idempotency 四表。
-- 本迁移让 PG 端具备网关所需的全部结构。切库时只需替换
--   DatabaseService 驱动 + 改写 §5 标注的 SQL 差异点，无需再做 DDL。
--
-- 幂等：全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
--   约束名存在性检查，可重跑。SQLite 方言禁入本文件
--   （AUTOINCREMENT / INSERT OR IGNORE / PRAGMA / 反引号）。
-- 时间一律 TIMESTAMPTZ（UTC），与 0001 约定一致。
--
-- 核查（本机无 PG，环境无关）：
--   node db/tests/pg_migration_check.js
--   DATABASE_URL=... python db/migrate.py --dry-run
-- =============================================================

-- -------------------------------------------------------------
-- §0 schema_migrations（migrate.py 运行期会建，但 db/schema.sql
-- 直跑依赖它：\i 0001 后即 INSERT INTO schema_migrations。
-- 0001 未建此表，psql 直跑必失败，先补齐）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(64) PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------
-- §1 users 补 role（管理员白名单 ADMIN_EMAILS 注册时赋值，
-- 运行时校验 user.role==='admin'，非管理员 1003）
-- -------------------------------------------------------------
ALTER TABLE IF EXISTS users
  ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'user';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check') THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- 存量行默认 'user'；admin 只能来自部署期白名单注册，不做回填。
-- （注册后自助升级等于把权限交给任意注册者，故不提供）

-- -------------------------------------------------------------
-- §2 网关新表（0001 无同名表，直接建）
-- 方言对照（切库改写点）：
--   enabled/require_all_keywords/revoked: SQLite INTEGER 0/1 → PG BOOLEAN
--   时刻列：SQLite TEXT ''（空串=无）→ PG TIMESTAMPTZ NULL（无=IS NULL，
--     涉及 listDue/claimDue/lockedCount/release 系 SQL，把 ='' 改 IS NULL、
--     <>'' 改 IS NOT NULL）
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token      TEXT        PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);

-- 网关资料读写源（单 JSON）。0001 的 user_profiles（多 JSONB 列）并存，
-- 切库后择机归并（data ↔ basic_info/education/tests/experiences/addresses），
-- 归并前以 profiles 为网关读写源，不双写。
CREATE TABLE IF NOT EXISTS profiles (
  user_id    BIGINT      PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 VARCHAR(255) NOT NULL,
  keywords             JSONB        NOT NULL DEFAULT '[]'::jsonb,
  cities               JSONB        NOT NULL DEFAULT '[]'::jsonb,
  education            VARCHAR(64)  NOT NULL DEFAULT '',
  channel              VARCHAR(16)  NOT NULL DEFAULT 'email'
                       CHECK (channel IN ('email', 'wechat', 'webhook')),
  enabled              BOOLEAN      NOT NULL DEFAULT true,
  require_all_keywords BOOLEAN      NOT NULL DEFAULT false,
  webhook_url          TEXT         NOT NULL DEFAULT '',
  last_run_at          TIMESTAMPTZ,
  -- 调度三件套：schedule 表达式（''=不自动执行，语法见
  -- apps/api/src/common/schedule.ts）；next_run_at 到期游标；
  -- locked_at/locked_by 分布式抢占锁（见 §5）
  schedule             TEXT         NOT NULL DEFAULT '',
  next_run_at          TIMESTAMPTZ,
  locked_at            TIMESTAMPTZ,
  locked_by            TEXT         NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_due ON subscriptions (enabled, next_run_at);

-- 推送幂等落在唯一约束 (subscription_id, job_id)，不只靠应用层查询。
-- 写入用 INSERT ... ON CONFLICT (subscription_id, job_id) DO NOTHING，
-- 与 SQLite 的 INSERT OR IGNORE 语义等价。
CREATE TABLE IF NOT EXISTS subscription_deliveries (
  id              BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT       NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id         BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id          BIGINT       NOT NULL,
  channel         VARCHAR(16)  NOT NULL DEFAULT 'email'
                  CHECK (channel IN ('email', 'wechat', 'webhook')),
  status          VARCHAR(16)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'sent', 'failed')),
  score           NUMERIC(5,4) NOT NULL DEFAULT 0,
  title           VARCHAR(255) NOT NULL DEFAULT '',
  payload         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  error           TEXT         NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ,
  UNIQUE (subscription_id, job_id)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_sub ON subscription_deliveries (subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliveries_user ON subscription_deliveries (user_id, created_at DESC);

-- 网关材料登记表。doc_type 取值 = 网关 DOC_TYPES 白名单
-- （apps/api/src/documents/documents.service.ts）。
-- 0001 的 profile_documents 并存，切库后归并（file_key 归属校验仍在服务层）。
CREATE TABLE IF NOT EXISTS documents (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type   VARCHAR(32)  NOT NULL
             CHECK (doc_type IN ('transcript', 'degree', 'passport', 'cv', 'ps', 'recommendation', 'other')),
  file_name  VARCHAR(255) NOT NULL,
  file_key   TEXT         NOT NULL,
  mime       VARCHAR(128) NOT NULL DEFAULT '',
  file_size  BIGINT       NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_documents_user ON documents (user_id, doc_type);

-- 幂等键（契约 §9 约定 4，24h）。TTL 仍由应用层执行（过期删行），
-- 与 SQLite 行为一致；运维 purge 可按 created_at 清理：
--   DELETE FROM idempotency WHERE created_at < now() - interval '24 hours';
-- upsert 原样：INSERT ... ON CONFLICT (key) DO UPDATE（与 SQLite 同形，零改动）。
CREATE TABLE IF NOT EXISTS idempotency (
  key        TEXT        PRIMARY KEY,
  response   TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_idempotency_time ON idempotency (created_at);

-- -------------------------------------------------------------
-- §3 存量表补列 + 约束合并 + 数据回填（单事实源，不建平行表）
-- -------------------------------------------------------------

-- institutions：补网关列；唯一键支撑 ON CONFLICT (name, program) DO NOTHING
-- （对应 SQLite 的 INSERT OR IGNORE + idx_institutions_unique）。
-- 本库尚无生产数据；若已有重复行，先去重再建唯一索引。
ALTER TABLE IF EXISTS institutions
  ADD COLUMN IF NOT EXISTS platform VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS institutions
  ADD COLUMN IF NOT EXISTS deadline DATE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_institutions_name_program
  ON institutions (name, program);

-- applications：补网关列；status 值域合并（0001 not_started ∪ 网关 draft）。
-- 0001 的内联 CHECK 为系统命名，先按定义特征找到并删除，再建显式命名约束。
ALTER TABLE IF EXISTS applications
  ADD COLUMN IF NOT EXISTS institution_name VARCHAR(255) NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS applications
  ADD COLUMN IF NOT EXISTS platform VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS applications
  ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS applications
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'applications' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%not_started%'
  LOOP
    EXECUTE format('ALTER TABLE applications DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'applications' AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%draft%'
  ) THEN
    ALTER TABLE applications ADD CONSTRAINT applications_status_check
      CHECK (status IN ('draft', 'not_started', 'in_progress', 'submitted',
                        'interview', 'offer', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'applications_progress_check') THEN
    ALTER TABLE applications ADD CONSTRAINT applications_progress_check
      CHECK (progress >= 0 AND progress <= 100);
  END IF;
END $$;

-- 存量回填（幂等：只填空串行）：institution_name 取自关联院校。
UPDATE applications AS a SET institution_name = i.name
  FROM institutions AS i
 WHERE i.id = a.institution_id AND a.institution_name = '';

-- recommenders：网关 status ∪ 0001 invite_status(多 declined) 取并集；
-- invited_at 为网关新增。先加列、回填，再建约束（避免存量违反）。
ALTER TABLE IF EXISTS recommenders
  ADD COLUMN IF NOT EXISTS status VARCHAR(24) NOT NULL DEFAULT 'pending';
ALTER TABLE IF EXISTS recommenders
  ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

UPDATE recommenders SET status = invite_status
 WHERE status = 'pending'
   AND invite_status IN ('pending', 'invited', 'submitted', 'declined');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recommenders_status_check') THEN
    ALTER TABLE recommenders ADD CONSTRAINT recommenders_status_check
      CHECK (status IN ('pending', 'invited', 'submitted', 'declined'));
  END IF;
END $$;

-- resumes：网关四列（name/source_text/parsed/version）∪ 0001 四列并存，
-- 存量由 0001 列回填（幂等：只填空值行）。
ALTER TABLE IF EXISTS resumes
  ADD COLUMN IF NOT EXISTS name VARCHAR(128) NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS resumes
  ADD COLUMN IF NOT EXISTS source_text TEXT NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS resumes
  ADD COLUMN IF NOT EXISTS parsed JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS resumes
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

UPDATE resumes SET name = version_name WHERE name = '';
UPDATE resumes SET source_text = COALESCE(content_md, '') WHERE source_text = '';
UPDATE resumes SET parsed = COALESCE(parsed_json, '{}'::jsonb)
 WHERE parsed = '{}'::jsonb;

-- -------------------------------------------------------------
-- §4 调度索引（与 SQLite 的 idx_subscriptions_due 同形，已在 §2 建）
-- 到期扫描：WHERE enabled AND schedule <> '' AND
--   (next_run_at IS NULL OR next_run_at <= $1)
--   ORDER BY next_run_at NULLS FIRST, id
-- -------------------------------------------------------------

-- -------------------------------------------------------------
-- §5 分布式调度 PG 改写参考（注释，非执行 DDL）
--
-- SQLite 的 claimDue() 是单条条件 UPDATE（靠写锁互斥）；
-- PG 切库后改为「事务内 SELECT … FOR UPDATE SKIP LOCKED + 逐条加锁」，
-- 只抢未被其它实例锁定的到期行，不阻塞、不重复执行：
--
--   BEGIN;
--   SELECT id FROM subscriptions
--    WHERE enabled
--      AND schedule <> ''
--      AND (next_run_at IS NULL OR next_run_at <= $1)      -- 仍到期
--      AND (locked_at IS NULL OR locked_at <= $2)          -- 无锁或锁已陈旧
--    ORDER BY next_run_at NULLS FIRST, id ASC
--    LIMIT 20
--    FOR UPDATE SKIP LOCKED;
--   -- 对取到的每行：UPDATE subscriptions
--   --   SET locked_at = now(), locked_by = $3 WHERE id = $4;
--   COMMIT;
--   -- 执行成功或失败后：releaseAdvance() 推进 next_run_at 并清锁
--   -- （失败也必须推进，否则坏数据造成无限重试热循环；与现有一致）
--
-- $1=now, $2=now-lock_ttl, $3=instance_id。锁 TTL 默认 5min
-- （SCHEDULER_LOCK_TTL_MS），实例退出时 releaseInstanceLocks() 清理。
-- 预期改动面仅 subscriptions.service.ts 的 claimDue/listDue 等 6 个
-- 方法 + DatabaseService 驱动替换，调度语义与 tick 编排不变。
-- -------------------------------------------------------------
