/**
 * 登录 / 注册弹窗。登录成功后由 AuthProvider 写入 localStorage，弹窗自行关闭。
 */

import { useState } from 'react';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useToast } from './Toasts';

interface Props {
  onClose: () => void;
  onDone: () => void;
}

export function AuthModal({ onClose, onDone }: Props) {
  const { login, register } = useAuth();
  const toast = useToast();

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!email.trim() || !password) {
      setErr('请填写邮箱与密码');
      return;
    }
    if (mode === 'register' && password.length < 6) {
      setErr('密码至少 6 位');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      if (mode === 'login') {
        await login(email.trim(), password);
        toast.ok('登录成功');
      } else {
        await register(email.trim(), password, nickname.trim() || undefined);
        toast.ok('注册成功，已自动登录');
      }
      onDone();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '操作失败，请稍后重试';
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          {mode === 'login' ? '登录' : '注册'}
          <button className="x" onClick={onClose}>×</button>
        </div>
        <div className="modal-b">
          <div className="field" style={{ marginBottom: 12 }}>
            <label>邮箱</label>
            <input
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          {mode === 'register' && (
            <div className="field" style={{ marginBottom: 12 }}>
              <label>昵称（可选）</label>
              <input
                placeholder="留空则取邮箱前缀"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </div>
          )}

          <div className="field">
            <label>密码</label>
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              placeholder={mode === 'register' ? '至少 6 位' : '请输入密码'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            />
          </div>

          {err && <div className="note" style={{ color: 'var(--red-fg)' }}>{err}</div>}

          <div className="note">
            {mode === 'login' ? '还没有账号？' : '已有账号？'}
            <a
              style={{ color: 'var(--blue)', marginLeft: 6, cursor: 'pointer' }}
              onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}
            >
              去{mode === 'login' ? '注册' : '登录'}
            </a>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </div>
      </div>
    </div>
  );
}
