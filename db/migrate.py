"""数据库迁移执行器（按序应用 db/migrations/*.sql）。

用法：
    python db/migrate.py                      # 用 DATABASE_URL 环境变量
    python db/migrate.py --dsn postgresql://user:pwd@localhost:5432/study_abroad
    python db/migrate.py --status             # 只查看已应用版本
    python db/migrate.py --dry-run            # 只打印将执行的迁移

依赖：psycopg（psycopg[binary]>=3.2）
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"
VERSION_RE = re.compile(r"^(\d{4}_[a-z0-9_]+)\.sql$", re.IGNORECASE)


def _normalize_dsn(dsn: str) -> str:
    """把 SQLAlchemy 风格 URL 转成 libpq DSN。"""
    return dsn.replace("postgresql+asyncpg://", "postgresql://").replace(
        "postgresql+psycopg://", "postgresql://"
    )


def discover_migrations() -> list[tuple[str, Path]]:
    items: list[tuple[str, Path]] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        m = VERSION_RE.match(path.name)
        if m:
            items.append((m.group(1), path))
    return items


def ensure_migrations_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version    VARCHAR(64) PRIMARY KEY,
              applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
    conn.commit()


def applied_versions(conn) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT version FROM schema_migrations")
        return {row[0] for row in cur.fetchall()}


def apply_migration(conn, version: str, path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
        cur.execute(
            "INSERT INTO schema_migrations (version) VALUES (%s) ON CONFLICT DO NOTHING",
            (version,),
        )
    conn.commit()


def main() -> int:
    parser = argparse.ArgumentParser(description="应用数据库迁移")
    parser.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""))
    parser.add_argument("--status", action="store_true", help="只查看状态")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划")
    args = parser.parse_args()

    migrations = discover_migrations()
    if not migrations:
        print(f"未在 {MIGRATIONS_DIR} 找到迁移文件")
        return 1

    if args.dry_run:
        print("将按序执行：")
        for version, path in migrations:
            print(f"  - {version}  ({path.name})")
        return 0

    if not args.dsn:
        print("错误：未提供 --dsn，且环境变量 DATABASE_URL 为空")
        return 1

    try:
        import psycopg
    except ImportError:
        print("错误：需要 psycopg，请先执行 pip install 'psycopg[binary]>=3.2'")
        return 1

    dsn = _normalize_dsn(args.dsn)
    with psycopg.connect(dsn, autocommit=False) as conn:
        ensure_migrations_table(conn)
        done = applied_versions(conn)

        if args.status:
            print(f"数据库已应用 {len(done)} 个迁移：")
            for version, _ in migrations:
                flag = "已应用" if version in done else "待应用"
                print(f"  [{flag}] {version}")
            return 0

        pending = [(v, p) for v, p in migrations if v not in done]
        if not pending:
            print("数据库已是最新，无需迁移")
            return 0

        for version, path in pending:
            print(f"应用迁移 {version} ...", end=" ", flush=True)
            try:
                apply_migration(conn, version, path)
                print("完成")
            except Exception as exc:  # noqa: BLE001
                print("失败")
                print(f"  {exc}", file=sys.stderr)
                return 1

        print(f"迁移完成，共应用 {len(pending)} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
