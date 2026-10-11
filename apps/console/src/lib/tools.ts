/**
 * 工具集卡片数据 —— 与 docs/02-详细设计/04-UI原型.html 的 8 张卡片逐项对齐。
 *
 * icon 为内联 SVG path（保持原型同款线性图标风格，避免引入图标库）。
 * action 决定点击后的去向：
 *   { tab: 'jobs' }  切到控制台内某个 Tab
 *   { href: '...' }  打开外部链接（插件安装页 / 文档等）
 *   { soon: true }   占位：功能待接入，点击给出提示
 */

export interface ToolCard {
  id: string;
  title: string;
  hot?: boolean;
  desc: string;
  meta: string;
  /** 图标容器背景色 */
  bg: string;
  /** 描边色 */
  stroke: string;
  /** SVG 内容（不含 <svg> 外壳） */
  icon: string;
  action: { tab?: string; href?: string; soon?: boolean };
}

export const TOOL_CARDS: ToolCard[] = [
  {
    id: 'apply-autofill',
    title: '留学网申自动填写',
    hot: true,
    desc: 'AI 识别海外院校申请表单，多步向导一键填充，30 分钟缩短到 3 分钟',
    meta: '12.4 万人使用',
    bg: '#EFF6FF',
    stroke: '#2563EB',
    icon: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    action: { tab: 'apply' },
  },
  {
    id: 'job-aggregate',
    title: '实习信息聚合',
    hot: true,
    desc: '公众号 + 招聘平台 + 官网多源聚合，岗位结构化，实时更新去重',
    meta: '8.7 万人使用',
    bg: '#ECFDF5',
    stroke: '#059669',
    icon: '<path d="M3 6h18M3 12h18M3 18h12"/>',
    action: { tab: 'jobs' },
  },
  {
    id: 'resume-optimize',
    title: '简历优化 AI',
    desc: '三档力度智能重写，学术向 / 实习向双模板',
    meta: '6.2 万人使用',
    bg: '#FFF7ED',
    stroke: '#EA580C',
    icon: '<path d="M12 3l2.5 5.5L20 9.5l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-1z"/>',
    action: { tab: 'profile' },
  },
  {
    id: 'essay-polish',
    title: '文书精修 AI',
    desc: 'PS / SOP 按目标项目针对性打磨，字数实时校验',
    meta: '5.1 万人使用',
    bg: '#F5F3FF',
    stroke: '#7C3AED',
    icon: '<path d="M4 4h16v14H7l-3 3z"/><path d="M8 9h8M8 13h5"/>',
    action: { tab: 'profile' },
  },
  {
    id: 'program-library',
    title: '院校项目库',
    desc: '覆盖 ApplyWeb / Liaison / Slate 主流申请系统与项目',
    meta: '按平台归类',
    bg: '#EFF6FF',
    stroke: '#2563EB',
    icon: '<path d="M4 21V8l8-5 8 5v13"/><path d="M9 21v-6h6v6"/>',
    action: { tab: 'apply' },
  },
  {
    id: 'recommender',
    title: '推荐信管理',
    desc: '推荐人信息登记与邀请状态跟踪，不再漏催',
    meta: '3.4 万人使用',
    bg: '#FDF2F8',
    stroke: '#DB2777',
    icon: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 6h5M18.5 3.5v5"/>',
    action: { tab: 'apply' },
  },
  {
    id: 'progress-sheet',
    title: '申请进度表',
    desc: '在线表格记录全部申请进展，已投 / 面试 / Offer 一目了然',
    meta: '9.3 万人使用',
    bg: '#F0FDF4',
    stroke: '#16A34A',
    icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M8 4v16"/>',
    action: { tab: 'apply' },
  },
  {
    id: 'gpa-convert',
    title: '成绩换算',
    desc: 'GPA 4.0 / 百分制 / UK 等级互转，语言成绩制式映射',
    meta: '2.8 万人使用',
    bg: '#FEFCE8',
    stroke: '#CA8A04',
    icon: '<path d="M4 7h16v13H4z"/><path d="M8 7V4h8v3M8 12h8M8 16h5"/>',
    action: { tab: 'gpa' },
  },
];

export interface NavItem {
  key: string;
  label: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: '工具集首页' },
  { key: 'jobs', label: '实习信息汇总' },
  { key: 'subscriptions', label: '岗位订阅' },
  { key: 'apply', label: '申请进度' },
  { key: 'gpa', label: '成绩换算' },
  { key: 'profile', label: '资料库' },
];
