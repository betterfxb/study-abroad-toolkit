/**
 * 成绩换算（纯函数，便于单测）。
 *
 * 两条标准刻度：
 *  - 美制 GPA 4.0（百分制 → 4.0 阶梯映射）
 *  - 英制学位等级（First / 2:1 / 2:2 / Third / Fail）
 * 加权 GPA = Σ(gp × 学分) / Σ(学分)
 *
 * 说明：阶梯映射为国内留学申请常用近似，仅作横向参考；
 * 各院校官方算法可能不同，以目标项目要求为准。
 */

export interface GpaCourseInput {
  /** 学分（>0 才参与加权） */
  credits: number;
  /** 百分制成绩 0-100 */
  score: number;
}

export interface GpaResult {
  /** 加权 GPA（4.0 制，保留 1 位） */
  gpa: number;
  /** 加权百分制均分（保留 1 位） */
  avgPct: number;
  /** 英制等级（按加权均分判断） */
  ukClass: string;
  /** 每门课程对应的 GPA 点 */
  points: number[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** 百分制 → 美制 4.0（阶梯映射） */
export function gpaFromScore(score: number): number {
  const s = clamp(score, 0, 100);
  if (s >= 90) return 4.0;
  if (s >= 85) return 3.7;
  if (s >= 82) return 3.3;
  if (s >= 78) return 3.0;
  if (s >= 75) return 2.7;
  if (s >= 72) return 2.3;
  if (s >= 68) return 2.0;
  if (s >= 64) return 1.5;
  if (s >= 60) return 1.0;
  return 0;
}

/** 百分制 → 英制学位等级 */
export function ukClassFromScore(score: number): string {
  const s = clamp(score, 0, 100);
  if (s >= 70) return 'First (一等荣誉)';
  if (s >= 60) return '2:1 (二等一)';
  if (s >= 50) return '2:2 (二等二)';
  if (s >= 40) return 'Third (三等)';
  return 'Fail (未达标)';
}

/** 加权换算：返回加权 GPA、加权均分、英制等级、各门 GPA 点 */
export function weightedGpa(courses: GpaCourseInput[]): GpaResult {
  const valid = courses.filter((c) => c.credits > 0 && Number.isFinite(c.score));
  if (valid.length === 0) {
    return { gpa: 0, avgPct: 0, ukClass: '—', points: [] };
  }
  let sumCred = 0;
  let sumGpCred = 0;
  let sumPctCred = 0;
  const points: number[] = [];
  for (const c of valid) {
    const gp = gpaFromScore(c.score);
    points.push(gp);
    sumCred += c.credits;
    sumGpCred += gp * c.credits;
    sumPctCred += c.score * c.credits;
  }
  const gpa = sumCred ? sumGpCred / sumCred : 0;
  const avgPct = sumCred ? sumPctCred / sumCred : 0;
  return {
    gpa: round1(gpa),
    avgPct: round1(avgPct),
    ukClass: ukClassFromScore(avgPct),
    points,
  };
}

/** 换算参照表（百分制区间 → GPA 4.0 → 英制） */
export const GPA_REFERENCE: { range: string; gpa: number; uk: string }[] = [
  { range: '90–100', gpa: 4.0, uk: 'First' },
  { range: '85–89', gpa: 3.7, uk: '2:1' },
  { range: '82–84', gpa: 3.3, uk: '2:1' },
  { range: '78–81', gpa: 3.0, uk: '2:1' },
  { range: '75–77', gpa: 2.7, uk: '2:2' },
  { range: '72–74', gpa: 2.3, uk: '2:2' },
  { range: '68–71', gpa: 2.0, uk: '2:2' },
  { range: '64–67', gpa: 1.5, uk: 'Third' },
  { range: '60–63', gpa: 1.0, uk: 'Third' },
  { range: '<60', gpa: 0, uk: 'Fail' },
];
