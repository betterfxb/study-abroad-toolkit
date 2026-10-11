/**
 * 订阅匹配引擎（契约 §6.2）。
 *
 * 纯函数、无 IO —— 便于单独测试与复用。编排与推送见 notifications.service.ts。
 *
 * 匹配规则：
 *   * keywords：对岗位的「可搜索文本」做大小写不敏感包含匹配。
 *     默认 **OR**（命中任一即通过，按命中率评分）；`requireAllKeywords` 时需全部命中。
 *   * cities：岗位城市与订阅城市任一相等（双向包含，兼容「北京 / 北京市」）。空 = 不限。
 *   * education：岗位学历为空或含「不限」时放行；否则需与订阅学历匹配。空 = 不限。
 *
 * 评分（0~1）：0.55×关键词命中率 + 0.25×城市权重 + 0.20×岗位置信度。
 */

export interface MatchInput {
  keywords: string[];
  cities: string[];
  education: string;
  requireAllKeywords?: boolean;
}

export interface JobLike {
  id: number;
  company?: string | null;
  title?: string | null;
  city?: string | null;
  education_req?: string | null;
  major_req?: string | null;
  tags?: string[] | null;
  confidence?: number | null;
  deadline?: string | null;
  salary?: string | null;
  article?: { title?: string | null; account_name?: string | null; url?: string | null; published_at?: string | null } | null;
}

export interface MatchResult {
  matched: boolean;
  /** 相关度 0~1，用于排序 */
  score: number;
  /** 命中的关键词 */
  hits: string[];
  /** 人类可读的匹配说明，便于排查与展示 */
  reason: string;
}

/** 把岗位拼成用于关键词检索的文本 */
export function jobSearchText(job: JobLike): string {
  return [
    job.company,
    job.title,
    job.major_req,
    job.city,
    ...(job.tags || []),
    job.article?.title,
    job.article?.account_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 城市/学历等短文本的宽松相等：任一方包含另一方即视为匹配 */
function looseEqual(a: string, b: string): boolean {
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 学历是否满足：岗位未要求 或 标注不限 时一律放行 */
function educationOk(want: string, jobEdu?: string | null): boolean {
  if (!want.trim()) return true;
  const have = (jobEdu || '').trim();
  if (!have || /不限|无要求|any/i.test(have)) return true;
  return looseEqual(want, have);
}

export function matchJob(sub: MatchInput, job: JobLike): MatchResult {
  const keywords = (sub.keywords || []).map((k) => k.trim()).filter(Boolean);
  const cities = (sub.cities || []).map((c) => c.trim()).filter(Boolean);
  const text = jobSearchText(job);

  // ---- 关键词
  const hits = keywords.filter((k) => text.includes(k.toLowerCase()));
  let kwScore: number;
  if (keywords.length === 0) {
    kwScore = 0.6; // 未设关键词：不参与筛选，给中性基础分
  } else {
    kwScore = hits.length / keywords.length;
    const pass = sub.requireAllKeywords ? hits.length === keywords.length : hits.length > 0;
    if (!pass) {
      return {
        matched: false,
        score: 0,
        hits,
        reason: sub.requireAllKeywords
          ? `关键词未全部命中（${hits.length}/${keywords.length}）`
          : '未命中任何关键词',
      };
    }
  }

  // ---- 城市
  if (cities.length > 0) {
    const cityHit = cities.some((c) => looseEqual(c, job.city || ''));
    if (!cityHit) {
      return { matched: false, score: 0, hits, reason: `城市不符（岗位：${job.city || '未知'}）` };
    }
  }

  // ---- 学历
  if (!educationOk(sub.education || '', job.education_req)) {
    return { matched: false, score: 0, hits, reason: `学历不符（岗位要求：${job.education_req}）` };
  }

  const cityWeight = cities.length > 0 ? 1 : 0.7;
  const conf = clamp01(Number(job.confidence ?? 0.5));
  const score = Math.round((0.55 * kwScore + 0.25 * cityWeight + 0.2 * conf) * 1000) / 1000;

  const parts: string[] = [];
  if (keywords.length) parts.push(`命中关键词 ${hits.join('、')}`);
  if (cities.length) parts.push(`城市 ${job.city}`);
  if ((sub.education || '').trim()) parts.push(`学历 ${job.education_req || '不限'}`);

  return {
    matched: true,
    score,
    hits,
    reason: parts.length ? parts.join(' · ') : '未设筛选条件，全量匹配',
  };
}

/**
 * 批量匹配并按相关度排序。
 * 返回命中的岗位（含岗位原文与匹配结果），已按 score desc、发布时间 desc 排序。
 */
export function matchJobs<T extends JobLike>(
  sub: MatchInput,
  jobs: T[],
): Array<{ job: T; result: MatchResult }> {
  const out: Array<{ job: T; result: MatchResult }> = [];
  for (const job of jobs) {
    const result = matchJob(sub, job);
    if (result.matched) out.push({ job, result });
  }
  out.sort((a, b) => {
    if (b.result.score !== a.result.score) return b.result.score - a.result.score;
    const ta = a.job.article?.published_at || '';
    const tb = b.job.article?.published_at || '';
    return tb.localeCompare(ta);
  });
  return out;
}

/** 渲染推送摘要（邮件主题 / webhook 标题共用） */
export function renderDigestTitle(subName: string, count: number): string {
  return count > 0 ? `【${subName}】为你找到 ${count} 个新实习岗位` : `【${subName}】暂无新岗位`;
}
