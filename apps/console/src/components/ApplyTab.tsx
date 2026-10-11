/**
 * Tab 3 · 申请进度：申请列表 + 进度更新 + 推荐信管理 + 院校项目库。
 *
 * 全部接口需鉴权，统一通过 useAuth().authed 包装（自带 401 自动刷新）。
 * 合规：推荐信仅做「登记 + 状态跟踪」，不代发邀请邮件。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError, api, type Application, type Institution, type PageResult, type Recommender,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  APPLICATION_STATUS, APPLICATION_STATUS_ORDER, RECOMMENDER_STATUS, buildQuery,
  deadlineText, fmtDate, fmtDateTime, statusMeta,
} from '../lib/format';
import { useDebounced, useRequest } from '../lib/useRequest';
import { useToast } from './Toasts';

const SIZE = 20;

export function ApplyTab({ onNeedAuth }: { onNeedAuth: () => void }) {
  const { user, authed } = useAuth();
  const toast = useToast();

  const [status, setStatus] = useState('all');
  const [keyword, setKeyword] = useState('');
  // 之前 keyword 直接进 query，每敲一个字就发一次请求；这里与岗位页对齐加防抖
  const debouncedKw = useDebounced(keyword.trim(), 350);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Application | null>(null);
  const [recOf, setRecOf] = useState<Application | null>(null);
  const [instOpen, setInstOpen] = useState(false);
  const [editCell, setEditCell] = useState<{ id: number; field: 'progress' | 'status' } | null>(null);
  const [draft, setDraft] = useState('');

  // 筛选变化即回到第一页（渲染期同步修正，避免「旧 page + 新筛选」的无效请求）
  const filterKey = `${status}|${debouncedKw}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  const [page, setPage] = useState(1);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const query = useMemo(
    () => buildQuery({ status, keyword: debouncedKw, page, size: SIZE }),
    [status, debouncedKw, page],
  );

  const req = useRequest<PageResult<Application> | null>(
    () => (user ? authed((t) => api.applications(t, query)) : Promise.resolve(null)),
    [user, authed, query],
  );
  const data = req.data;
  const load = req.reload;

  // 行内快速编辑：进度 / 状态，省掉「打开弹窗再保存」这一轮
  const commitInline = async (a: Application, field: 'progress' | 'status', value: string) => {
    setEditCell(null);
    try {
      const body = field === 'progress'
        ? { progress: Math.max(0, Math.min(100, Number(value) || 0)) }
        : { status: value };
      await authed((t) => api.updateApplication(t, a.id, body));
      toast.ok('已保存');
      req.reload();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '保存失败');
    }
  };

  if (!user) {
    return (
      <div className="panel">
        <div className="empty">
          <div className="big">🔒</div>
          申请进度与资料需要登录后查看
          <div className="mt-[14px]">
            <button className="btn primary" onClick={onNeedAuth}>登录 / 注册</button>
          </div>
        </div>
      </div>
    );
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / (data.size || SIZE))) : 1;

  return (
    <>
      <div className="panel">
        <div className="panel-title">
          我的申请
          <span className="sub">共 {data?.total ?? 0} 条</span>
          <span className="ml-auto flex gap-[8px]">
            <button className="btn sm" onClick={() => setInstOpen(true)}>院校项目库</button>
            <button className="btn primary sm" onClick={() => setCreating(true)}>+ 新建申请</button>
          </span>
        </div>

        <div className="filters">
          <input
            placeholder="搜索院校 / 项目"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">全部状态</option>
            {APPLICATION_STATUS_ORDER.map((s) => (
              <option key={s} value={s}>{APPLICATION_STATUS[s].text}</option>
            ))}
          </select>
          <button className="btn sm" onClick={req.reload} disabled={req.pending}>
            {req.pending ? '刷新中…' : '刷新'}
          </button>
        </div>

        {req.initial && req.pending && <div className="loading"><span className="spinner" />加载中…</div>}

        {req.error && (
          <div className="empty">
            <div className="big">⚠</div>
            {req.error}
            <div className="mt-[14px]">
              <button className="btn primary sm" onClick={req.reload}>重试</button>
            </div>
          </div>
        )}

        {!req.error && data && data.items.length === 0 && !req.pending && (
          <div className="empty">
            <div className="big">📄</div>
            还没有申请记录，点击右上角「新建申请」开始。
            <div className="mt-[14px]">
              <button className="btn primary sm" onClick={() => setCreating(true)}>+ 新建申请</button>
            </div>
          </div>
        )}

        {data && data.items.length > 0 && (
          <>
            <table>
              <thead>
                <tr>
                  <th>院校 / 项目</th>
                  <th>平台</th>
                  <th>状态</th>
                  <th className="w-[160px]">进度</th>
                  <th>截止</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => {
                  const st = statusMeta(APPLICATION_STATUS, a.status);
                  const dl = deadlineText(a.deadline);
                  return (
                    <tr key={a.id}>
                      <td>
                        <div className="co">{a.institution_name}</div>
                        <div>{a.program || '—'}</div>
                        {a.notes ? <div className="src">{a.notes}</div> : null}
                      </td>
                      <td>{a.platform || '—'}</td>
                      <td>
                        {editCell?.id === a.id && editCell.field === 'status' ? (
                          <select
                            autoFocus
                            value={draft}
                            onChange={(e) => { setDraft(e.target.value); commitInline(a, 'status', e.target.value); }}
                            onBlur={() => setEditCell(null)}
                          >
                            {APPLICATION_STATUS_ORDER.map((s) => (
                              <option key={s} value={s}>{APPLICATION_STATUS[s].text}</option>
                            ))}
                          </select>
                        ) : (
                          <span
                            className={`badge ${st.tone} cursor-pointer`}
                            title="点击切换状态"
                            onClick={() => { setEditCell({ id: a.id, field: 'status' }); setDraft(a.status); }}
                          >
                            {st.text}
                          </span>
                        )}
                      </td>
                      <td>
                        {editCell?.id === a.id && editCell.field === 'progress' ? (
                          <input
                            type="number" min={0} max={100} autoFocus
                            className="w-[80px]"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onBlur={() => commitInline(a, 'progress', draft)}
                            onKeyDown={(e) => { if (e.key === 'Enter') commitInline(a, 'progress', draft); }}
                          />
                        ) : (
                          <div
                            className="cursor-pointer"
                            title="点击编辑进度"
                            onClick={() => { setEditCell({ id: a.id, field: 'progress' }); setDraft(String(a.progress)); }}
                          >
                            <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, a.progress))}%` }} /></div>
                            <div className="src mt-[4px]">{a.progress}%</div>
                          </div>
                        )}
                      </td>
                      <td>
                        <div>{fmtDate(a.deadline)}</div>
                        <span className={`badge ${dl.tone}`}>{dl.text}</span>
                      </td>
                      <td className="src">{fmtDateTime(a.updated_at)}</td>
                      <td>
                        <div className="flex gap-[6px] flex-wrap">
                          <button className="btn sm" onClick={() => setEditing(a)}>更新</button>
                          <button className="btn sm" onClick={() => setRecOf(a)}>推荐信</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <div className="pager">
              <span>第 {data.page} / {totalPages} 页</span>
              <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>上一页</button>
              <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>下一页</button>
            </div>
          </>
        )}
      </div>

      {creating && (
        <ApplicationModal
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); toast.ok('已创建申请'); void load(); }}
        />
      )}

      {editing && (
        <UpdateModal
          app={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); toast.ok('已更新进度'); void load(); }}
        />
      )}

      {recOf && (
        <RecommenderModal
          app={recOf}
          onClose={() => setRecOf(null)}
        />
      )}

      {instOpen && <InstitutionModal onClose={() => setInstOpen(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ 新建申请
function ApplicationModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { authed } = useAuth();
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [institutionId, setInstitutionId] = useState('');
  const [form, setForm] = useState({ institution_name: '', program: '', platform: '', deadline: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    authed((t) => api.institutions(t, '?size=100'))
      .then((r) => setInstitutions(r.items))
      .catch(() => setInstitutions([]));
  }, [authed]);

  const pick = (id: string) => {
    setInstitutionId(id);
    const inst = institutions.find((i) => String(i.id) === id);
    if (inst) {
      setForm({
        institution_name: inst.name,
        program: inst.program,
        platform: inst.platform,
        deadline: inst.deadline,
        notes: '',
      });
    }
  };

  const save = async () => {
    if (!form.institution_name.trim()) { setErr('请填写院校名称'); return; }
    setBusy(true); setErr('');
    try {
      await authed((t) => api.createApplication(t, {
        ...(institutionId ? { institution_id: Number(institutionId) } : {}),
        ...form,
      }));
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">新建申请<button className="x" onClick={onClose}>×</button></div>
        <div className="modal-b">
          <div className="form-grid">
            <div className="field full">
              <label>从院校项目库选择（可选，自动带出信息）</label>
              <select value={institutionId} onChange={(e) => pick(e.target.value)}>
                <option value="">手动填写</option>
                {institutions.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} · {i.program}（{i.platform}）</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>院校名称 *</label>
              <input value={form.institution_name}
                onChange={(e) => setForm({ ...form, institution_name: e.target.value })} />
            </div>
            <div className="field">
              <label>项目</label>
              <input value={form.program}
                onChange={(e) => setForm({ ...form, program: e.target.value })} />
            </div>
            <div className="field">
              <label>申请平台</label>
              <input placeholder="ApplyWeb / Liaison / Slate" value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })} />
            </div>
            <div className="field">
              <label>截止日期</label>
              <input type="date" value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </div>
            <div className="field full">
              <label>备注</label>
              <textarea value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          {err && <div className="note text-red-fg">{err}</div>}
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 更新进度
function UpdateModal({ app, onClose, onSaved }: { app: Application; onClose: () => void; onSaved: () => void }) {
  const { authed } = useAuth();
  const [status, setStatus] = useState(app.status);
  const [progress, setProgress] = useState(app.progress);
  const [notes, setNotes] = useState(app.notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      await authed((t) => api.updateApplication(t, app.id, { status, progress: Number(progress), notes }));
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '更新失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">更新进度 · {app.institution_name}<button className="x" onClick={onClose}>×</button></div>
        <div className="modal-b">
          <div className="field mb-[12px]">
            <label>状态</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {APPLICATION_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>{APPLICATION_STATUS[s].text}</option>
              ))}
            </select>
          </div>
          <div className="field mb-[12px]">
            <label>进度：{progress}%</label>
            <input type="range" min={0} max={100} step={5} value={progress}
              onChange={(e) => setProgress(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>备注</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {err && <div className="note text-red-fg">{err}</div>}
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void save()} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 推荐信
function RecommenderModal({ app, onClose }: { app: Application; onClose: () => void }) {
  const { authed } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<Recommender[]>([]);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '', org: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authed((t) => api.recommenders(t, app.id));
      setItems(r);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [authed, app.id]);

  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!form.name.trim()) { toast.err('请填写推荐人姓名'); return; }
    setBusy(true);
    try {
      await authed((t) => api.addRecommender(t, app.id, form));
      setForm({ name: '', email: '', title: '', org: '' });
      toast.ok('已添加推荐人');
      await load();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  };

  const invite = async (rid: number) => {
    try {
      await authed((t) => api.inviteRecommender(t, app.id, rid));
      toast.ok('已标记为「已邀请」，请在院校系统中完成实际邀请');
      await load();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '操作失败');
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          推荐信管理 · {app.institution_name}
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-b">
          {loading && <div className="loading"><span className="spinner" />加载中…</div>}

          {!loading && items.length === 0 && (
            <div className="empty py-[20px]">暂无推荐人，请在下方登记。</div>
          )}

          {!loading && items.length > 0 && (
            <table>
              <thead>
                <tr><th>姓名</th><th>职称 / 单位</th><th>邮箱</th><th>状态</th><th>操作</th></tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const st = statusMeta(RECOMMENDER_STATUS, r.status);
                  return (
                    <tr key={r.id}>
                      <td className="co">{r.name}</td>
                      <td>{[r.title, r.org].filter(Boolean).join(' · ') || '—'}</td>
                      <td className="src">{r.email || '—'}</td>
                      <td><span className={`badge ${st.tone}`}>{st.text}</span></td>
                      <td>
                        {r.status === 'pending' ? (
                          <button className="btn sm" onClick={() => void invite(r.id)}>标记已邀请</button>
                        ) : (
                          <span className="src">{fmtDate(r.invited_at)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="panel-title mt-[20px]">登记新推荐人</div>
          <div className="form-grid">
            <div className="field">
              <label>姓名 *</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label>邮箱</label>
              <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="field">
              <label>职称</label>
              <input placeholder="教授 / 副教授 / 主管" value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="field">
              <label>单位</label>
              <input value={form.org} onChange={(e) => setForm({ ...form, org: e.target.value })} />
            </div>
          </div>

          <p className="note">
            合规说明：本功能仅登记推荐人信息并跟踪状态，实际邀请与提交由你在院校申请系统内自行完成。
          </p>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn primary" onClick={() => void add()} disabled={busy}>
            {busy ? '添加中…' : '添加推荐人'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 院校库
function InstitutionModal({ onClose }: { onClose: () => void }) {
  const { authed } = useAuth();
  const [keyword, setKeyword] = useState('');
  const [data, setData] = useState<Institution[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      authed((tk) => api.institutions(tk, buildQuery({ keyword: keyword.trim(), size: 50 })))
        .then((r) => setData(r.items))
        .catch(() => setData([]))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(t);
  }, [authed, keyword]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">院校项目库<button className="x" onClick={onClose}>×</button></div>
        <div className="modal-b">
          <div className="filters">
            <input placeholder="搜索院校 / 项目" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
          {loading && <div className="loading"><span className="spinner" />加载中…</div>}
          {!loading && data.length === 0 && <div className="empty">未找到匹配的院校项目。</div>}
          {!loading && data.length > 0 && (
            <table>
              <thead>
                <tr><th>院校</th><th>国家</th><th>项目</th><th>平台</th><th>截止</th></tr>
              </thead>
              <tbody>
                {data.map((i) => (
                  <tr key={i.id}>
                    <td className="co">{i.name}</td>
                    <td>{i.country}</td>
                    <td>{i.program}</td>
                    <td>{i.platform}</td>
                    <td>{fmtDate(i.deadline)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
