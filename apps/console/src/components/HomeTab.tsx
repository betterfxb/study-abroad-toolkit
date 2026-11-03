/**
 * Tab 1 · 工具集首页：Hero + 跑马灯 + 工具卡片栅格。
 * 视觉对齐 docs/02-详细设计/04-UI原型.html 的 8 张卡片。
 *
 * 动效约定（AGENTS.md「截图隐形陷阱」）：
 *   - 全部为「加载即触发」的一次性入场 / 常驻循环，禁止 opacity:0 等视口显现；
 *   - 基础样式保持可见，起始态只写在 @keyframes 的 from 里，
 *     这样动画不执行时（SSR / prefers-reduced-motion）内容依然完整可见。
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { GUIDE_KEY } from '../lib/format';
import { TOOL_CARDS, type ToolCard } from '../lib/tools';
import { useToast } from './Toasts';

interface Props {
  onNav: (key: string) => void;
}

/** 跑马灯关键词（与官网一致的轮播文案） */
const MARQUEE =
  '实习信息聚合 ✦ 关键词订阅推送 ✦ GPA 成绩换算 ✦ 申请进度管理 ✦ 推荐信跟踪 ✦ 留学网申自动填写 ✦ ';

/** Hero 标题逐词拆分——拼接结果必须与原文完全一致（render_test 剥标签后断言） */
const TITLE_WORDS: Array<{ text: string; em?: boolean }> = [
  { text: 'AI 驱动', em: true },
  { text: '，载你走完' },
  { text: '留学申请' },
  { text: '与实习求职' },
];

function readGuideOpen(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_KEY) !== '1';
  } catch {
    return true;
  }
}

/**
 * 数字滚动：把「12.4 万人使用」的数字滚到目标值。
 * 首帧直接渲染最终文本（SSR / render_test 拿到完整文案），
 * 之后用 ref 直写 DOM，不触发 React 重渲染；无数值文案原样返回。
 */
function CountUp({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = /^([\d.]+)(\s*万人使用)$/.exec(text);
    if (!m) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const target = parseFloat(m[1]);
    const unit = m[2];
    const decimals = (m[1].split('.')[1] || '').length;
    const dur = 1100;
    const t0 = performance.now();
    let raf = 0;

    el.textContent = (0).toFixed(decimals) + unit;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = (target * eased).toFixed(decimals) + unit;
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        el.textContent = text;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);

  return <span ref={ref}>{text}</span>;
}

export function HomeTab({ onNav }: Props) {
  const toast = useToast();
  const [guideOpen, setGuideOpen] = useState<boolean>(readGuideOpen);
  const heroRef = useRef<HTMLDivElement>(null);

  // 光斑跟随指针：移动时接管位置，离开后交还给 CSS 自动漂移
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${(((e.clientX - r.left) / r.width) * 100).toFixed(2)}%`);
      el.style.setProperty('--my', `${(((e.clientY - r.top) / r.height) * 100).toFixed(2)}%`);
      el.classList.add('tracking');
    };
    const leave = () => el.classList.remove('tracking');
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, []);

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
      <div className="hero" ref={heroRef}>
        {/* 星尘点阵：纯 CSS 背景点阵 + 渐隐遮罩，加载即可见（非视口显现） */}
        <div className="hero-dust" aria-hidden="true" />
        {/* 光斑：默认 CSS 自动漂移，指针进入后跟随（.hero.tracking 交棒） */}
        <div className="hero-glow" aria-hidden="true" />
        <h1>
          {TITLE_WORDS.map((w, i) => (
            <span key={w.text} className="w" style={{ '--i': i } as CSSProperties}>
              {w.em ? <em>{w.text}</em> : w.text}
            </span>
          ))}
        </h1>
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

      {/* 跑马灯：常驻循环，内容始终可见（非显现动画） */}
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          <span>{MARQUEE}</span>
          <span>{MARQUEE}</span>
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
        {TOOL_CARDS.map((c, i) => (
          <div
            key={c.id}
            className="card"
            style={{ '--ci': i } as CSSProperties}
            onClick={() => open(c)}
          >
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
              <CountUp text={c.meta} />
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
