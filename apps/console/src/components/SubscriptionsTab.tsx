/**
 * Tab 3 · 岗位订阅（契约 §6.2）。
 *
 * 订阅规则 CRUD + 匹配预览 + 立即推送 + 推送记录。
 * 推送渠道语义：
 *   * 邮件：服务端渲染后排队（待发送），由发信器消费
 *   * 企业微信 / Webhook：服务端直接 POST 到回调地址，成功记「已送达」
 *
 * 体验改造（本轮）：
 *   * busy 从「订阅 ID」改为「订阅 ID + 动作」键：之前一条订阅在跑会把**所有行**的操作按钮
 *     全部禁用（busyId 只存 ID），现在只锁当前行当前动作
 *   * 删除改为二次确认，避免误触丢数据
 *   * 预览弹窗可直接「立即推送」，把「预览 → 关掉 → 执行」两步合成一步
 *   * 关键词 / 城市输入实时渲染 chips，消除「顿号到底有没有被正确拆分」的疑虑
 */

import { useCallback, useEffect, useState } from 'react';
import { Input, Modal, Select, Switch } from 'antd';
import {
  ApiError, api, type DeliveryItem, type DeliveryStats, type PreviewResult,
  type RunResult, type Subscription,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  CHANNEL_TEXT, DELIVERY_STATUS, buildQuery, fmtConfidence, fmtDateTime,
  scheduleOptions, splitList, statusMeta,
} from '../lib/format';
import { useToast } from './Toasts';
import { ConfirmDialog } from './ConfirmDialog';

const DELIVERY_SIZE = 10;

const EDU_OPTIONS = [
  { value: '', label: '不限学历' },
  { value: '本科', label: '本科' },
  { value: '硕士', label: '硕士' },
  { value: '博士', label: '博士' },
];

