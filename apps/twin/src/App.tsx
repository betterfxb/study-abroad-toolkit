/**
 * 孪生独立站外壳：薄顶栏 + 孪生页，无路由、无鉴权，开箱即展示。
 */

import { ToastProvider } from './components/Toasts';
import { ChargeTwinTab } from './twin/ChargeTwinTab';

export default function App() {
  return (
    <ToastProvider>
      <header className="twin-topbar">
        <div className="twin-topbar-in">
          <span className="twin-logo">⚡</span>
          <span className="twin-brand">国扑储能充电站 · 数字孪生</span>
          <span className="twin-badge">Demo</span>
        </div>
      </header>
      <main className="twin-wrap">
        <ChargeTwinTab />
      </main>
    </ToastProvider>
  );
}
