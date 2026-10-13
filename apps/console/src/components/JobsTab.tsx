/**
 * Tab 2 · 实习信息汇总：多条件筛选 + 岗位表格 + 详情弹窗 + CSV 导出。
 *
 * 数据来自网关代理的 crawler-service 岗位库（读侧无需鉴权）。
 * 筛选条件与 crawler `/jobs` 的参数严格对齐：keyword / city / company /
 * education / status / min_confidence / sort / page / size。
 *
 * 体验改造（本轮）：
 *   * 请求统一走 `useRequest`：竞态保护（只认最后一次结果）+ 首屏/静默刷新区分
 *   * 「静默刷新」：重新筛选时保留上一次数据并轻微降透明度，不再整表闪空
 *   * 首屏用骨架行占位，行高与真实行一致，避免加载完成时布局跳动
 *   * 表格套 `.table-wrap`，列多时窄屏横向滚动，不再撑破页面
 */

import { useMemo, useState } from 'react';
import {
  ApiError, api, jobsExportUrl, matchJobPayload,
  type Facets, type Job, type MatchScore, type PageResult,
} from '../lib/api';
import {
  JOB_STATUS, buildQuery, confidenceTone, deadlineText, fmtConfidence, fmtDate, fmtSalary,
  highlightParts, matchTone, shortText, statusMeta,
} from '../lib/format';
import { useDebounced, useRequest } from '../lib/useRequest';
import { useAuth, type AuthState, type AuthUser } from '../lib/auth';
import { buildSubscriptionFromJob } from '../lib/jobSubscribe';
import { useToast } from './Toasts';

const SIZE = 20;

const SORT_OPTIONS = [
  { value: 'published_at:desc', label: '最新发布' },
  { value: 'deadline:asc', label: '截止最近' },
  { value: 'confidence:desc', label: '置信度最高' },
  { value: 'id:desc', label: '最近入库' },
];

const CONF_OPTIONS = [
  { value: '', label: '全部置信度' },
  { value: '0.8', label: '≥ 80%' },
  { value: '0.6', label: '≥ 60%' },
];

