/**
 * 从一条岗位一键生成订阅草稿（纯函数，便于独立测试）。
 *
 * 设计意图：用户在「实习信息汇总」里看中一个岗位，往往想「持续跟踪这类岗位」。
 * 与其让他去订阅 Tab 从头填 8 个字段，这里按当前岗位的字段**预填**好一条订阅，
 * 点一下即可创建，把「建订阅」的 8 字段降到 1 次点击。
 *
 * 预填规则：
 *   * 关键词 = 公司名 + 标题里抽出的关键词（2 字以上、最多 3 个）+ 岗位标签，去重
 *     - 公司名是最强信号（同一公司的后续岗位都该被召回）
 *     - 标题关键词做召回补充；标签是岗位自带的主题词
 *   * 城市 = 当前岗位城市（空则不限制）
 *   * 默认：邮件渠道、每天 09:00 自动执行、启用、任一关键词命中即召回（宽召回）
 */

import type { Job } from './api';

export interface SubscriptionDraft {
  name: string;
  keywords: string[];
  cities: string[];
  education: string;
  channel: string;
  webhook_url: string;
  require_all_keywords: boolean;
  enabled: boolean;
  schedule: string;
}

/**
 * 从岗位构造订阅草稿。
 * @param job 只需 company / title / city / tags 四个字段
 */
export function buildSubscriptionFromJob(
  job: Pick<Job, 'company' | 'title' | 'city' | 'tags'>,
): SubscriptionDraft {
  const company = (job.company || '').trim();
  const city = (job.city || '').trim();
  const title = (job.title || '').trim();

  // 去掉公司名后，按空白 / 顿号 / 逗号 / 斜杠 / 间隔号切分标题，取 2 字以上的有效词（最多 3 个）
  const cleaned = company ? title.replace(company, '') : title;
  const titleTokens = cleaned
    .split(/[\s、,，/｜|·]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 3);

  const kw = new Set<string>();
  if (company) kw.add(company);
  titleTokens.forEach((t) => kw.add(t));
  (job.tags || []).forEach((t) => kw.add(t));

  const name = `${company || '岗位'}${city ? `·${city}` : ''} 订阅`;

  return {
    name,
    keywords: [...kw],
    cities: city ? [city] : [],
    education: '',
    channel: 'email',
    webhook_url: '',
    require_all_keywords: false,
    enabled: true,
    schedule: 'daily@09:00',
  };
}
