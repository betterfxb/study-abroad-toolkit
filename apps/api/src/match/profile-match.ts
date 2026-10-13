/**
 * 岗位匹配度评分引擎（Profile × Job）—— 纯函数、无 IO。
 *
 * 交叉复用：模块一结构化档案 × 模块二结构化岗位；岗位检索文本直接复用
 * notifications/matching 的 jobSearchText。LLM 语义精排留作二期（等 LLM_API_KEY）。
 *
 * 五维加权（WEIGHTS）：学历 0.30 / 专业 0.25 / 技能关键词 0.20 / 城市 0.15 / 数据质量 0.10。
 * 归一化：无信号维度标 na 并**剔出分母**（不双扣）；岗位学历「不限」为 neutral（got=1 放行）。
 * 档案侧四维（学历/专业/关键词/城市）全部无信号 → 判「档案信息不足」得 0 分
 * （数据质量是岗位侧信号，不能单独撑起分数）。
 *
 * 产出 0-100 整数分 + tier + 依据（factors）+ 差距（gaps），供控制台列表徽标与详情展示。
 */

import { JobLike, jobSearchText } from '../notifications/matching';

export interface ProfileLike {
  [k: string]: any;
}

export type FactorStatus = 'hit' | 'partial' | 'miss' | 'neutral' | 'na';

export type FactorKey = 'education' | 'major' | 'keywords' | 'city' | 'data';

export interface MatchFactor {
  key: FactorKey;
  /** 中文维度名 */
  label: string;
  status: FactorStatus;
  /** 0~1（na 时无意义） */
  got: number;
  weight: number;
  /** 人话依据，直接进 reason */
  note: string;
}

export interface JobMatchScore {
  id: any;
  /** 0-100 整数 */
  score: number;
  tier: '高匹配' | '中等' | '较低' | '低';
  reason: string;
  factors: MatchFactor[];
  /** miss 维度的差距描述（关键词 0 命中不产 gap，避免噪音） */
  gaps: string[];
}

export interface ScoreOptions {
  /** 订阅城市兜底（controller 合并传入，纯函数不碰 DB） */
  cities?: string[];
}

export const WEIGHTS = {
  education: 0.3,
  major: 0.25,
  keywords: 0.2,
  city: 0.15,
  data: 0.1,
} as const;

/** 档案侧维度（决定「档案信息不足」守卫） */
const PROFILE_DIMS: FactorKey[] = ['education', 'major', 'keywords', 'city'];

/** 学历关键词 → 秩（先博士后硕士，避免互相吞） */
const DEGREE_RULES: Array<[RegExp, number]> = [
  [/博士|ph\.?\s?d|doctorate/i, 5],
  [/硕士|研究生|master/i, 4],
  [/本科|学士|bachelor/i, 3],
  [/大专|专科|associate/i, 2],
  [/高中|中专|中技|high\s*school/i, 1],
];

