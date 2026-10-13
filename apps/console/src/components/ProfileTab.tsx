/**
 * Tab 4 · 资料库：结构化个人资料 + 申请材料登记 + 简历解析。
 *
 * 资料结构受网关 profile.service.ts 的 ALLOWED_TOP_KEYS 约束：
 *   basic_info / education / tests / experiences / addresses / documents / preferences
 * 保存走 PATCH /api/v1/profile（JSON Merge Patch），只提交被修改的块。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError, api, type DocItem, type ResumeSummary,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { DOC_TYPES, fmtDateTime, fmtSize } from '../lib/format';
import { useToast } from './Toasts';

type Sub = 'info' | 'docs' | 'resume';

export function ProfileTab({ onNeedAuth }: { onNeedAuth: () => void }) {
  const { user } = useAuth();
  const [sub, setSub] = useState<Sub>('info');

  if (!user) {
    return (
      <div className="panel">
        <div className="empty">
          <div className="big">🔒</div>
          资料库需要登录后查看
          <div style={{ marginTop: 14 }}>
            <button className="btn primary" onClick={onNeedAuth}>登录 / 注册</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="tabs" style={{ marginTop: 0 }}>
        <div className={`tab ${sub === 'info' ? 'on' : ''}`} onClick={() => setSub('info')}>个人资料</div>
        <div className={`tab ${sub === 'docs' ? 'on' : ''}`} onClick={() => setSub('docs')}>申请材料</div>
        <div className={`tab ${sub === 'resume' ? 'on' : ''}`} onClick={() => setSub('resume')}>简历解析</div>
      </div>

      {sub === 'info' && <InfoPanel />}
      {sub === 'docs' && <DocsPanel />}
      {sub === 'resume' && <ResumePanel />}
    </>
  );
}

// ------------------------------------------------------------------ 个人资料
interface ProfileData {
  basic_info?: Record<string, any>;
  education?: Record<string, any>;
  tests?: Record<string, any>;
  preferences?: Record<string, any>;
}

const EMPTY: ProfileData = { basic_info: {}, education: {}, tests: {}, preferences: {} };

function InfoPanel() {
  const { authed } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<ProfileData>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authed((t) => api.getProfile(t));
      setData({
        basic_info: r.basic_info || {},
        education: r.education || {},
        tests: r.tests || {},
        preferences: r.preferences || {},
      });
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '资料加载失败');
    } finally {
      setLoading(false);
    }
  }, [authed, toast]);

  useEffect(() => { void load(); }, [load]);

  const set = (block: keyof ProfileData, key: string, value: string) => {
    setData((prev) => ({ ...prev, [block]: { ...(prev[block] || {}), [key]: value } }));
  };

  const save = async () => {
    setBusy(true);
    try {
      await authed((t) => api.patchProfile(t, data));
      toast.ok('资料已保存');
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="panel"><div className="loading"><span className="spinner" />加载中…</div></div>;

  const b = data.basic_info || {};
  const ed = data.education || {};
  const ts = data.tests || {};
  const pf = data.preferences || {};

  return (
    <>
      <div className="panel">
        <div className="panel-title">基本信息<span className="sub">用于网申表单自动填充</span></div>
        <div className="form-grid">
          <F label="姓（Last Name）" v={b.last_name} on={(v) => set('basic_info', 'last_name', v)} />
          <F label="名（First Name）" v={b.first_name} on={(v) => set('basic_info', 'first_name', v)} />
          <F label="英文名 / 拼音" v={b.name_en} on={(v) => set('basic_info', 'name_en', v)} />
          <F label="性别" v={b.gender} on={(v) => set('basic_info', 'gender', v)} type="select"
            options={['', '男', '女', '不愿透露']} />
          <F label="出生日期" v={b.birthday} on={(v) => set('basic_info', 'birthday', v)} type="date" />
          <F label="国籍" v={b.nationality} on={(v) => set('basic_info', 'nationality', v)} />
          <F label="手机号" v={b.phone} on={(v) => set('basic_info', 'phone', v)} />
          <F label="邮箱" v={b.email} on={(v) => set('basic_info', 'email', v)} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">教育背景</div>
        <div className="form-grid">
          <F label="学校" v={ed.school} on={(v) => set('education', 'school', v)} />
          <F label="学历层次" v={ed.degree} on={(v) => set('education', 'degree', v)} type="select"
            options={['', '本科', '硕士', '博士', '高中']} />
          <F label="专业" v={ed.major} on={(v) => set('education', 'major', v)} />
          <F label="GPA" v={ed.gpa} on={(v) => set('education', 'gpa', v)} />
          <F label="GPA 满分制" v={ed.gpa_scale} on={(v) => set('education', 'gpa_scale', v)} type="select"
            options={['', '4.0', '4.3', '5.0', '100']} />
          <F label="入学时间" v={ed.start_date} on={(v) => set('education', 'start_date', v)} type="date" />
          <F label="毕业时间" v={ed.end_date} on={(v) => set('education', 'end_date', v)} type="date" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">标化成绩</div>
        <div className="form-grid">
          <F label="TOEFL" v={ts.toefl} on={(v) => set('tests', 'toefl', v)} />
          <F label="IELTS" v={ts.ielts} on={(v) => set('tests', 'ielts', v)} />
          <F label="GRE" v={ts.gre} on={(v) => set('tests', 'gre', v)} />
          <F label="GMAT" v={ts.gmat} on={(v) => set('tests', 'gmat', v)} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          申请偏好
          <span className="sub">决定推荐院校与岗位的排序、匹配度评分</span>
        </div>
        <div className="form-grid">
          <F label="目标国家/地区" v={pf.target_countries} on={(v) => set('preferences', 'target_countries', v)}
            placeholder="美国, 英国, 新加坡" />
          <F label="目标专业" v={pf.target_majors} on={(v) => set('preferences', 'target_majors', v)} />
          <F label="目标学位" v={pf.degree_level} on={(v) => set('preferences', 'degree_level', v)} type="select"
            options={['', '授课型硕士', '研究型硕士', '博士']} />
          <F label="入学季" v={pf.intake} on={(v) => set('preferences', 'intake', v)}
            placeholder="2027 Fall" />
          <F label="期望工作城市" v={pf.preferred_cities} on={(v) => set('preferences', 'preferred_cities', v)}
            placeholder="北京, 上海, 深圳" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn primary" onClick={() => void save()} disabled={busy}>
          {busy ? '保存中…' : '保存资料'}
        </button>
        <button className="btn" onClick={() => void load()}>重新加载</button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ 申请材料
function DocsPanel() {
  const { authed } = useAuth();
  const toast = useToast();
  const [items, setItems] = useState<DocItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ doc_type: 'cv', file_name: '', file_size: '', file_key: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await authed((t) => api.documents(t, filter || undefined));
      setItems(r.items);
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '材料加载失败');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [authed, toast, filter]);

  useEffect(() => { void load(); }, [load]);

  const register = async () => {
    if (!form.file_name.trim()) { toast.err('请填写文件名'); return; }
    try {
      await authed((t) => api.registerDocument(t, {
        doc_type: form.doc_type,
        file_name: form.file_name.trim(),
        file_key: form.file_key.trim() || `local/${Date.now()}-${form.file_name.trim()}`,
        file_size: Number(form.file_size) || 0,
        mime: '',
      }));
      toast.ok('材料已登记');
      setForm({ doc_type: 'cv', file_name: '', file_size: '', file_key: '' });
      await load();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '登记失败');
    }
  };

  const remove = async (id: number) => {
    try {
      await authed((t) => api.deleteDocument(t, id));
      toast.ok('已删除');
      await load();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '删除失败');
    }
  };

  return (
    <div className="panel">
      <div className="panel-title">
        申请材料
        <span className="sub">共 {items.length} 份</span>
        <span style={{ marginLeft: 'auto' }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">全部类型</option>
            {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </span>
      </div>

      {loading && <div className="loading"><span className="spinner" />加载中…</div>}

      {!loading && items.length === 0 && (
        <div className="empty"><div className="big">📎</div>暂无材料，先在下方登记。</div>
      )}

      {!loading && items.length > 0 && (
        <table>
          <thead>
            <tr><th>类型</th><th>文件名</th><th>大小</th><th>登记时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id}>
                <td><span className="tag">{DOC_TYPES[d.doc_type] || d.doc_type}</span></td>
                <td className="co">{d.file_name}</td>
                <td>{fmtSize(d.file_size)}</td>
                <td className="src">{fmtDateTime(d.created_at)}</td>
                <td>
                  <button className="btn sm danger" onClick={() => void remove(d.id)}>删除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="panel-title" style={{ marginTop: 20 }}>登记新材料</div>
      <div className="form-grid">
        <div className="field">
          <label>类型</label>
          <select value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })}>
            {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field">
          <label>文件名 *</label>
          <input placeholder="张三-CV.pdf" value={form.file_name}
            onChange={(e) => setForm({ ...form, file_name: e.target.value })} />
        </div>
        <div className="field">
          <label>文件大小（字节，可选）</label>
          <input placeholder="204800" value={form.file_size}
            onChange={(e) => setForm({ ...form, file_size: e.target.value })} />
        </div>
        <div className="field">
          <label>存储键（可选，留空自动生成）</label>
          <input placeholder="由对象存储返回的 file_key" value={form.file_key}
            onChange={(e) => setForm({ ...form, file_key: e.target.value })} />
        </div>
      </div>
      <div className="form-actions">
        <button className="btn primary" onClick={() => void register()}>登记材料</button>
      </div>

      <p className="note">
        当前版本登记材料元数据（类型 / 文件名 / 大小），真实文件上传待对象存储接入后开放；
        接入后流程为：申请预签名 URL → 直传对象存储 → 回填 file_key。
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ 简历解析
function ResumePanel() {
  const { authed } = useAuth();
  const toast = useToast();
  const [text, setText] = useState('');
  const [name, setName] = useState('我的简历');
  const [parsed, setParsed] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<ResumeSummary[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await authed((t) => api.resumes(t));
      setList(r.items);
    } catch {
      setList([]);
    }
  }, [authed]);

  useEffect(() => { void load(); }, [load]);

  const parse = async () => {
    if (!text.trim()) { toast.err('请粘贴简历文本'); return; }
    setBusy(true);
    try {
      const r = await authed((t) => api.parseResume(t, { name: name.trim() || '我的简历', text }));
      setParsed(r.parsed);
      toast.ok(`解析完成（v${r.version}）`);
      await load();
    } catch (e) {
      toast.err(e instanceof ApiError ? e.message : '解析失败，请检查智能服务是否启动');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-title">简历解析<span className="sub">粘贴纯文本，自动抽取教育 / 经历 / 技能</span></div>
        <div className="field" style={{ marginBottom: 12 }}>
          <label>简历名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>简历正文</label>
          <textarea
            style={{ minHeight: 180 }}
            placeholder="粘贴简历纯文本，例如：&#10;教育背景：某某大学 计算机科学与技术 本科 2021-2025 GPA 3.8/4.0&#10;实习经历：某公司 数据分析实习生 2024.06-2024.09 …"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="form-actions">
          <button className="btn primary" onClick={() => void parse()} disabled={busy}>
            {busy ? '解析中…' : '开始解析'}
          </button>
          <button className="btn" onClick={() => setText('')}>清空</button>
        </div>
      </div>

      {parsed && (
        <div className="panel">
          <div className="panel-title">解析结果</div>
          <pre style={{
            background: 'var(--line-soft)', padding: 14, borderRadius: 'var(--r-sm)',
            fontSize: 12, overflowX: 'auto', lineHeight: 1.6,
          }}>
            {JSON.stringify(parsed, null, 2)}
          </pre>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">历史简历<span className="sub">共 {list.length} 份</span></div>
        {list.length === 0 ? (
          <div className="empty">暂无解析记录。</div>
        ) : (
          <table>
            <thead><tr><th>名称</th><th>版本</th><th>更新时间</th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="co">{r.name}</td>
                  <td>v{r.version}</td>
                  <td className="src">{fmtDateTime(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ 通用字段
function F(props: {
  label: string;
  v?: string;
  on: (v: string) => void;
  type?: 'text' | 'date' | 'select';
  options?: string[];
  placeholder?: string;
}) {
  const { label, v, on, type = 'text', options, placeholder } = props;
  return (
    <div className="field">
      <label>{label}</label>
      {type === 'select' ? (
        <select value={v || ''} onChange={(e) => on(e.target.value)}>
          {(options || []).map((o) => <option key={o} value={o}>{o || '未填写'}</option>)}
        </select>
      ) : (
        <input
          type={type}
          value={v || ''}
          placeholder={placeholder}
          onChange={(e) => on(e.target.value)}
        />
      )}
    </div>
  );
}
