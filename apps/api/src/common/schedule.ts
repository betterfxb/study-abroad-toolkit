/**
 * 调度表达式：解析、下次执行时间、到期判定、文案渲染。
 *
 * **纯函数，零依赖**，不读数据库、不读时钟（时间由调用方传入），因此可在 Node 中
 * 精确断言边界（跨天、跨周、跨时区），不需要真实定时器。
 *
 * 语法（不引入 cron 依赖，够用即可）：
 *   ''                       不自动执行（仅手动点「立即执行」）
 *   hourly                   每小时整点
 *   daily@HH:MM              每天 HH:MM（按 SCHEDULER_TZ_OFFSET 指定的时区，默认东八区）
 *   weekly@MO,WE,FR@HH:MM    每周指定星期几的 HH:MM
 *   every:Nm                 每 N 分钟（N: 1..1440）
 *   every:Nh                 每 N 小时（N: 1..168）
 *
 * 时区处理思路：把 UTC 时刻加上偏移量得到「合成 UTC 空间」里的本地墙上时间，
 * 在该空间内做日历运算（无夏令时、无闰秒干扰），最后再减回偏移量。
 */

export type ScheduleKind = 'none' | 'hourly' | 'daily' | 'weekly' | 'interval';

export interface ParsedSchedule {
  kind: ScheduleKind;
  raw: string;
  /** daily / weekly：0-23 */
  hour: number;
  /** daily / weekly：0-59 */
  minute: number;
  /** weekly：0=周日 … 6=周六（升序去重） */
  days: number[];
  /** interval / hourly：间隔毫秒 */
  intervalMs: number;
}

const DAY_CODES: Record<string, number> = {
  SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
};

const DAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 默认时区偏移（分钟）：东八区 */
export const DEFAULT_TZ_OFFSET_MINUTES = 480;

const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

/** 间隔上限：分钟式最多 1 天，小时式最多 7 天 */
const MAX_INTERVAL_MINUTES = 1440;
const MAX_INTERVAL_HOURS = 168;

const RE_EVERY = /^every:(\d+)(m|h)$/;
const RE_WEEKLY = /^weekly@([a-z,]+)@(\d{1,2}):(\d{2})$/;
const RE_DAILY = /^daily@(\d{1,2}):(\d{2})$/;

/**
 * 解析调度表达式。
 * @returns 合法 → ParsedSchedule；**非法 → null**；空值 → `{kind:'none'}`
 */
export function parseSchedule(spec: unknown): ParsedSchedule | null {
  const raw = String(spec ?? '').trim();
  if (!raw) {
    return { kind: 'none', raw: '', hour: 0, minute: 0, days: [], intervalMs: 0 };
  }

  const lower = raw.toLowerCase();

  if (lower === 'hourly') {
    return { kind: 'hourly', raw, hour: 0, minute: 0, days: [], intervalMs: HOUR_MS };
  }

  const every = RE_EVERY.exec(lower);
  if (every) {
    const n = Number(every[1]);
    const unit = every[2];
    const ms = unit === 'm' ? n * MINUTE_MS : n * HOUR_MS;
    const max = unit === 'm' ? MAX_INTERVAL_MINUTES : MAX_INTERVAL_HOURS;
    if (!Number.isFinite(n) || n < 1 || n > max) return null;
    return { kind: 'interval', raw, hour: 0, minute: 0, days: [], intervalMs: ms };
  }

  const weekly = RE_WEEKLY.exec(lower);
  if (weekly) {
    const codes = weekly[1].split(',').filter(Boolean);
    if (!codes.length) return null;
    const days: number[] = [];
    for (const c of codes) {
      const d = DAY_CODES[c.toUpperCase()];
      if (d === undefined) return null;
      days.push(d);
    }
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (hour > 23 || minute > 59) return null;
    return {
      kind: 'weekly', raw, hour, minute,
      days: [...new Set(days)].sort((a, b) => a - b),
      intervalMs: 0,
    };
  }

  const daily = RE_DAILY.exec(lower);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return null;
    return { kind: 'daily', raw, hour, minute, days: [], intervalMs: 0 };
  }

  return null;
}

/** 表达式是否合法（空串视为合法：表示不自动执行） */
export function isValidSchedule(spec: unknown): boolean {
  return parseSchedule(spec) !== null;
}

/** 解析时区偏移（分钟）。非法值回退默认东八区 */
export function resolveTzOffset(env: unknown = process.env.SCHEDULER_TZ_OFFSET): number {
  const n = Number(env);
  if (!Number.isFinite(n)) return DEFAULT_TZ_OFFSET_MINUTES;
  return Math.min(840, Math.max(-720, Math.trunc(n)));
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * 计算 `from` 之后的第一次执行时刻（**严格晚于** from）。
 * @returns 不自动执行或表达式非法 → null
 */
export function nextRunAt(
  spec: unknown,
  from: Date | string | number,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES,
): Date | null {
  const p = parseSchedule(spec);
  if (!p || p.kind === 'none') return null;

  const base = toDate(from) || new Date();

  if (p.kind === 'interval') return new Date(base.getTime() + p.intervalMs);
  if (p.kind === 'hourly') {
    return new Date(Math.floor(base.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS);
  }

  // 日历类：先换算到「合成本地时间」空间
  const off = tzOffsetMinutes * MINUTE_MS;
  const local = new Date(base.getTime() + off);
  const anchor = new Date(Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    p.hour, p.minute, 0, 0,
  ));

  if (p.kind === 'daily') {
    if (anchor.getTime() <= local.getTime()) anchor.setUTCDate(anchor.getUTCDate() + 1);
    return new Date(anchor.getTime() - off);
  }

  // weekly：从今天起最多找 8 天（覆盖「今天已过点」→ 下周同一天）
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(anchor.getTime() + i * 86400000);
    if (!p.days.includes(d.getUTCDay())) continue;
    if (d.getTime() > local.getTime()) return new Date(d.getTime() - off);
  }
  return null;
}

/**
 * 是否已到期。
 * @param anchor 上次执行时刻；从未执行时传 null（会按纪元推算 → 立即到期）
 */
export function isDue(
  spec: unknown,
  anchor: Date | string | number | null,
  now: Date,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES,
): boolean {
  const p = parseSchedule(spec);
  if (!p || p.kind === 'none') return false;
  const next = nextRunAt(spec, anchor ?? new Date(0), tzOffsetMinutes);
  if (!next) return false;
  return next.getTime() <= now.getTime();
}

/** 中文文案，用于控制台与日志 */
export function describeSchedule(spec: unknown): string {
  const p = parseSchedule(spec);
  if (!p) return '表达式非法';
  const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;

  switch (p.kind) {
    case 'none':
      return '不自动执行';
    case 'hourly':
      return '每小时';
    case 'daily':
      return `每天 ${hhmm}`;
    case 'weekly': {
      const names = p.days.map((d) => DAY_TEXT[d]).join('、');
      return `每${names} ${hhmm}`;
    }
    case 'interval': {
      const m = p.intervalMs / MINUTE_MS;
      return Number.isInteger(m) && m < 60 ? `每 ${m} 分钟` : `每 ${p.intervalMs / HOUR_MS} 小时`;
    }
    default:
      return '表达式非法';
  }
}

export { DAY_TEXT, DAY_CODES };
