/**
 * 展示层格式化工具：状态映射、日期、薪资、文件大小、查询串拼装。
 * 全部为纯函数，方便单独测试与复用。
 */

export interface StatusMeta {
  text: string;
  tone: 'gray' | 'blue' | 'green' | 'orange' | 'red';
}

/** 申请状态（与网关 applications.service.ts 的 APPLICATION_STATUS 一致） */
export const APPLICATION_STATUS: Record<string, StatusMeta> = {
  draft: { text: '草稿', tone: 'gray' },
  in_progress: { text: '进行中', tone: 'blue' },
  submitted: { text: '已提交', tone: 'blue' },
  interview: { text: '面试中', tone: 'orange' },
  offer: { text: '已录取', tone: 'green' },
  rejected: { text: '未通过', tone: 'red' },
};

export const APPLICATION_STATUS_ORDER = [
  'draft', 'in_progress', 'submitted', 'interview', 'offer', 'rejected',
];

/** 推荐人状态 */
export const RECOMMENDER_STATUS: Record<string, StatusMeta> = {
  pending: { text: '待邀请', tone: 'gray' },
  invited: { text: '已邀请', tone: 'blue' },
  submitted: { text: '已提交', tone: 'green' },
};

/** 岗位状态 */
export const JOB_STATUS: Record<string, StatusMeta> = {
  active: { text: '在招', tone: 'green' },
  expired: { text: '已过期', tone: 'gray' },
  removed: { text: '已下架', tone: 'red' },
};

/** 推送状态 */
export const DELIVERY_STATUS: Record<string, StatusMeta> = {
  pending: { text: '待发送', tone: 'orange' },
  sent: { text: '已送达', tone: 'green' },
  failed: { text: '发送失败', tone: 'red' },
  skipped: { text: '已跳过', tone: 'gray' },
};

/** 推送渠道 */
export const CHANNEL_TEXT: Record<string, string> = {
  email: '邮件',
  wechat: '企业微信',
  webhook: 'Webhook',
};

/**
 * 订阅自动执行频率预设。
 * value 直接落库为调度表达式（语法见网关 `src/common/schedule.ts`）。
 */
export const SCHEDULE_PRESETS: { value: string; label: string }[] = [
  { value: '', label: '不自动执行（仅手动）' },
  { value: 'hourly', label: '每小时' },
  { value: 'daily@08:00', label: '每天 08:00' },
  { value: 'daily@09:00', label: '每天 09:00' },
  { value: 'daily@18:00', label: '每天 18:00' },
  { value: 'weekly@MO@09:00', label: '每周一 09:00' },
  { value: 'weekly@MO,WE,FR@09:00', label: '每周一 / 三 / 五 09:00' },
  { value: 'every:30m', label: '每 30 分钟' },
  { value: 'every:6h', label: '每 6 小时' },
];

/**
 * 组装下拉选项。
 * 若当前值不在预设里（用户此前填了自定义表达式），额外补一条，
 * 避免编辑订阅时被静默改写成预设值。
 */
export function scheduleOptions(current?: string): { value: string; label: string }[] {
  const v = String(current || '').trim();
  if (v && !SCHEDULE_PRESETS.some((p) => p.value === v)) {
    return [...SCHEDULE_PRESETS, { value: v, label: `自定义：${v}` }];
  }
  return SCHEDULE_PRESETS;
}

/** 材料类型（与网关 documents.service.ts 的 DOC_TYPES 一致） */
export const DOC_TYPES: Record<string, string> = {
  transcript: '成绩单',
  cv: '简历',
  ps: '个人陈述',
  rl: '推荐信',
  test: '语言/标化成绩',
  passport: '护照/身份',
  other: '其他',
};

export function statusMeta(map: Record<string, StatusMeta>, key?: string): StatusMeta {
  if (key && map[key]) return map[key];
  return { text: key || '未知', tone: 'gray' };
}

// ------------------------------------------------------------------ 日期
/** ISO 串 → YYYY-MM-DD */
export function fmtDate(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 串 → YYYY-MM-DD HH:mm */
export function fmtDateTime(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${fmtDate(v)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 距今天数：正数为剩余，负数为已过 */
export function daysLeft(v?: string | null): number | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** 截止日期的人性化提示 */
export function deadlineText(v?: string | null): { text: string; tone: StatusMeta['tone'] } {
  const d = daysLeft(v);
  if (d === null) return { text: '—', tone: 'gray' };
  if (d < 0) return { text: `已过 ${-d} 天`, tone: 'gray' };
  if (d === 0) return { text: '今天截止', tone: 'red' };
  if (d <= 7) return { text: `剩 ${d} 天`, tone: 'red' };
  if (d <= 30) return { text: `剩 ${d} 天`, tone: 'orange' };
  return { text: `剩 ${d} 天`, tone: 'green' };
}

// ------------------------------------------------------------------ 数值
/** 文件大小 */
export function fmtSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/** 置信度 0~1 → 百分比文本 */
export function fmtConfidence(v?: number | null): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${Math.round(Number(v) * 100)}%`;
}

/** 置信度色阶：>=0.8 绿 / >=0.6 橙 / 其余灰 */
export function confidenceTone(v?: number | null): StatusMeta['tone'] {
  const n = Number(v);
  if (!Number.isFinite(n)) return 'gray';
  if (n >= 0.8) return 'green';
  if (n >= 0.6) return 'orange';
  return 'gray';
}

/** 薪资展示：空值统一为「面议」 */
export function fmtSalary(v?: string | null): string {
  const s = (v || '').trim();
  return s || '面议';
}

/** 截断长文本 */
export function shortText(v: string | null | undefined, max = 60): string {
  const s = (v || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * 把「关键词 / 城市」这类多值输入拆成数组。
 *
 * 分隔符覆盖半角逗号、全角逗号、顿号与空白 —— 其中**顿号必须支持**：
 * 界面提示与占位符示例（"数据分析、SQL"）用的就是顿号，而网关侧的
 * `toJsonArray` 历史上只认 `[,，\s]`，不含顿号，导致按提示输入会被当成
 * **一个关键词**，订阅永远匹配不到任何岗位。
 *
 * 前端在这里拆好并以**数组**提交，网关对数组原样采用，不再依赖它的字符串拆分规则。
 */
export function splitList(v: string): string[] {
  return v.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
}

// ------------------------------------------------------------------ 高亮与引导
export interface HlPart {
  text: string;
  hit: boolean;
}

/**
 * 关键词高亮切分（纯函数，供岗位表扫读）。
 *
 * 多词按与 splitList 一致的分隔符拆（`, ， 、 空格`，界面与解析一致），
 * 转义后做大小写不敏感匹配；空关键词/空文本原样返回，不断链。
 */
export function highlightParts(text: string | null | undefined, keyword: string): HlPart[] {
  const src = text ?? '';
  const terms = String(keyword || '')
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!src || terms.length === 0) return [{ text: src, hit: false }];
  const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${esc.join('|')})`, 'gi');
  const parts: HlPart[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push({ text: src.slice(last, m.index), hit: false });
    parts.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (last < src.length) parts.push({ text: src.slice(last), hit: false });
  return parts;
}

/** 新手引导横幅的 localStorage 键（关闭后不再展示） */
export const GUIDE_KEY = 'qz.guide.v1';

// ------------------------------------------------------------------ 查询串
export type QueryValue = string | number | boolean | null | undefined;

/**
 * 拼装查询串：跳过空值，自动 encode。
 * buildQuery({page:1, keyword:''}) → '?page=1'
 */
export function buildQuery(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