export function JobsTab({ onNeedAuth }: { onNeedAuth: () => void }) {
  const toast = useToast();
  const { user, authed } = useAuth();

  const [keyword, setKeyword] = useState('');
  const debouncedKw = useDebounced(keyword.trim(), 350);
  const [city, setCity] = useState('');
  const [education, setEducation] = useState('');
  const [status, setStatus] = useState('active');
  const [minConf, setMinConf] = useState('');
  const [sort, setSort] = useState('published_at:desc');
  const [detailJob, setDetailJob] = useState<Job | null>(null);

  // —— 在线表格能力（P1）：列显隐 + 表头点击排序 + 本页就地筛选 ——
  const [visible, setVisible] = useState<Record<string, boolean>>({
    company: true, match: true, city: true, salary: true, education: true,
    retain: true, deadline: true, confidence: true, source: true,
  });
  const [colFilters, setColFilters] = useState<{ company: string; city: string }>({ company: '', city: '' });
  const [colMenu, setColMenu] = useState(false);

  const COL_LABELS: Record<string, string> = {
    company: '公司与岗位', match: '匹配度', city: '城市', salary: '薪资', education: '学历',
    retain: '留用', deadline: '截止', confidence: '置信度', source: '来源',
  };
  const onHeaderSort = (field: string) => {
    const [f, d] = sort.split(':');
    if (f === field) setSort(`${field}:${d === 'asc' ? 'desc' : 'asc'}`);
    else setSort(`${field}:desc`);
  };
  const sortIndicator = (field: string) => {
    const [f, d] = sort.split(':');
    if (f !== field) return '';
    return d === 'asc' ? ' ▲' : ' ▼';
  };

  // 筛选条件变化即回到第一页。这里在**渲染期**同步修正（React 官方推荐的
  // "adjusting state during render"），比用 useEffect 少一轮「旧 page + 新筛选」的无效请求。
  const filterKey = `${debouncedKw}|${city}|${education}|${status}|${minConf}|${sort}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  const [page, setPage] = useState(1);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query = useMemo(() => buildQuery({
    keyword: debouncedKw,
    city,
    education,
    status,
    min_confidence: minConf,
    sort,
    page,
    size: SIZE,
  }), [debouncedKw, city, education, status, minConf, sort, page]);

  const jobs = useRequest<PageResult<Job>>(() => api.jobs(query), [query]);
  const facets = useRequest<Facets>(
    () => api.facets(buildQuery({ status, top: 20 })),
    [status],
  );

  const data = jobs.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.size || SIZE))) : 1;

  // —— 功能 B · 匹配度：登录后按本人档案为当前页岗位批量打分 ——
  // 评分失败静默降级为空表（fail-open，绝不影响列表浏览）；数据/登录态变化即重取。
  const matchMap = useRequest<Record<number, MatchScore>>(async () => {
    const items = data?.items;
    if (!user || !items?.length) return {};
    try {
      const res = await authed((t) => api.matchJobs(t, items.map(matchJobPayload)));
      const map: Record<number, MatchScore> = {};
      for (const s of res.scores) map[s.id] = s;
      return map;
    } catch {
      return {};
    }
  }, [data, user?.userId ?? 0]);

  // 本页就地筛选（客户端，仅作用于当前已加载页；与服务端筛选互补）
  const displayItems = useMemo(() => {
    if (!data) return [];
    const kwC = colFilters.company.trim().toLowerCase();
    const kwCity = colFilters.city.trim().toLowerCase();
    return data.items.filter((j) => {
      if (kwC && !`${j.company || ''} ${j.title || ''}`.toLowerCase().includes(kwC)) return false;
      if (kwCity && !(j.city || '').toLowerCase().includes(kwCity)) return false;
      return true;
    });
  }, [data, colFilters]);
  // 静默刷新：已有数据且正在拉取 → 保留表格、轻微降透明度
  const refreshing = jobs.pending && data !== null;

  const exportCsv = () => {
    window.open(jobsExportUrl(query), '_blank', 'noopener');
    toast.info('已开始导出 CSV（Excel 可直接打开）');
  };

  const reset = () => {
    setKeyword(''); setCity(''); setEducation(''); setStatus('active');
    setMinConf(''); setSort('published_at:desc'); setPage(1);
  };

  return (
    <>
      <div className="panel">
        <div className="panel-title">
          岗位筛选
          <span className="sub">数据来自公众号 / 招聘平台 / 官网多源聚合</span>
          <span className="panel-actions">
            <button className="btn sm" onClick={() => setColMenu((m) => !m)}>列</button>
            <button className="btn sm" onClick={reset}>重置</button>
            <button className="btn sm" onClick={jobs.reload} disabled={jobs.pending}>
              {jobs.pending ? '刷新中…' : '刷新'}
            </button>
            <button className="btn primary sm" onClick={exportCsv}>导出 CSV</button>
          </span>
        </div>

        <div className="filters">
          <input
            placeholder="搜索公司 / 岗位关键词，如：数据分析"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="">全部城市</option>
            {facets.data?.cities.map((c) => (
              <option key={c.value} value={c.value}>{c.value}（{c.count}）</option>
            ))}
          </select>
          <select value={education} onChange={(e) => setEducation(e.target.value)}>
            <option value="">全部学历</option>
            {facets.data?.educations.map((c) => (
              <option key={c.value} value={c.value}>{c.value}（{c.count}）</option>
            ))}
          </select>
          <select value={minConf} onChange={(e) => setMinConf(e.target.value)}>
            {CONF_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">仅在招</option>
            <option value="expired">已过期</option>
            <option value="all">全部状态</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div className="stat">
          <span>命中 <b>{data?.total ?? 0}</b> 条</span>
          <span>本页 <b>{data?.items.length ?? 0}</b> 条</span>
          {facets.data?.companies?.length
            ? <span>覆盖公司 <b>{facets.data.companies.length}</b> 家</span>
            : null}
        </div>

        {colMenu && (
          <div className="flex flex-wrap gap-[8px] mt-[10px]">
            {Object.keys(COL_LABELS).map((k) => (
              <label key={k} className="flex items-center gap-[4px] text-[13px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={visible[k]}
                  onChange={() => setVisible((v) => ({ ...v, [k]: !v[k] }))}
                />
                {COL_LABELS[k]}
              </label>
            ))}
          </div>
        )}

        {/* 首屏：骨架行占位（行高与真实行一致，避免加载完跳动） */}
        {jobs.initial && jobs.pending && <SkeletonRows rows={6} />}

        {!jobs.initial && jobs.error && (
          <div className="empty">
            <div className="big">⚠</div>
            {jobs.error}
            <div className="note">采集服务可能未启动（默认 8100 端口），启动后重试即可。</div>
            <div className="mt-[14px]">
              <button className="btn primary sm" onClick={jobs.reload}>重试</button>
            </div>
          </div>
        )}

        {data && data.items.length === 0 && !jobs.pending && (
          <div className="empty">
            <div className="big">🗂</div>
            当前条件下暂无岗位，试试放宽筛选条件。
            <div className="mt-[14px]">
              <button className="btn sm" onClick={reset}>重置筛选</button>
            </div>
          </div>
        )}

        {data && data.items.length > 0 && (
          <>
            <div className={`table-wrap${refreshing ? ' refreshing' : ''}`}>
              <table>
                <thead>
                  <tr>
                    {visible.company && (
                      <th className="cursor-pointer select-none" onClick={() => onHeaderSort('company')}>
                        {COL_LABELS.company}{sortIndicator('company')}
                        <input
                          className="w-full mt-[4px] text-[12px]"
                          placeholder="筛选"
                          value={colFilters.company}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setColFilters((f) => ({ ...f, company: e.target.value }))}
                        />
                      </th>
                    )}
                    {visible.match && <th>匹配度</th>}
                    {visible.city && (
                      <th className="cursor-pointer select-none" onClick={() => onHeaderSort('city')}>
                        {COL_LABELS.city}{sortIndicator('city')}
                        <input
                          className="w-full mt-[4px] text-[12px]"
                          placeholder="筛选"
                          value={colFilters.city}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setColFilters((f) => ({ ...f, city: e.target.value }))}
                        />
                      </th>
                    )}
                    {visible.salary && <th>薪资</th>}
                    {visible.education && <th>学历</th>}
                    {visible.retain && <th>留用</th>}
                    {visible.deadline && (
                      <th className="cursor-pointer select-none" onClick={() => onHeaderSort('deadline')}>
                        {COL_LABELS.deadline}{sortIndicator('deadline')}
                      </th>
                    )}
                    {visible.confidence && (
                      <th className="cursor-pointer select-none" onClick={() => onHeaderSort('confidence')}>
                        {COL_LABELS.confidence}{sortIndicator('confidence')}
                      </th>
                    )}
                    {visible.source && <th>来源</th>}
                  </tr>
                </thead>
                <tbody>
                  {displayItems.map((j) => {
                    const dl = deadlineText(j.deadline);
                    const st = statusMeta(JOB_STATUS, j.status);
                    return (
                      <tr key={j.id} onClick={() => setDetailJob(j)} className="cursor-pointer">
                        {visible.company && (
                          <td>
                            <div className="co"><Hl text={j.company || '—'} kw={debouncedKw} /></div>
                            <div><Hl text={j.title || '—'} kw={debouncedKw} /></div>
                            {j.tags?.length ? (
                              <div className="mt-[4px]">
                                {j.tags.slice(0, 3).map((t) => <span key={t} className="tag">{t}</span>)}
                              </div>
                            ) : null}
                          </td>
                        )}
                        {visible.match && (
                          <td>
                            <MatchCell
                              score={matchMap.data?.[j.id]}
                              hasUser={!!user}
                              pending={matchMap.pending && matchMap.data === null}
                            />
                          </td>
                        )}
                        {visible.city && <td><Hl text={j.city || '—'} kw={debouncedKw} /></td>}
                        {visible.salary && <td className="money">{fmtSalary(j.salary)}</td>}
                        {visible.education && <td>{j.education_req || '不限'}</td>}
                        {visible.retain && <td>{j.retain_chance || '—'}</td>}
                        {visible.deadline && (
                          <td>
                            <div>{fmtDate(j.deadline)}</div>
                            <span className={`badge ${dl.tone}`}>{dl.text}</span>
                          </td>
                        )}
                        {visible.confidence && (
                          <td>
                            <span className={`badge ${confidenceTone(j.confidence)}`}>
                              {fmtConfidence(j.confidence)}
                            </span>
                          </td>
                        )}
                        {visible.source && (
                          <td className="src">
                            <div>{j.article?.account_name || '—'}</div>
                            <div>{shortText(j.article?.title, 18)}</div>
                            <span className={`badge ${st.tone}`}>{st.text}</span>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="pager">
              <span>第 {data.page} / {totalPages} 页</span>
              <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
            </div>
          </>
        )}
      </div>

      {detailJob && (
        <JobDetail
          job={detailJob}
          kw={debouncedKw}
          score={matchMap.data?.[detailJob.id]}
          matchPending={matchMap.pending}
          onClose={() => setDetailJob(null)}
          onNeedAuth={onNeedAuth}
          user={user}
          authed={authed}
        />
      )}
    </>
  );
}

/** 关键词高亮：命中词套 mark.hl，其余原样（空关键词不断链） */
function Hl({ text, kw }: { text?: string | null; kw: string }) {
  const parts = highlightParts(text, kw);
  return (
    <>
      {parts.map((p, i) => (p.hit ? (
        <mark key={i} className="hl">{p.text}</mark>
      ) : (
        <span key={i}>{p.text}</span>
      )))}
    </>
  );
}

/** 匹配度单元格：未登录引导 / 评分徽标（title 带 tier 与依据）/ 加载与降级态 */
function MatchCell({ score, hasUser, pending }: {
  score?: MatchScore;
  hasUser: boolean;
  pending: boolean;
}) {
  if (score) {
    return (
      <span
        className={`badge ${matchTone(score.score)}`}
        title={`${score.tier} · ${score.reason}`}
      >
        {score.score}
      </span>
    );
  }
  if (!hasUser) return <span className="badge gray" title="登录并完善档案后，按你的档案评估匹配度">—</span>;
  if (pending) return <span className="text-[12px] text-[#94a3b8]">…</span>;
  return <span className="badge gray" title="评分暂不可用，稍后刷新重试">—</span>;
}

/** 骨架行：宽度刻意做成不等宽，视觉上更像真实内容 */
function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="skeleton">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="skeleton-row" key={i}>
          <i className="w-[30%]" />
          <i className="w-[10%]" />
          <i className="w-[12%]" />
          <i className="w-[8%]" />
          <i className="w-[8%]" />
          <i className="w-[12%]" />
        </div>
      ))}
    </div>
  );
}

/** 因子状态 → 展示文案与色调（与网关 profile-match.ts 的 FactorStatus 对齐） */
const FACTOR_STATUS: Record<string, { text: string; tone: 'gray' | 'blue' | 'green' | 'orange' | 'red' }> = {
  hit: { text: '命中', tone: 'green' },
  partial: { text: '部分命中', tone: 'orange' },
  miss: { text: '未命中', tone: 'red' },
  neutral: { text: '中立', tone: 'gray' },
  na: { text: '无信号', tone: 'gray' },
};

/** 详情内匹配度评估块：总分 + 五维因子 + 差距；未登录时给登录引导 */
function MatchPanel({ score, pending, user, onNeedAuth }: {
  score?: MatchScore;
  pending: boolean;
  user: AuthUser | null;
  onNeedAuth: () => void;
}) {
  if (!user) {
    return (
      <div className="note mt-[14px]">
        登录并完善档案后，这里会给出与你条件的匹配度评估（学历 / 专业 / 关键词 / 城市 / 数据质量）。
        <button className="btn sm ml-[8px]" onClick={onNeedAuth}>登录查看匹配度</button>
      </div>
    );
  }
  if (!score) {
    return (
      <div className="note mt-[14px]">
        {pending ? '正在按你的档案评估匹配度…' : '匹配度暂不可用，稍后刷新重试。'}
      </div>
    );
  }
  return (
    <div className="panel mt-[14px]">
      <div className="panel-title">
        匹配度评估
        <span className="sub">{score.reason}</span>
      </div>
      <div className="flex items-center gap-[10px] mb-[10px]">
        <span className={`badge ${matchTone(score.score)}`}>{score.score} 分</span>
        <b>{score.tier}</b>
      </div>
      <div className="form-grid">
        {score.factors.map((f) => {
          const meta = FACTOR_STATUS[f.status] || { text: f.status, tone: 'gray' as const };
          return (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <div className="flex items-center gap-[6px] text-[13px] flex-wrap">
                <span className={`badge ${meta.tone}`}>{meta.text}</span>
                <span className="text-[#64748b]">{f.note}</span>
              </div>
            </div>
          );
        })}
      </div>
      {score.gaps.length > 0 && (
        <div className="note mt-[8px]">差距：{score.gaps.join('；')}</div>
      )}
    </div>
  );
}

function JobDetail({
  job, kw, score, matchPending, onClose, onNeedAuth, user, authed,
}: {
  job: Job;
  kw: string;
  score?: MatchScore;
  matchPending: boolean;
  onClose: () => void;
  onNeedAuth: () => void;
  user: AuthUser | null;
  authed: AuthState['authed'];
}) {
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = useMemo(() => buildSubscriptionFromJob(job), [job]);

  /** 复制投递方式（邮箱 / 链接文本）：clipboard 不可用时降级为 textarea 方案 */
  const copyApply = async () => {
    const text = job.apply_method || '';
    if (!text.trim()) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      toast.ok('投递方式已复制，去投递吧');
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.err('复制失败，请手动复制');
    }
  };

  /** 一键按当前岗位预填规则建订阅：未登录先引导登录，否则走 authed 创建 */
  const buildSub = async () => {
    if (!user) {
      onNeedAuth();
      toast.info('登录后即可一键订阅该岗位');
      return;
    }
    setCreating(true);
    try {
      await authed((t) => api.createSubscription(t, draft));
      setCreated(true);
      toast.ok(`已创建订阅「${draft.name}」，每天 09:00 自动推送同类新岗位`);
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '创建订阅失败');
    } finally {
      setCreating(false);
    }
  };

  const dl = deadlineText(job.deadline);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          岗位详情
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-b">
          <div className="panel-title mb-[10px]">
            <Hl text={job.title || '—'} kw={kw} />
            <span className="sub"><Hl text={job.company || '—'} kw={kw} /></span>
          </div>

          <div className="stat">
            <span>城市 <b>{job.city || '—'}</b></span>
            <span>薪资 <b className="money">{fmtSalary(job.salary)}</b></span>
            <span>时长 <b>{job.duration || '—'}</b></span>
            <span>截止 <b>{fmtDate(job.deadline)}</b> <span className={`badge ${dl.tone}`}>{dl.text}</span></span>
          </div>

          <MatchPanel score={score} pending={matchPending} user={user} onNeedAuth={onNeedAuth} />

          <div className="form-grid">
            <div className="field">
              <label>学历要求</label>
              <div>{job.education_req || '不限'}</div>
            </div>
            <div className="field">
              <label>专业要求</label>
              <div>{job.major_req || '不限'}</div>
            </div>
            <div className="field">
              <label>留用机会</label>
              <div>{job.retain_chance || '—'}</div>
            </div>
            <div className="field">
              <label>置信度</label>
              <div>
                <span className={`badge ${confidenceTone(job.confidence)}`}>
                  {fmtConfidence(job.confidence)}
                </span>
              </div>
            </div>
            <div className="field full">
              <label>投递方式</label>
              <div className="whitespace-pre-wrap">{job.apply_method || '—'}</div>
            </div>
            {job.tags?.length ? (
              <div className="field full">
                <label>标签</label>
                <div>{job.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
              </div>
            ) : null}
          </div>

          <div className="note mt-[16px]">
            来源：{job.article?.account_name || '—'} · {job.article?.title || '—'} ·
            {' '}发布时间 {fmtDate(job.article?.published_at)}
          </div>
        </div>

        <div className="note mt-[16px]">
          想持续跟踪这类岗位？点「一键订阅」，系统会按当前公司 / 城市 / 标签预填规则，
          每天 09:00 自动匹配并推送同类新职位。
        </div>

        <div className="modal-f">
          {job.article?.url && (
            <a className="btn" href={job.article.url} target="_blank" rel="noopener noreferrer">
              查看原文
            </a>
          )}
          {job.apply_url && (
            <a className="btn primary" href={job.apply_url} target="_blank" rel="noopener noreferrer">
              前往投递
            </a>
          )}
          <button className="btn" onClick={buildSub} disabled={creating || created}>
            {created ? '已订阅 ✓' : creating ? '创建中…' : '一键订阅该岗位'}
          </button>
          <button className="btn" onClick={copyApply} disabled={!job.apply_method?.trim()}>
            {copied ? '已复制 ✓' : '复制投递方式'}
          </button>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
