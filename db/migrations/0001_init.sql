-- =============================================================
-- 0001_init · 初始表结构
-- 与 docs/02-详细设计/02-数据库设计.md 对应
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- -------------------------------------------------------------
-- 0. 公共
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_configs (
  id            BIGSERIAL PRIMARY KEY,
  key           VARCHAR(128) NOT NULL UNIQUE,
  value         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  description   TEXT,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      BIGINT,
  action        VARCHAR(64)  NOT NULL,
  target        VARCHAR(255),
  ip            INET,
  detail        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON audit_logs (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS llm_call_logs (
  id            BIGSERIAL PRIMARY KEY,
  caller        VARCHAR(64)  NOT NULL,
  task          VARCHAR(64)  NOT NULL,
  model         VARCHAR(64)  NOT NULL,
  prompt_tokens INTEGER      NOT NULL DEFAULT 0,
  output_tokens INTEGER      NOT NULL DEFAULT 0,
  latency_ms    INTEGER      NOT NULL DEFAULT 0,
  success       BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_llm_caller_time ON llm_call_logs (caller, created_at DESC);

-- -------------------------------------------------------------
-- 1. 用户域
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  nickname      VARCHAR(64),
  status        VARCHAR(16)  NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','disabled','pending')),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  basic_info    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  education     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  tests         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  experiences   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  addresses     JSONB        NOT NULL DEFAULT '[]'::jsonb,
  extras        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_profiles_gin ON user_profiles USING GIN (basic_info jsonb_path_ops);

CREATE TABLE IF NOT EXISTS resumes (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version_name  VARCHAR(128) NOT NULL,
  content_md    TEXT,
  parsed_json   JSONB        NOT NULL DEFAULT '{}'::jsonb,
  is_default    BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes (user_id, is_default DESC);

CREATE TABLE IF NOT EXISTS profile_documents (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type      VARCHAR(32)  NOT NULL
                CHECK (doc_type IN ('transcript','ps','sop','cv','recommendation','writing_sample','portfolio','test_score','other')),
  file_name     VARCHAR(255) NOT NULL,
  file_key      VARCHAR(512) NOT NULL,
  file_size     BIGINT       NOT NULL DEFAULT 0,
  mime          VARCHAR(128),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_docs_user_type ON profile_documents (user_id, doc_type);

-- -------------------------------------------------------------
-- 2. 模块一 · 留学网申
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_systems (
  id            BIGSERIAL PRIMARY KEY,
  code          VARCHAR(32)  NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  base_url      VARCHAR(255),
  vendor        VARCHAR(64),
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS institutions (
  id            BIGSERIAL PRIMARY KEY,
  system_id     BIGINT       REFERENCES application_systems(id),
  name          VARCHAR(255) NOT NULL,
  country       VARCHAR(64),
  program       VARCHAR(255),
  degree_type   VARCHAR(32)
                CHECK (degree_type IN ('MS','MA','MEng','MBA','PhD','Other')),
  apply_url     VARCHAR(512),
  priority      INTEGER      NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inst_system ON institutions (system_id, priority);

CREATE TABLE IF NOT EXISTS system_adapters (
  id            BIGSERIAL PRIMARY KEY,
  system_id     BIGINT       NOT NULL REFERENCES application_systems(id) ON DELETE CASCADE,
  version       VARCHAR(32)  NOT NULL,
  rules         JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status        VARCHAR(16)  NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','active','deprecated')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (system_id, version)
);

CREATE TABLE IF NOT EXISTS field_dictionary (
  id            BIGSERIAL PRIMARY KEY,
  field_key     VARCHAR(64)  NOT NULL UNIQUE,
  label_cn      VARCHAR(128),
  label_en      VARCHAR(128),
  aliases       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  value_type    VARCHAR(32)  NOT NULL
                CHECK (value_type IN ('text','textarea','select','multi_select','date','file','rich_text','number','address')),
  handler       VARCHAR(64),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_field_alias_gin ON field_dictionary USING GIN (aliases jsonb_path_ops);

CREATE TABLE IF NOT EXISTS field_mapping_rules (
  id            BIGSERIAL PRIMARY KEY,
  field_key     VARCHAR(64)  NOT NULL REFERENCES field_dictionary(field_key) ON DELETE CASCADE,
  adapter_id    BIGINT       REFERENCES system_adapters(id) ON DELETE CASCADE,
  match_type    VARCHAR(16)  NOT NULL
                CHECK (match_type IN ('selector','label','regex','semantic')),
  pattern       TEXT         NOT NULL,
  priority      INTEGER      NOT NULL DEFAULT 100,
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapping_field ON field_mapping_rules (field_key, priority);

CREATE TABLE IF NOT EXISTS applications (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution_id BIGINT       NOT NULL REFERENCES institutions(id),
  program        VARCHAR(255),
  status         VARCHAR(32)  NOT NULL DEFAULT 'not_started'
                 CHECK (status IN ('not_started','in_progress','submitted','interview','offer','rejected')),
  deadline       DATE,
  applied_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_user_status ON applications (user_id, status);

CREATE TABLE IF NOT EXISTS recommenders (
  id             BIGSERIAL PRIMARY KEY,
  application_id BIGINT       NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  name           VARCHAR(128) NOT NULL,
  email          VARCHAR(255) NOT NULL,
  title          VARCHAR(128),
  org            VARCHAR(255),
  relation       VARCHAR(64),
  invite_status  VARCHAR(24)  NOT NULL DEFAULT 'pending'
                 CHECK (invite_status IN ('pending','invited','submitted','declined')),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rec_app ON recommenders (application_id);

CREATE TABLE IF NOT EXISTS fill_sessions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id BIGINT       REFERENCES applications(id) ON DELETE SET NULL,
  system_code    VARCHAR(32),
  step_index     INTEGER      NOT NULL DEFAULT 0,
  status         VARCHAR(16)  NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','paused','completed','failed','blocked')),
  stats          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_session_user ON fill_sessions (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS fill_logs (
  id            BIGSERIAL PRIMARY KEY,
  session_id    BIGINT       NOT NULL REFERENCES fill_sessions(id) ON DELETE CASCADE,
  field_key     VARCHAR(64),
  selector      TEXT,
  value_hash    VARCHAR(64),
  confidence    NUMERIC(4,3),
  result        VARCHAR(16)  NOT NULL
                CHECK (result IN ('filled','skipped','failed','low_confidence','manual')),
  message       TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_filllog_session ON fill_logs (session_id);

-- -------------------------------------------------------------
-- 3. 模块二 · 实习爬取
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS crawl_sources (
  id            BIGSERIAL PRIMARY KEY,
  code          VARCHAR(64)  NOT NULL UNIQUE,
  name          VARCHAR(128) NOT NULL,
  source_type   VARCHAR(24)  NOT NULL
                CHECK (source_type IN ('wechat_mp','thirdparty_api','rss','job_platform','company_site','manual')),
  adapter       VARCHAR(64)  NOT NULL,
  config        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  interval_cron VARCHAR(64),
  rate_limit    INTEGER      NOT NULL DEFAULT 10,
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  priority      INTEGER      NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crawl_tasks (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT       NOT NULL REFERENCES crawl_sources(id) ON DELETE CASCADE,
  idem_key      VARCHAR(128) NOT NULL UNIQUE,
  status        VARCHAR(16)  NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','success','failed','skipped')),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  item_count    INTEGER      NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_source_status ON crawl_tasks (source_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS crawl_logs (
  id            BIGSERIAL PRIMARY KEY,
  task_id       BIGINT       NOT NULL REFERENCES crawl_tasks(id) ON DELETE CASCADE,
  level         VARCHAR(8)   NOT NULL DEFAULT 'info'
                CHECK (level IN ('debug','info','warn','error')),
  message       TEXT,
  http_status   INTEGER,
  rate_limited  BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crawllog_task ON crawl_logs (task_id);

CREATE TABLE IF NOT EXISTS articles (
  id            BIGSERIAL PRIMARY KEY,
  source_id     BIGINT        NOT NULL REFERENCES crawl_sources(id) ON DELETE CASCADE,
  url           VARCHAR(1024) NOT NULL UNIQUE,
  title         VARCHAR(512),
  account_name  VARCHAR(128),
  published_at  TIMESTAMPTZ,
  cover_url     VARCHAR(1024),
  summary       TEXT,
  content_hash  VARCHAR(64),
  fingerprint   VARCHAR(64),
  raw_meta      JSONB         NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_article_source_time ON articles (source_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_fingerprint ON articles (fingerprint);

CREATE TABLE IF NOT EXISTS jobs (
  id            BIGSERIAL PRIMARY KEY,
  article_id    BIGINT       NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  company       VARCHAR(255),
  title         VARCHAR(255),
  city          VARCHAR(64),
  salary        VARCHAR(128),
  duration      VARCHAR(64),
  education_req VARCHAR(64),
  major_req     TEXT,
  apply_method  TEXT,
  apply_url     VARCHAR(1024),
  deadline      DATE,
  retain_chance VARCHAR(64),
  confidence    NUMERIC(4,3),
  fingerprint   VARCHAR(64),
  status        VARCHAR(16)  NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','expired','removed')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_job_article ON jobs (article_id);
CREATE INDEX IF NOT EXISTS idx_job_city_time ON jobs (city, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_company ON jobs (company);
CREATE INDEX IF NOT EXISTS idx_job_title_trgm ON jobs USING GIN (title gin_trgm_ops);

CREATE TABLE IF NOT EXISTS job_tags (
  id            BIGSERIAL PRIMARY KEY,
  job_id        BIGINT       NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tag           VARCHAR(64)  NOT NULL,
  UNIQUE (job_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_jobtag_tag ON job_tags (tag);

CREATE TABLE IF NOT EXISTS dedup_index (
  id            BIGSERIAL PRIMARY KEY,
  fingerprint   VARCHAR(64)  NOT NULL UNIQUE,
  entity_type   VARCHAR(16)  NOT NULL CHECK (entity_type IN ('article','job')),
  entity_id     BIGINT       NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_health (
  id             BIGSERIAL PRIMARY KEY,
  source_id      BIGINT       NOT NULL REFERENCES crawl_sources(id) ON DELETE CASCADE,
  success_rate   NUMERIC(5,4) NOT NULL DEFAULT 0,
  avg_latency_ms INTEGER      NOT NULL DEFAULT 0,
  item_count     INTEGER      NOT NULL DEFAULT 0,
  score          NUMERIC(5,2) NOT NULL DEFAULT 0,
  measured_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_source_time ON source_health (source_id, measured_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keywords      JSONB        NOT NULL DEFAULT '[]'::jsonb,
  channels      JSONB        NOT NULL DEFAULT '["site"]'::jsonb,
  freq          VARCHAR(16)  NOT NULL DEFAULT 'daily'
                CHECK (freq IN ('realtime','daily','weekly')),
  enabled       BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON push_subscriptions (user_id, enabled);

-- -------------------------------------------------------------
-- 4. 初始化数据
-- -------------------------------------------------------------
INSERT INTO application_systems (code, name, vendor) VALUES
  ('applyweb', 'ApplyWeb', 'CollegeNET'),
  ('liaison',  'Liaison (GradCAS/EngineeringCAS)', 'Liaison International'),
  ('slate',    'Slate', 'Technolutions'),
  ('custom',   '院校自研系统', NULL)
ON CONFLICT (code) DO NOTHING;

INSERT INTO system_configs (key, value, description) VALUES
  ('crawler.degrade_level', '0', '采集降级层级: 0=全自动 1=切源 2=半自动 3=人工'),
  ('extension.enabled',     'true', '插件功能总开关'),
  ('compliance.no_autosubmit', 'true', '禁止自动提交(硬约束,不可关闭)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO crawl_sources (code, name, source_type, adapter, config, interval_cron, enabled, priority) VALUES
  ('manual_inbox', '人工投递入口', 'manual', 'manual',
   '{"inbox_dir": "./inbox", "account_name": "人工投递"}', '0 30 7,12,19 * * *', true, 10),
  ('rss_demo', 'RSS 中转示例', 'rss', 'rss',
   '{"feed_url": "", "account_name": ""}', '0 30 7,12,19 * * *', false, 50)
ON CONFLICT (code) DO NOTHING;
