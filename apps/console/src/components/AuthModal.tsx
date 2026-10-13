/**
 * 登录 / 注册弹窗。登录成功后由 AuthProvider 写入 localStorage，弹窗自行关闭。
 * antd Modal + Input 实现，登录/注册用 Tabs 切换。
 */

import { useState } from 'react';
import { Input, Modal, Tabs } from 'antd';
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

  const onTab = (k: string) => {
    setMode(k as 'login' | 'register');
    setErr('');
  };

  return (
    <Modal
      open
      title="留学生助手"
      onCancel={onClose}
      maskClosable={!busy}
      footer={[
        <button key="cancel" className="btn" onClick={onClose}>取消</button>,
        <button key="ok" className="btn primary" onClick={() => void submit()} disabled={busy}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
        </button>,
      ]}
    >
      <Tabs
        activeKey={mode}
        onChange={onTab}
        items={[
          { key: 'login', label: '登录' },
          { key: 'register', label: '注册' },
        ]}
        style={{ marginBottom: 4 }}
      />

      <div className="field" style={{ marginBottom: 12 }}>
        <label>邮箱</label>
        <Input
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
          <Input
            placeholder="留空则取邮箱前缀"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>
      )}

      <div className="field">
        <label>密码</label>
        <Input.Password
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          placeholder={mode === 'register' ? '至少 6 位' : '请输入密码'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onPressEnter={() => void submit()}
        />
      </div>

      {err && <div className="note" style={{ color: 'var(--red-fg)', marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}
