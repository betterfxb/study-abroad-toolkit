-- =============================================================
-- 一键初始化数据库（psql 通道）
--
-- 用法：在**项目根目录**执行
--   psql -U postgres -f db/schema.sql
--
-- 说明：表结构以 db/migrations/*.sql 为唯一来源（按文件名排序串行），
--       本文件只负责建库并把迁移串起来，避免两处 DDL 不一致。
--       若需按迁移增量升级，请改用：python db/migrate.py
-- =============================================================

CREATE DATABASE study_abroad WITH ENCODING 'UTF8';

\connect study_abroad

\i db/migrations/0001_init.sql
\i db/migrations/0002_gateway_pg.sql

INSERT INTO schema_migrations (version) VALUES ('0001_init'), ('0002_gateway_pg')
ON CONFLICT (version) DO NOTHING;
