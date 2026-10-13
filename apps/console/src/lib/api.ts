/**
 * API 客户端：封装网关契约「通用响应」`{code, message, data, trace_id}`。
 *
 * 约定：
 *   * 默认走相对路径（开发期由 Vite 代理到 api-gateway，生产由 Nginx 反代）
 *   * code !== 0 一律抛 ApiError，调用方只需 try/catch
 *   * 401（code 1002）触发一次自动刷新，失败则登出
 */

export interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  trace_id: string;
}

export class ApiError extends Error {
  // 显式字段而非构造参数属性：参数属性需要 transform，Node 类型擦除（strip-only）不支持
  readonly code: number;
  readonly status: number;

  constructor(code: number, message: string, status: number = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }

  /** 未认证 */
  get isAuthError() {
    return this.code === 1002;
  }
}

const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) || '';

/** 业务错误码 → 中文提示（兜底用服务端 message） */
export const ERROR_TEXT: Record<number, string> = {
  1001: '参数校验失败',
  1002: '登录已失效，请重新登录',
  1003: '无权限访问',
  2001: '资源不存在',
  3001: '页面需要人机验证，请人工处理',
  4002: '采集服务暂不可用',
  5001: 'AI 服务调用失败',
  9001: '触发合规约束，已拒绝执行',
};

interface ReqOptions {
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  raw?: boolean;
}

async function request<T>(method: string, path: string, opts: ReqOptions = {}): Promise<T> {
  const { body, token, headers = {}, raw = false } = opts;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (raw) return (await res.text()) as unknown as T;

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(5000, `响应格式异常（HTTP ${res.status}）`, res.status);
  }

  if (!json || typeof json.code !== 'number') {
    throw new ApiError(5000, `响应格式异常（HTTP ${res.status}）`, res.status);
  }
  if (json.code !== 0) {
    throw new ApiError(json.code, json.message || ERROR_TEXT[json.code] || '请求失败', res.status);
  }
  return json.data as T;
}

