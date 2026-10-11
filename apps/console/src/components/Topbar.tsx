/**
 * 顶栏：品牌标识 + 主导航 + 上游服务健康指示灯 + 登录态。
 */

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { NAV_ITEMS } from '../lib/tools';

interface Props {
  active: string;
  onNav: (key: string) => void;
  onOpenAuth: () => void;
}

export function Topbar({ active, onNav, onOpenAuth }: Props) {
  const { user, logout } = useAuth();
  const [health, setHealth] = useState<{ ok: boolean; title: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api.services()
      .then((s) => {
        if (!alive) return;
        const ok = Boolean(s.crawler?.ok) && Boolean(s.intelligence?.ok);
        const down: string[] = [];
        if (!s.crawler?.ok) down.push('采集服务');
        if (!s.intelligence?.ok) down.push('智能服务');
        setHealth({
          ok,
          title: ok ? '上游服务正常（采集 / 智能）' : `${down.join('、')}未就绪`,
        });
      })
      .catch(() => {
        if (alive) setHealth({ ok: false, title: '网关未连接' });
      });
    return () => { alive = false; };
  }, []);

  const initial = (user?.email || '?').slice(0, 1).toUpperCase();

  return (
    <header className="topbar">
      <div className="topbar-in">
        <div className="logo" onClick={() => onNav('home')}>
          <span className="logo-mark">留</span>
          <span>留学生助手</span>
        </div>

        <nav className="nav">
          {NAV_ITEMS.map((it) => (
            <span
              key={it.key}
              className={active === it.key ? 'on' : ''}
              onClick={() => onNav(it.key)}
            >
              {it.label}
            </span>
          ))}
        </nav>

        <div className="topbar-right">
          {health && (
            <span className={`badge ${health.ok ? 'green' : 'red'}`} title={health.title}>
              {health.ok ? '服务正常' : '服务异常'}
            </span>
          )}
          {user ? (
            <>
              <span className="user-chip" title={user.email}>
                <span className="avatar">{initial}</span>
                {user.email}
              </span>
              <button className="btn sm" onClick={() => { void logout(); }}>退出</button>
            </>
          ) : (
            <button className="btn primary sm" onClick={onOpenAuth}>登录 / 注册</button>
          )}
        </div>
      </div>
    </header>
  );
}