export function SubscriptionsTab({ onNeedAuth }: { onNeedAuth: () => void }) {
  const { user, authed } = useAuth();
  const toast = useToast();

  const [items, setItems] = useState<Subscription[]>([]);
  const [stats, setStats] = useState<DeliveryStats | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [deliveryTotal, setDeliveryTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Subscription | 'new' | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  /**
   * 正在执行的操作键，形如 `${订阅ID}:${动作}`。
   * 之前只存订阅 ID（`busyId`），导致一条订阅在跑时**所有行**的按钮都被禁用；
   * 改成「行 + 动作」后只锁当前行的当前动作，其余行照常可操作。
   */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** 待确认删除的订阅（删除是不可逆操作，必须二次确认） */
  const [confirmDel, setConfirmDel] = useState<Subscription | null>(null);

  const busyOf = (id: number, action: string) => busyKey === `${id}:${action}`;
  const rowBusy = (id: number) => busyKey !== null && busyKey.startsWith(`${id}:`);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [subs, st, notis] = await Promise.all([
        authed((t) => api.subscriptions(t)),
        authed((t) => api.notificationStats(t)),
        authed((t) => api.notifications(t, buildQuery({ size: DELIVERY_SIZE, status: statusFilter }))),
      ]);
      setItems(subs.items);
      setStats(st);
      setDeliveries(notis.items);
      setDeliveryTotal(notis.total);
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [user, authed, toast, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  if (!user) {
    return (
      <div className="panel">
        <div className="empty">
          <div className="big">🔔</div>
          岗位订阅需要登录后管理
          <div className="mt-[14px]">
            <button className="btn primary" onClick={onNeedAuth}>登录 / 注册</button>
          </div>
        </div>
      </div>
    );
  }

  const doPreview = async (s: Subscription) => {
    setBusyKey(`${s.id}:preview`);
    try {
      const r = await authed((t) => api.previewSubscription(t, s.id, '?window_days=30'));
      setPreview(r);
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '预览失败，请确认采集服务已启动');
    } finally {
      setBusyKey(null);
    }
  };

  /** @param closePreview 从预览弹窗里触发时顺带关闭弹窗 */
  const doRun = async (s: Subscription, closePreview = false) => {
    setBusyKey(`${s.id}:run`);
    try {
      const r: RunResult = await authed((t) => api.runSubscription(t, s.id, '?window_days=30'));
      if (r.status === 'failed') {
        toast.err(`推送失败：${r.error}`);
      } else if (r.delivered > 0) {
        toast.ok(`匹配 ${r.matched} 个岗位，已推送 ${r.delivered} 个`);
      } else {
        toast.info(`匹配 ${r.matched} 个岗位，其中 ${r.duplicate} 个已推送过，无新增`);
      }
      if (closePreview) setPreview(null);
      await load();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '执行失败，请确认采集服务已启动');
    } finally {
      setBusyKey(null);
    }
  };

  /** 启停：只改本地这一行，不再为了一个开关重拉「订阅 + 统计 + 推送记录」三个接口 */
  const toggle = async (s: Subscription) => {
    setBusyKey(`${s.id}:toggle`);
    try {
      await authed((t) => api.updateSubscription(t, s.id, { enabled: !s.enabled }));
      setItems((prev) => prev.map((it) => (it.id === s.id ? { ...it, enabled: !s.enabled } : it)));
      toast.ok(s.enabled ? '已停用' : '已启用');
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (s: Subscription) => {
    setBusyKey(`${s.id}:remove`);
    try {
      await authed((t) => api.deleteSubscription(t, s.id));
      setItems((prev) => prev.filter((it) => it.id !== s.id));
      setConfirmDel(null);
      toast.ok('已删除');
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-title">
          我的订阅
          <span className="sub">共 {items.length} 条</span>
          <span className="panel-actions">
            <button className="btn sm" onClick={() => void load()} disabled={loading}>
              {loading ? '刷新中…' : '刷新'}
            </button>
            <button className="btn primary sm" onClick={() => setEditing('new')}>+ 新建订阅</button>
          </span>
        </div>

        {loading && <div className="loading"><span className="spinner" />加载中…</div>}

        {!loading && items.length === 0 && (
          <div className="empty">
            <div className="big">🔔</div>
            还没有订阅。建一条订阅规则并选好执行频率，系统会定时匹配新岗位并推送。
          </div>
        )}

        {!loading && items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>筛选条件</th>
                <th>渠道</th>
                <th>状态</th>
                <th>上次执行</th>
                <th>下次执行</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="co">{s.name}</td>
                  <td>
                    {s.keywords.length > 0 && (
                      <div>{s.keywords.map((k) => <span key={k} className="tag">{k}</span>)}</div>
                    )}
                    <div className="src">
                      {s.cities.length ? `城市：${s.cities.join('、')}` : '城市：不限'}
                      {' · '}
                      {s.education ? `学历：${s.education}` : '学历：不限'}
                      {s.keywords.length > 1 && (
                        <> · {s.require_all_keywords ? '全部关键词' : '任一关键词'}</>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="badge blue">{CHANNEL_TEXT[s.channel] || s.channel}</span>
                    {s.webhook_url ? (
                      <div className="src mt-[4px]">{shortUrl(s.webhook_url)}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${s.enabled ? 'green' : 'gray'}`}>
                      {s.enabled ? '启用中' : '已停用'}
                    </span>
                  </td>
                  <td className="src">{s.last_run_at ? fmtDateTime(s.last_run_at) : '从未执行'}</td>
                  <td className="src">
                    {s.schedule ? (
                      <>
                        <div>{s.next_run_at ? fmtDateTime(s.next_run_at) : '待计算'}</div>
                        <div>{s.schedule_text || s.schedule}</div>
                      </>
                    ) : (
                      <span className="text-t3">不自动执行</span>
                    )}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="btn sm"
                        disabled={rowBusy(s.id)}
                        onClick={() => void doPreview(s)}
                      >
                        {busyOf(s.id, 'preview') ? '预览中…' : '预览'}
                      </button>
                      <button
                        className="btn sm primary"
                        disabled={rowBusy(s.id) || !s.enabled}
                        onClick={() => void doRun(s)}
                        title={s.enabled ? '立即匹配并推送' : '订阅已停用，启用后才能执行'}
                      >
                        {busyOf(s.id, 'run') ? '执行中…' : '立即执行'}
                      </button>
                      <button className="btn sm" disabled={rowBusy(s.id)} onClick={() => setEditing(s)}>
                        编辑
                      </button>
                      <button
                        className="btn sm"
                        disabled={rowBusy(s.id)}
                        onClick={() => void toggle(s)}
                      >
                        {busyOf(s.id, 'toggle') ? '处理中…' : s.enabled ? '停用' : '启用'}
                      </button>
                      <button
                        className="btn sm danger"
                        disabled={rowBusy(s.id)}
                        onClick={() => setConfirmDel(s)}
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">
          推送记录
          <span className="sub">共 {deliveryTotal} 条</span>
          <span className="ml-auto">
            <Select
              style={{ minWidth: 120 }}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v)}
              options={[
                { value: '', label: '全部状态' },
                ...Object.entries(DELIVERY_STATUS).map(([k, v]) => (
                  { value: k, label: v.text }
                )),
              ]}
            />
          </span>
        </div>

        {stats && (
          <div className="stat">
            <span>总计 <b>{stats.total}</b></span>
            <span>已送达 <b>{stats.sent}</b></span>
            <span>待发送 <b>{stats.pending}</b></span>
            <span>失败 <b>{stats.failed}</b></span>
          </div>
        )}

        {deliveries.length === 0 ? (
          <div className="empty">暂无推送记录。执行一次订阅后，这里会显示匹配与推送结果。</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>推送内容</th>
                <th>渠道</th>
                <th>状态</th>
                <th>岗位数</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => {
                const st = statusMeta(DELIVERY_STATUS, d.status);
                return (
                  <tr key={d.id}>
                    <td>
                      <div className="co">{d.title || '—'}</div>
                      {d.payload?.items?.length ? (
                        <div className="src">
                          {d.payload.items.slice(0, 2).map((it) => `${it.company}·${it.title}`).join('；')}
                          {d.payload.items.length > 2 ? ` 等 ${d.payload.items.length} 个` : ''}
                        </div>
                      ) : null}
                      {d.error ? <div className="src text-red-fg">{d.error}</div> : null}
                    </td>
                    <td>{CHANNEL_TEXT[d.channel] || d.channel}</td>
                    <td><span className={`badge ${st.tone}`}>{st.text}</span></td>
                    <td>{d.payload?.count ?? 0}</td>
                    <td className="src">
                      <div>{fmtDateTime(d.created_at)}</div>
                      {d.sent_at ? <div>送达 {fmtDateTime(d.sent_at)}</div> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <p className="note">
          邮件渠道为「待发送」：服务端已渲染好推送内容并排队，接入发信器（SMTP）后即可投递；
          企业微信与 Webhook 会立即发出，失败原因记录在上表。
        </p>
      </div>

      {editing && (
        <SubscriptionModal
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            toast.ok('已保存');
            void load();
          }}
        />
      )}

      {preview && (
        <PreviewModal
          result={preview}
          onClose={() => setPreview(null)}
          onRun={() => void doRun(preview.subscription, true)}
          runBusy={busyOf(preview.subscription.id, 'run')}
        />
      )}

      {confirmDel && (
        <ConfirmDialog
          title="删除订阅"
          danger
          okText="删除"
          text={`确定删除订阅「${confirmDel.name}」吗？该订阅的推送记录会一并清理，且无法恢复。`}
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => remove(confirmDel)}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------------ 新建 / 编辑
function SubscriptionModal({
  value, onClose, onSaved,
}: {
  value: Subscription | 'new';
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authed } = useAuth();
  const isNew = value === 'new';
  const base = isNew ? null : value;

  const [form, setForm] = useState({
    name: base?.name || '',
    keywords: (base?.keywords || []).join('、'),
    cities: (base?.cities || []).join('、'),
    education: base?.education || '',
    channel: base?.channel || 'email',
    webhook_url: base?.webhook_url || '',
    require_all_keywords: base?.require_all_keywords || false,
    enabled: base ? base.enabled : true,
    schedule: base?.schedule || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const needUrl = form.channel === 'webhook' || form.channel === 'wechat';

  const save = async () => {
    if (!form.name.trim()) { setErr('请填写订阅名称'); return; }
    if (needUrl && !form.webhook_url.trim()) {
      setErr('该渠道需要填写回调地址');
      return;
    }
    setBusy(true);
    setErr('');
    const body = {
      name: form.name.trim(),
      // 提交**数组**而非原始字符串：网关对数组原样采用，
      // 避免依赖它只认 [,，\s] 的字符串拆分（顿号会被吞掉，见 splitList 注释）
      keywords: splitList(form.keywords),
      cities: splitList(form.cities),
      education: form.education,
      channel: form.channel,
      webhook_url: form.webhook_url.trim(),
      require_all_keywords: form.require_all_keywords,
      enabled: form.enabled,
      schedule: form.schedule,
    };
    try {
      if (isNew) {
        await authed((t) => api.createSubscription(t, body));
      } else {
        await authed((t) => api.updateSubscription(t, base!.id, body));
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={isNew ? '新建订阅' : '编辑订阅'}
      width={720}
      onCancel={onClose}
      footer={[
        <button key="cancel" className="btn" onClick={onClose}>取消</button>,
        <button key="save" className="btn primary" onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>,
      ]}
    >
      <div className="form-grid">
        <div className="field full">
          <label>订阅名称 *</label>
          <Input
            placeholder="如：北京数据分析实习"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="field">
          <label>关键词（顿号 / 逗号 / 空格分隔）</label>
          <Input
            placeholder="数据分析、SQL"
            value={form.keywords}
            onChange={(e) => setForm({ ...form, keywords: e.target.value })}
          />
          <Chips values={splitList(form.keywords)} empty="留空表示不过滤关键词" />
        </div>
        <div className="field">
          <label>城市（顿号 / 逗号 / 空格分隔）</label>
          <Input
            placeholder="北京、上海"
            value={form.cities}
            onChange={(e) => setForm({ ...form, cities: e.target.value })}
          />
          <Chips values={splitList(form.cities)} empty="留空表示不限城市" />
        </div>
        <div className="field">
          <label>学历要求</label>
          <Select
            style={{ width: '100%' }}
            value={form.education}
            onChange={(v) => setForm({ ...form, education: v })}
            options={EDU_OPTIONS.map((o) => ({
              value: o.value, label: o.label,
            }))}
          />
        </div>
        <div className="field">
          <label>关键词匹配模式</label>
          <Select
            style={{ width: '100%' }}
            value={form.require_all_keywords ? 'all' : 'any'}
            onChange={(v) => setForm({ ...form, require_all_keywords: v === 'all' })}
            options={[
              { value: 'any', label: '任一命中（宽召回）' },
              { value: 'all', label: '全部命中（精确）' },
            ]}
          />
        </div>
        <div className="field">
          <label>推送渠道</label>
          <Select
            style={{ width: '100%' }}
            value={form.channel}
            onChange={(v) => setForm({ ...form, channel: v })}
            options={[
              { value: 'email', label: '邮件（排队待发）' },
              { value: 'wechat', label: '企业微信机器人' },
              { value: 'webhook', label: 'Webhook' },
            ]}
          />
        </div>
        <div className="field">
          <label>自动执行</label>
          <Select
            style={{ width: '100%' }}
            value={form.schedule}
            onChange={(v) => setForm({ ...form, schedule: v })}
            options={scheduleOptions(form.schedule).map((o) => ({
              value: o.value, label: o.label,
            }))}
          />
        </div>
        <div className="field">
          <label>启用</label>
          <div className="flex items-center gap-[8px] mt-[6px]">
            <Switch
              checked={form.enabled}
              onChange={(checked) => setForm({ ...form, enabled: checked })}
            />
            <span className="text-[13px] text-[#64748b]">{form.enabled ? '启用' : '停用'}</span>
          </div>
        </div>
        {needUrl && (
          <div className="field full">
            <label>回调地址 *（{CHANNEL_TEXT[form.channel]}）</label>
            <Input
              placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..."
              value={form.webhook_url}
              onChange={(e) => setForm({ ...form, webhook_url: e.target.value })}
            />
          </div>
        )}
      </div>
      {err && <div className="note text-red-fg">{err}</div>}
      <p className="note">
        匹配规则：关键词默认任一命中即召回（按命中率评分）；城市与学历为附加筛选，留空表示不限。
      </p>
      <p className="note">
        自动执行：按所选频率在后台定时跑匹配并推送，只推送<b>未推送过</b>的新岗位；
        选「不自动执行」则只在你点「立即执行」时运行。时区为北京时间。
      </p>
    </Modal>
  );
}

// ------------------------------------------------------------------ 预览
interface PreviewModalProps {
  result: PreviewResult;
  onClose: () => void;
  /** 直接推送：省掉「关掉预览 → 回列表找那一行的立即执行」这一来回 */
  onRun: () => void;
  runBusy: boolean;
}

function PreviewModal({ result, onClose, onRun, runBusy }: PreviewModalProps) {
  return (
    <Modal
      open
      title={`匹配预览 · ${result.subscription.name}`}
      width={720}
      onCancel={onClose}
      footer={[
        <button key="close" className="btn" onClick={onClose}>关闭</button>,
        <button key="run" className="btn primary" onClick={() => onRun()} disabled={runBusy}>
          {runBusy ? '推送中…' : '立即推送'}
        </button>,
      ]}
    >
      <div className="stat">
        <span>近 <b>{result.window_days}</b> 天扫描 <b>{result.scanned}</b> 条</span>
        <span>命中 <b>{result.matched}</b> 条</span>
      </div>

      {result.items.length === 0 ? (
        <div className="empty">当前条件下没有匹配到岗位，试试放宽关键词或城市。</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>公司与岗位</th>
              <th>城市</th>
              <th>薪资</th>
              <th>相关度</th>
              <th>匹配说明</th>
            </tr>
          </thead>
          <tbody>
            {result.items.slice(0, 20).map((j) => (
              <tr key={j.id}>
                <td>
                  <div className="co">{j.company || '—'}</div>
                  <div>{j.title || '—'}</div>
                </td>
                <td>{j.city || '—'}</td>
                <td className="money">{j.salary || '面议'}</td>
                <td><span className="badge blue">{fmtConfidence(j.match_score)}</span></td>
                <td className="src">{j.match_reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="note">
        预览只做匹配计算，不会产生推送记录。规则合适的话直接点「立即推送」即可，
        系统会跳过已推送过的岗位。
      </p>
    </Modal>
  );
}

/**
 * 输入即所见：把「关键词 / 城市」的拆分结果实时渲染成 chips。
 * 之前是纯文本输入，用户根本不知道自己敲的分隔符有没有被正确识别
 * （顿号曾因网关不认而被整体当成一个词，导致订阅匹配不到任何岗位）。
 */
function Chips({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) {
    return <div className="chips"><span className="hint">{empty}</span></div>;
  }
  return (
    <div className="chips">
      {values.map((v, i) => <span key={`${v}-${i}`} className="tag">{v}</span>)}
    </div>
  );
}

function shortUrl(u: string): string {
  return u.length > 42 ? `${u.slice(0, 42)}…` : u;
}
