/**
 * 应用外壳：Tab 路由（hash 持久化）+ 全局 Provider + 顶栏 + 内容区。
 */

import { useCallback, useEffect, useState } from 'react';
import { AuthModal } from './components/AuthModal';
import { ApplyTab } from './components/ApplyTab';
import { GpaTab } from './components/GpaTab';
import { HomeTab } from './components/HomeTab';
import { JobsTab } from './components/JobsTab';
import { ProfileTab } from './components/ProfileTab';
import { SubscriptionsTab } from './components/SubscriptionsTab';
import { ToastProvider } from './components/Toasts';
import { Topbar } from './components/Topbar';
import { AuthProvider } from './lib/auth';
import { NAV_ITEMS } from './lib/tools';

const VALID_TABS = NAV_ITEMS.map((n) => n.key);

function readHash(): string {
  const h = window.location.hash.replace(/^#\/?/, '');
  return VALID_TABS.includes(h) ? h : 'home';
}

function Shell() {
  const [tab, setTab] = useState<string>(() => readHash());
  const [authOpen, setAuthOpen] = useState(false);

  // 浏览器前进/后退
  useEffect(() => {
    const onHash = () => setTab(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const nav = useCallback((key: string) => {
    const next = VALID_TABS.includes(key) ? key : 'home';
    setTab(next);
    if (window.location.hash !== `#/${next}`) {
      window.location.hash = `#/${next}`;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return (
    <>
      <Topbar active={tab} onNav={nav} onOpenAuth={() => setAuthOpen(true)} />
      <main className="wrap">
        {tab === 'home' && <HomeTab onNav={nav} />}
        {tab === 'jobs' && <JobsTab onNeedAuth={() => setAuthOpen(true)} />}
        {tab === 'subscriptions' && <SubscriptionsTab onNeedAuth={() => setAuthOpen(true)} />}
        {tab === 'apply' && <ApplyTab onNeedAuth={() => setAuthOpen(true)} />}
        {tab === 'gpa' && <GpaTab />}
        {tab === 'profile' && <ProfileTab onNeedAuth={() => setAuthOpen(true)} />}
      </main>
      {authOpen && (
        <AuthModal onClose={() => setAuthOpen(false)} onDone={() => setAuthOpen(false)} />
      )}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AuthProvider>
  );
}
