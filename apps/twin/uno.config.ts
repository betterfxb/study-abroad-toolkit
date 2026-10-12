import { defineConfig, presetUno } from 'unocss';

/**
 * UnoCSS 原子化样式层 —— 与现有「原生 CSS + 设计令牌(global.css / tokens.css)」共存。
 *
 * 设计原则（与 README 一致）：
 * 1. 关闭 preflight，避免重置样式与 global.css 冲突 —— global.css 仍是权威样式来源。
 * 2. theme 直接映射 tokens.css 的设计令牌，原子类(`text-red-fg` / `rounded-lg` / `shadow-md`)
 *    与原生 CSS 变量一一对应，视觉零漂移。
 * 3. 像素级内联样式用任意值语法(`mt-[14px]`)改写，保证与既有渲染像素严格一致。
 * 4. 仅作为「能力层」接入，不重写既有语义类(`.card` / `.panel` / `.badge` …)，保证零回归。
 */
export default defineConfig({
  presets: [
    presetUno({ preflight: false }),
  ],
  content: {
    filesystem: ['./src/**/*.{ts,tsx,html}'],
  },
  theme: {
    colors: {
      blue: { DEFAULT: '#2563eb', dark: '#1d4ed8', light: '#eff6ff' },
      gold: { DEFAULT: '#d4af37', bg: '#fdf7e3', fg: '#8a6d1b' },
      green: { DEFAULT: '#059669', bg: '#ecfdf5', fg: '#047857' },
      orange: { DEFAULT: '#ea580c', bg: '#fff7ed' },
      red: { DEFAULT: '#ef4444', bg: '#fef2f2', fg: '#b91c1c' },
      purple: { DEFAULT: '#7c3aed', bg: '#f5f3ff' },
      pink: { DEFAULT: '#db2777', bg: '#fdf2f8' },
      amber: { fg: '#b45309' },
      t1: '#0f172a',
      t2: '#475569',
      t3: '#94a3b8',
      appbg: '#f6f8fb',
      card: '#ffffff',
      line: '#e5e9f0',
      'line-soft': '#f1f5f9',
    },
    borderRadius: {
      lg: '16px',
      md: '10px',
      sm: '8px',
    },
    boxShadow: {
      sm: '0 1px 2px rgba(15, 23, 42, 0.04)',
      md: '0 8px 24px rgba(15, 23, 42, 0.08)',
      lg: '0 12px 32px rgba(15, 23, 42, 0.14)',
    },
  },
});
