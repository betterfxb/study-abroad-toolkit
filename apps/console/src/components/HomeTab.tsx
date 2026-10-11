/**
 * Tab 1 · 工具集首页：Hero + 工具卡片栅格。
 * 视觉对齐 docs/02-详细设计/04-UI原型.html 的 8 张卡片。
 */

import { useState } from 'react';
import { GUIDE_KEY } from '../lib/format';
import { TOOL_CARDS, type ToolCard } from '../lib/tools';
import { useToast } from './Toasts';

interface Props {
  onNav: (key: string) => void;
}

function readGuideOpen(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_KEY) !== '1';
  } catch {
    return true;
  }
}

export function HomeTab({ onNav }: Props) {
  const toast = useToast();
  const [guideOpen, setGuideOpen] = useState<boolean>(readGuideOpen);

  const open = (card: ToolCard) => {
    if (card.action.tab) {
      onNav(card.action.tab);
      return;
    }
    if (card.action.href) {
      window.open(card.action.href, '_blank', 'noopener');
      return;
    }
    toast.info(`「${card.title}」正在接入中，敬请期待`);
  };

  return (
    <>
      <div className="hero">
        <h1>AI 驱动，载你走完留学申请与实习求职</h1>
        <p>
          留学网申自动填写 · 实习信息全网聚合 · 文书与简历精修。
          把重复枯燥的事交给 AI，你只负责检查与决策。
        </p>
        <div className="hero-tags">
          <span className="pill">浏览器插件</span>
          <span className="pill">多源聚合</span>
          <span className="pill gold">不自动提交 · 人工复核</span>
        </div>
      </div>

      {guideOpen && (
        <div className="panel guide mb-[16px]">
          <div className="panel-title">
            三步上手
            <span className="sub">第一次来？按这个顺序走一遍</span>
          </div>
          <div className="guide-steps">
            <span><b>1</b> 去「实习信息」看看岗位，顺手导出一份汇总表</span>
            <span><b>2</b> 右上角注册登录，建一条岗位订阅（每天自动推送）</span>
            <span><b>3</b> 在「申请进度」里登记你的留学申请，DDL 会自动倒计时</span>
          </div>
          <div className="mt-[12px] flex gap-[8px] flex-wrap">
            <button className="btn primary sm" onClick={() => onNav('jobs')}>去看岗位</button>
            <button
              className="btn sm"
              onClick={() => {
                try {
                  window.localStorage.setItem(GUIDE_KEY, '1');
                } catch {
                  /* 忽略 */
                }
                setGuideOpen(false);
              }}
            >
              知道了，不再提示
            </button>
          </div>
        </div>
      )}

      <div className="grid">
        {TOOL_CARDS.map((c) => (
          <div key={c.id} className="card" onClick={() => open(c)}>
            <div className="card-ico" style={{ background: c.bg }}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke={c.stroke}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dangerouslySetInnerHTML={{ __html: c.icon }}
              />
            </div>
            <h3>
              {c.title}
              {c.hot && <span className="hot">HOT</span>}
            </h3>
            <div className="desc">{c.desc}</div>
            <div className="meta">
              <span>{c.meta}</span>
              <span>→</span>
            </div>
          </div>
        ))}
      </div>

      <p className="note">
        说明：网申填写由浏览器插件在院校页面内执行，控制台只负责资料与进度管理；
        系统不会代替你提交任何申请，所有提交动作均由本人复核后完成。
      </p>
    </>
  );
}
