/**
 * 分页与排序参数解析（契约 §9 约定 1、2）。
 *   分页：page（从 1 起）+ size（默认 20，最大 200）
 *   排序：sort=field:asc|desc，多字段逗号分隔
 */

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 20;

export interface Pagination {
  page: number;
  size: number;
  offset: number;
}

export function parsePagination(query: Record<string, any>): Pagination {
  let page = Number.parseInt(String(query.page ?? '1'), 10);
  let size = Number.parseInt(String(query.size ?? DEFAULT_PAGE_SIZE), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(size) || size < 1) size = DEFAULT_PAGE_SIZE;
  if (size > MAX_PAGE_SIZE) size = MAX_PAGE_SIZE;
  return { page, size, offset: (page - 1) * size };
}

export interface SortSpec {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * 解析排序表达式，并限制在白名单内（防注入）。
 * 非法取值回退到 fallback。
 */
export function parseSort(raw: any, allowed: string[], fallback: SortSpec): SortSpec[] {
  if (!raw || typeof raw !== 'string') return [fallback];
  const out: SortSpec[] = [];
  for (const part of raw.split(',')) {
    const [field, dirRaw] = part.split(':').map((s) => s.trim());
    if (!field || !allowed.includes(field)) continue;
    const direction = String(dirRaw || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    out.push({ field, direction });
  }
  return out.length ? out : [fallback];
}

/** 构造统一分页响应体 */
export function pageResult<T>(items: T[], total: number, p: Pagination) {
  return {
    total,
    page: p.page,
    size: p.size,
    items,
  };
}