// ------------------------------------------------------------------ 类型
export interface TokenBundle {
  user_id: number;
  email: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface Institution {
  id: number;
  name: string;
  country: string;
  program: string;
  platform: string;
  deadline: string;
}

export interface Application {
  id: number;
  institution_name: string;
  program: string;
  platform: string;
  status: string;
  progress: number;
  deadline: string;
  notes: string;
  updated_at: string;
}

export interface Recommender {
  id: number;
  name: string;
  email: string;
  title: string;
  org: string;
  status: string;
  invited_at: string;
}

export interface Subscription {
  id: number;
  name: string;
  keywords: string[];
  cities: string[];
  education: string;
  channel: string;
  enabled: boolean;
  require_all_keywords: boolean;
  webhook_url: string;
  last_run_at: string;
  /** 自动执行表达式（空 = 仅手动）；语法见网关 common/schedule.ts */
  schedule: string;
  /** 表达式的中文说明，由服务端渲染 */
  schedule_text: string;
  /** 下次自动执行时刻（ISO 8601，空 = 不再自动执行） */
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

/** 订阅预览：命中的岗位附带匹配分与说明 */
export interface PreviewResult {
  subscription: Subscription;
  window_days: number;
  scanned: number;
  matched: number;
  items: (Job & { match_score: number; match_reason: string; match_hits: string[] })[];
}

export interface RunResult {
  subscription_id: number;
  name: string;
  window_days: number;
  scanned: number;
  matched: number;
  delivered: number;
  duplicate: number;
  status: string;
  channel: string;
  error: string;
}

export interface DeliveryItem {
  id: number;
  subscription_id: number;
  job_id: number;
  channel: string;
  status: string;
  score: number;
  title: string;
  error: string;
  created_at: string;
  sent_at: string;
  payload: {
    subject?: string;
    count?: number;
    items?: Array<{
      id: number; company: string; title: string; city: string;
      salary: string; deadline: string; url: string; source: string; score: number;
    }>;
  };
}

export interface DeliveryStats {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface Job {
  id: number;
  company: string;
  title: string;
  city: string;
  salary: string;
  duration: string;
  education_req: string;
  major_req: string;
  retain_chance: string;
  apply_method: string;
  apply_url?: string;
  deadline: string | null;
  confidence: number | null;
  status: string;
  tags: string[];
  created_at?: string | null;
  article?: { id: number; title: string; account_name: string; url: string; published_at: string };
}

export interface PageResult<T> {
  total: number;
  page: number;
  size: number;
  items: T[];
}

// ---- 功能 B · 岗位匹配度（POST /api/v1/match/jobs，契约 §6）----

/** 评分端点入参：只带评分需要的字段（与网关 jobSearchText 对齐） */
export interface MatchJobInput {
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
  article?: { title?: string | null; account_name?: string | null } | null;
}

export type MatchFactorStatus = 'hit' | 'partial' | 'miss' | 'neutral' | 'na';

export interface MatchFactor {
  key: string;
  label: string;
  status: MatchFactorStatus;
  /** 0~1 */
  got: number;
  weight: number;
  note: string;
}

export interface MatchScore {
  id: number;
  /** 0-100 整数 */
  score: number;
  tier: string;
  reason: string;
  factors: MatchFactor[];
  gaps: string[];
}

/** Job → 评分入参（纯函数，便于测试） */
export function matchJobPayload(job: Job): MatchJobInput {
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    city: job.city,
    education_req: job.education_req,
    major_req: job.major_req,
    tags: job.tags,
    confidence: job.confidence,
    deadline: job.deadline ?? null,
    salary: job.salary,
    article: job.article
      ? { title: job.article.title, account_name: job.article.account_name }
      : null,
  };
}

export interface Facets {
  cities: { value: string; count: number }[];
  companies: { value: string; count: number }[];
  educations: { value: string; count: number }[];
  tags: { value: string; count: number }[];
}

export interface DocItem {
  id: number;
  doc_type: string;
  file_name: string;
  file_key: string;
  mime: string;
  file_size: number;
  created_at: string;
}

export interface ResumeSummary {
  id: number;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ServiceHealth {
  gateway: { ok: boolean; service: string };
  crawler: { ok: boolean; [k: string]: unknown };
  intelligence: { ok: boolean; [k: string]: unknown };
}

// ------------------------------------------------------------------ 接口
export const api = {
  // 鉴权
  register: (email: string, password: string, nickname?: string) =>
    request<TokenBundle>('POST', '/api/v1/auth/register', { body: { email, password, nickname } }),
  login: (email: string, password: string) =>
    request<TokenBundle>('POST', '/api/v1/auth/login', { body: { email, password } }),
  refresh: (refreshToken: string) =>
    request<TokenBundle>('POST', '/api/v1/auth/refresh', { body: { refresh_token: refreshToken } }),
  logout: (token: string, refreshToken: string) =>
    request<{ ok: boolean }>('POST', '/api/v1/auth/logout', { token, body: { refresh_token: refreshToken } }),

  // 资料
  getProfile: (token: string) => request<Record<string, any>>('GET', '/api/v1/profile', { token }),
  putProfile: (token: string, data: unknown) =>
    request<Record<string, any>>('PUT', '/api/v1/profile', { token, body: data }),
  patchProfile: (token: string, patch: unknown) =>
    request<Record<string, any>>('PATCH', '/api/v1/profile', { token, body: patch }),

  // 院校与申请
  institutions: (token: string, query = '') =>
    request<PageResult<Institution>>('GET', `/api/v1/institutions${query}`, { token }),
  applications: (token: string, query = '') =>
    request<PageResult<Application>>('GET', `/api/v1/applications${query}`, { token }),
  createApplication: (token: string, body: unknown) =>
    request<Application>('POST', '/api/v1/applications', { token, body }),
  updateApplication: (token: string, id: number, body: unknown) =>
    request<Application>('PATCH', `/api/v1/applications/${id}`, { token, body }),
  recommenders: (token: string, appId: number) =>
    request<Recommender[]>('GET', `/api/v1/applications/${appId}/recommenders`, { token }),
  addRecommender: (token: string, appId: number, body: unknown) =>
    request<Recommender>('POST', `/api/v1/applications/${appId}/recommenders`, { token, body }),
  inviteRecommender: (token: string, appId: number, rid: number) =>
    request<Recommender>('POST', `/api/v1/applications/${appId}/recommenders/${rid}/invite`, { token }),

  // 订阅
  subscriptions: (token: string) =>
    request<{ total: number; items: Subscription[] }>('GET', '/api/v1/subscriptions', { token }),
  createSubscription: (token: string, body: unknown) =>
    request<Subscription>('POST', '/api/v1/subscriptions', { token, body }),
  updateSubscription: (token: string, id: number, body: unknown) =>
    request<Subscription>('PATCH', `/api/v1/subscriptions/${id}`, { token, body }),
  deleteSubscription: (token: string, id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/subscriptions/${id}`, { token }),
  // 订阅匹配与推送（契约 §6.2）
  previewSubscription: (token: string, id: number, query = '') =>
    request<PreviewResult>('GET', `/api/v1/subscriptions/${id}/preview${query}`, { token }),
  runSubscription: (token: string, id: number, query = '') =>
    request<RunResult>('POST', `/api/v1/subscriptions/${id}/run${query}`, { token }),
  notifications: (token: string, query = '') =>
    request<PageResult<DeliveryItem>>('GET', `/api/v1/notifications${query}`, { token }),
  notificationStats: (token: string) =>
    request<DeliveryStats>('GET', '/api/v1/notifications/stats', { token }),

  // 材料与简历
  presign: (token: string, body: unknown) =>
    request<{ upload_url: string; file_key: string; expires_in: number }>('POST', '/api/v1/documents/presign', {
      token, body,
    }),
  registerDocument: (token: string, body: unknown) =>
    request<DocItem>('POST', '/api/v1/documents', { token, body }),
  documents: (token: string, docType?: string) =>
    request<{ total: number; items: DocItem[] }>(
      'GET',
      `/api/v1/documents${docType ? `?doc_type=${encodeURIComponent(docType)}` : ''}`,
      { token },
    ),
  deleteDocument: (token: string, id: number) =>
    request<{ ok: boolean }>('DELETE', `/api/v1/documents/${id}`, { token }),
  parseResume: (token: string, body: unknown) =>
    request<{ id: number; name: string; version: number; parsed: any }>('POST', '/api/v1/resumes/parse', {
      token, body,
    }),
  resumes: (token: string) =>
    request<{ total: number; items: ResumeSummary[] }>('GET', '/api/v1/resumes', { token }),

  // 岗位（经网关代理到 crawler-service）
  jobs: (query = '') => request<PageResult<Job>>('GET', `/api/v1/jobs${query}`),
  jobDetail: (id: number) => request<Job>('GET', `/api/v1/jobs/${id}`),
  facets: (query = '') => request<Facets>('GET', `/api/v1/jobs/facets${query}`),

  // 功能 B · 岗位匹配度评分（登录态，限流 match 60/min）
  matchJobs: (token: string, jobs: MatchJobInput[]) =>
    request<{ scores: MatchScore[] }>('POST', '/api/v1/match/jobs', { token, body: { jobs } }),

  // 元信息
  services: () => request<ServiceHealth>('GET', '/api/v1/meta/services'),
};

/** 岗位 CSV 导出链接（浏览器直接下载） */
export function jobsExportUrl(query = '') {
  return `${BASE}/api/v1/jobs/export.csv${query}`;
}
