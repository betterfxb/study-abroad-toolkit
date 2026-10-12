/**
 * 充电站孪生 · 纯布局逻辑（零依赖，可被 node 直接 import 断言）。
 *
 * 与 three.js 的场景搭建分离：这里只算“摆在哪”，不碰任何 DOM / WebGL。
 * 坐标系：X 向右（车位排布方向），Z 向外（车头朝 +Z），单位米。
 */

export interface SpotLayout {
  id: string;
  index: number;
  /** 中心坐标 */
  x: number;
  z: number;
  w: number;
  d: number;
  /** 地面编号，如 B001 */
  code: string;
  pileId: string | null;
  occupied: boolean;
  carColor: string | null;
}

export interface PileLayout {
  id: string;
  index: number;
  x: number;
  z: number;
  rotY: number;
  status: 'charging' | 'idle' | 'fault';
  powerKw: number;
}

export interface CanopyLayout {
  width: number;
  depth: number;
  height: number;
  colX: number[];
  colZ: number[];
}

export interface StationLayout {
  spots: SpotLayout[];
  piles: PileLayout[];
  canopy: CanopyLayout;
}

export interface LayoutOptions {
  spotCount?: number;
  seed?: number;
}

const CAR_COLORS: (string | null)[] = ['#1fb6d5', '#1fb6d5', null, '#e23b3b', null, null];
const PILE_STATUS: PileLayout['status'][] = ['charging', 'charging', 'idle', 'charging'];

/** 极简确定性伪随机（mulberry32），保证同 seed 同布局、可测试。 */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pileIdOf(index: number): string {
  return `P${String(index + 1).padStart(2, '0')}`;
}

export function spotCodeOf(index: number): string {
  return `B${String(index + 1).padStart(3, '0')}`;
}

export function buildStationLayout(opts: LayoutOptions = {}): StationLayout {
  const spotCount = Math.min(Math.max(opts.spotCount ?? 6, 2), 12);
  const rand = rng32(opts.seed ?? 20261011);

  const spotW = 3.1;
  const spotD = 6.0;
  const gap = 0.25;
  const rowZ = 0;
  // 桩岛在车位后方（-Z 侧），雨棚柱再往后
  const pileZ = -spotD / 2 - 1.1;

  const spots: SpotLayout[] = [];
  const piles: PileLayout[] = [];
  const pileCount = Math.min(4, spotCount);

  for (let i = 0; i < spotCount; i += 1) {
    const x = (i - (spotCount - 1) / 2) * (spotW + gap);
    const hasPile = i < pileCount;
    spots.push({
      id: `S${String(i + 1).padStart(2, '0')}`,
      index: i,
      x,
      z: rowZ,
      w: spotW,
      d: spotD,
      code: spotCodeOf(i),
      pileId: hasPile ? pileIdOf(i) : null,
      occupied: i < CAR_COLORS.length ? CAR_COLORS[i] !== null : rand() < 0.4,
      carColor: i < CAR_COLORS.length ? CAR_COLORS[i] : rand() < 0.4 ? '#1fb6d5' : null,
    });
  }

  for (let i = 0; i < pileCount; i += 1) {
    const sx = spots[i].x;
    piles.push({
      id: pileIdOf(i),
      index: i,
      x: sx + spotW / 2 + 0.55,
      z: pileZ,
      rotY: 0,
      status: PILE_STATUS[i % PILE_STATUS.length],
      powerKw: PILE_STATUS[i % PILE_STATUS.length] === 'charging' ? 120 : 0,
    });
  }

  const totalW = spotCount * (spotW + gap) + 4;
  const canopy: CanopyLayout = {
    width: totalW,
    depth: spotD + 5.2,
    height: 5.4,
    colX: [-(totalW / 2 - 1.2), 0, totalW / 2 - 1.2],
    colZ: [rowZ - spotD / 2 - 2.2, rowZ + spotD / 2 + 1.4],
  };

  return { spots, piles, canopy };
}

export function occupiedCount(layout: StationLayout): number {
  return layout.spots.filter((s) => s.occupied).length;
}

export function chargingCount(layout: StationLayout): number {
  return layout.piles.filter((p) => p.status === 'charging').length;
}

export function pileById(layout: StationLayout, id: string): PileLayout | null {
  return layout.piles.find((p) => p.id === id) ?? null;
}

export function spotOfPile(layout: StationLayout, pileId: string): SpotLayout | null {
  return layout.spots.find((s) => s.pileId === pileId) ?? null;
}
