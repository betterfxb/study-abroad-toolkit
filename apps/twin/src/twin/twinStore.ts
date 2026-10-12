/**
 * 充电站孪生 · 纯数据层（零依赖，可被 node 直接 import 断言）。
 *
 * 全部为纯函数：给定输入必得相同输出，不读时钟、不做网络。
 * 实时跳动由调用方传 dt 推进（tickStats），界面层用 setInterval 驱动。
 */

export interface StationStats {
  totalKwh: number;
  totalSessions: number;
  todayKwh: number;
  todaySessions: number;
  faultKw: number;
  alarmCount: number;
}

export interface DayPoint {
  day: string;
  cur: number;
  prev: number;
}

export interface PileDetail {
  id: string;
  soc: number;
  elapsedSec: number;
  powerKw: number;
  voltage: number;
  current: number;
  tempC: number;
  protectLevel: string;
  batteryAge: string;
}

export function getStationStats(): StationStats {
  return {
    totalKwh: 288.36,
    totalSessions: 147528,
    todayKwh: 7456.04,
    todaySessions: 312,
    faultKw: 66.82,
    alarmCount: 2,
  };
}

/** 当日使用情况 · 本月 vs 上月（对齐参考视频 01~07 的曲线形态）。 */
export function getDailySeries(): DayPoint[] {
  const cur = [140, 165, 85, 120, 115, 45, 157];
  const prev = [25, 35, 40, 95, 70, 80, 45];
  return cur.map((v, i) => ({
    day: `0${i + 1}`,
    cur: v,
    prev: prev[i],
  }));
}

/** 字符串 hash，保证同桩同详情（可测试、无随机抖动）。 */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getPileDetail(pileId: string): PileDetail {
  const h = hashStr(pileId);
  const soc = 32 + (h % 55);
  return {
    id: pileId,
    soc,
    elapsedSec: 20 + (h % 2400),
    powerKw: 60 + (h % 61),
    voltage: 380 + (h % 40),
    current: 150 + (h % 120),
    tempC: 36 + (h % 9),
    protectLevel: '高等',
    batteryAge: '1 年',
  };
}

export function formatElapsed(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * 按秒推进 mock 电量。chargingPiles 为正在充电的桩数，
 * 每桩按 120kW 折算为真实 kWh，2 秒一跳约 +0.2，演示可见。
 */
export function tickStats(prev: StationStats, dtSec: number, chargingPiles: number): StationStats {
  const safeDt = Math.min(Math.max(dtSec, 0), 60);
  const safeN = Math.min(Math.max(chargingPiles, 0), 32);
  const addKwh = (safeN * 120 * safeDt) / 3600;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    ...prev,
    todayKwh: round2(prev.todayKwh + addKwh),
    totalKwh: round2(prev.totalKwh + addKwh),
  };
}

/** SVG 折线点位计算（纯函数，方便单测）。 */
export function seriesPoints(
  series: DayPoint[],
  key: 'cur' | 'prev',
  w: number,
  h: number,
  pad = 6,
): string {
  if (series.length === 0) return '';
  const max = Math.max(...series.map((d) => Math.max(d.cur, d.prev)), 10);
  return series
    .map((d, i) => {
      const x = series.length === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (series.length - 1);
      const y = h - pad - (d[key] / max) * (h - pad * 2);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}