/** 多值输入切分：逗号（中英）、顿号、空白（顿号必须在列，见 CLAUDE 教训） */
export function splitList(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  return s
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 学历字符串 → 秩（高中1 大专2 本科3 硕士4 博士5）；无法识别返回 null */
export function degreeRank(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  for (const [re, rank] of DEGREE_RULES) {
    if (re.test(s)) return rank;
  }
  return null;
}

export function tierOf(score: number): JobMatchScore['tier'] {
  if (score >= 80) return '高匹配';
  if (score >= 60) return '中等';
  if (score >= 40) return '较低';
  return '低';
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 宽松相等：任一方包含另一方（兼容「北京 / 北京市」「计算机 / 计算机科学」） */
function looseEqual(a: string, b: string): boolean {
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = (raw || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** 岗位学历要求中出现的所有秩取**最小**（「本科、硕士均可」按最宽口径） */
function jobReqRank(req: string): number | null {
  const ranks: number[] = [];
  for (const [re, rank] of DEGREE_RULES) {
    if (re.test(req)) ranks.push(rank);
  }
  return ranks.length ? Math.min(...ranks) : null;
}

interface NormalizedEdu {
  rank: number | null;
  label: string;
  majors: string[];
}

/** 教育双形状归一：契约数组 / 控制台写入的单对象，取最高秩与专业列表 */
function normalizeEducation(pf: ProfileLike): NormalizedEdu {
  const ed = pf.education;
  const entries: any[] = Array.isArray(ed) ? ed : ed && typeof ed === 'object' ? [ed] : [];
  let rank: number | null = null;
  let label = '';
  const majors: string[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const r = degreeRank(e.degree);
    if (r !== null && (rank === null || r > rank)) {
      rank = r;
      label = String(e.degree || '').trim();
    }
    if (typeof e.major === 'string' && e.major.trim()) majors.push(e.major.trim());
  }
  const dl = String((pf.preferences && pf.preferences.degree_level) || '');
  const dr = degreeRank(dl);
  if (dr !== null && (rank === null || dr > rank)) {
    rank = dr;
    label = dl.trim();
  }
  return { rank, label, majors };
}

/** 技能关键词 = 教育专业 ∪ 目标专业 ∪ 经历 role/org（去重，上限 30 防噪音） */
function collectKeywords(pf: ProfileLike, eduMajors: string[]): string[] {
  const out: string[] = [...eduMajors, ...splitList(pf.preferences && pf.preferences.target_majors)];
  const exps = Array.isArray(pf.experiences) ? pf.experiences : [];
  for (const e of exps) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.role === 'string' && e.role.trim()) out.push(e.role.trim());
    if (typeof e.org === 'string' && e.org.trim()) out.push(e.org.trim());
  }
  return dedupe(out).slice(0, 30);
}

function makeFactor(key: FactorKey, label: string, status: FactorStatus, got: number, note: string): MatchFactor {
  return { key, label, status, got, weight: WEIGHTS[key], note };
}

/** 专业要求后缀降噪：「计算机相关专业 / 金融专业优先 / 专业对口」→ 干净专名 */
function stripMajorNoise(s: string): string {
  return s
    .replace(/优先$/, '')
    .replace(/(相关|对口|相近)?专业$/, '')
    .trim();
}

/** 单岗位评分 */
export function scoreJobMatch(
  profile: ProfileLike | null | undefined,
  job: JobLike | null | undefined,
  opts: ScoreOptions = {},
): JobMatchScore {
  const pf: ProfileLike = profile && typeof profile === 'object' ? profile : {};
  const j: any = job && typeof job === 'object' ? job : {};
  const factors: MatchFactor[] = [];
  const gaps: string[] = [];

  const edu = normalizeEducation(pf);
  const pfMajors = dedupe([...edu.majors, ...splitList(pf.preferences && pf.preferences.target_majors)]);
  const keywords = collectKeywords(pf, edu.majors);
  const preferredCities = splitList(pf.preferences && pf.preferences.preferred_cities);
  const optCities = (Array.isArray(opts.cities) ? opts.cities : [])
    .map((c) => (typeof c === 'string' ? c.trim() : ''))
    .filter(Boolean);
  const cities = dedupe([...preferredCities, ...optCities]);

  // ---- 学历（0.30）
  {
    const req = typeof j.education_req === 'string' ? j.education_req.trim() : '';
    if (edu.rank === null) {
      factors.push(makeFactor('education', '学历', 'na', 0, '档案缺学历'));
    } else if (!req || /不限|无要求|\bany\b/i.test(req)) {
      factors.push(makeFactor('education', '学历', 'neutral', 1, '学历不限'));
    } else {
      const want = jobReqRank(req);
      if (want === null) {
        factors.push(makeFactor('education', '学历', 'neutral', 1, `学历要求未识别（${req}）`));
      } else if (edu.rank >= want) {
        const over = edu.rank > want;
        factors.push(makeFactor('education', '学历', 'hit', 1, over ? '学历匹配（超出要求）' : '学历匹配'));
      } else {
        factors.push(makeFactor('education', '学历', 'miss', 0, '学历不符'));
        gaps.push(`岗位要求${req}，档案为${edu.label || '未知'}`);
      }
    }
  }

  // ---- 专业（0.25）
  {
    const req = typeof j.major_req === 'string' ? j.major_req.trim() : '';
    if (!pfMajors.length) {
      factors.push(makeFactor('major', '专业', 'na', 0, '档案缺专业'));
    } else if (!req || /不限|无要求/i.test(req)) {
      factors.push(makeFactor('major', '专业', 'neutral', 1, '专业不限'));
    } else {
      // 顿号/逗号多值（「金融、数学、计算机」）逐项比；「X相关专业 / 专业优先」剥后缀
      const reqItems = splitList(req).map(stripMajorNoise).filter(Boolean);
      const hit = reqItems.length > 0 && pfMajors.some((m) => reqItems.some((ri) => looseEqual(m, ri)));
      if (!reqItems.length) {
        factors.push(makeFactor('major', '专业', 'neutral', 1, '专业要求未识别'));
      } else if (hit) {
        factors.push(makeFactor('major', '专业', 'hit', 1, '专业相关'));
      } else {
        factors.push(makeFactor('major', '专业', 'miss', 0, '专业不符'));
        gaps.push(`岗位要求${req}，档案专业为${pfMajors.join('、')}`);
      }
    }
  }

  // ---- 技能关键词（0.20）
  {
    if (!keywords.length) {
      factors.push(makeFactor('keywords', '技能关键词', 'na', 0, '无关键词信号'));
    } else {
      const text = jobSearchText((j || {}) as JobLike);
      const hits = keywords.filter((k) => text.includes(k.toLowerCase()));
      const got = hits.length / keywords.length;
      const status: FactorStatus = got >= 0.5 ? 'hit' : got > 0 ? 'partial' : 'miss';
      factors.push(makeFactor('keywords', '技能关键词', status, got, `关键词命中 ${hits.length}/${keywords.length}`));
    }
  }

  // ---- 城市（0.15）
  {
    if (!cities.length) {
      factors.push(makeFactor('city', '城市', 'na', 0, '未设期望城市'));
    } else {
      const jobCity = typeof j.city === 'string' ? j.city : '';
      const hit = cities.some((c) => looseEqual(c, jobCity));
      if (hit) {
        factors.push(makeFactor('city', '城市', 'hit', 1, `城市匹配（${jobCity || '未知'}）`));
      } else {
        factors.push(makeFactor('city', '城市', 'miss', 0, '城市不符'));
        gaps.push(`岗位在${jobCity || '未知城市'}，期望城市为${cities.join('、')}`);
      }
    }
  }

  // ---- 数据质量（0.10）
  {
    const raw = j.confidence;
    const conf = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (conf === null || !Number.isFinite(conf)) {
      factors.push(makeFactor('data', '数据质量', 'na', 0, '置信度缺失'));
    } else {
      const got = clamp01(conf);
      const status: FactorStatus = got >= 0.8 ? 'hit' : got >= 0.5 ? 'partial' : 'miss';
      factors.push(makeFactor('data', '数据质量', status, got, `数据质量 ${Math.round(got * 100)}%`));
    }
  }

  // ---- 归一化聚合
  const id = j.id;
  const profileApplicable = factors.filter((f) => f.status !== 'na' && PROFILE_DIMS.includes(f.key));
  if (!profileApplicable.length) {
    return {
      id,
      score: 0,
      tier: '低',
      reason: '档案信息不足，无法评分',
      factors,
      gaps: [...gaps, '完善学历、专业、期望城市等档案信息以获得匹配度评分'],
    };
  }
  const applicable = factors.filter((f) => f.status !== 'na');
  const wsum = applicable.reduce((s, f) => s + f.weight, 0);
  const gsum = applicable.reduce((s, f) => s + f.got * f.weight, 0);
  const score = Math.round((gsum / wsum) * 100);
  const tier = tierOf(score);
  const hitNotes = factors
    .filter((f) => f.status === 'hit' || f.status === 'partial')
    .map((f) => f.note);
  const reason = hitNotes.length ? hitNotes.slice(0, 4).join(' · ') : gaps[0] || '无明显匹配依据';
  return { id, score, tier, reason, factors, gaps };
}

/** 批量评分（保序，与入参 jobs 一一对应） */
export function scoreJobs(
  profile: ProfileLike | null | undefined,
  jobs: Array<JobLike | null | undefined>,
  opts: ScoreOptions = {},
): JobMatchScore[] {
  const list = Array.isArray(jobs) ? jobs : [];
  return list.map((j) => scoreJobMatch(profile, j, opts));
}
