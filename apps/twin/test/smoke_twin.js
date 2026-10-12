#!/usr/bin/env node
/**
 * 孪生独立站冒烟测试（零依赖，Node 原生 ESM + TS 类型擦除）。
 * 覆盖 src/twin 纯逻辑层（layout / twinStore）。
 *
 * 运行：npm test
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let pass = 0;
let fail = 0;
const failures = [];

function group(title) {
  console.log(`\n${title}`);
}

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    failures.push({ name, message: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}期望 ${b}，实际 ${a}`);
}

let layout = null;
let store = null;
let loadError = '';
try {
  layout = await import(new URL('../src/twin/layout.ts', import.meta.url).href);
} catch (e) {
  loadError = e.message;
}
try {
  store = await import(new URL('../src/twin/twinStore.ts', import.meta.url).href);
} catch (e) {
  if (!loadError) loadError = e.message;
}

group('孪生纯逻辑（layout / twinStore）');

if (!layout || !store) {
  console.log(`  ! 跳过：无法直接加载 .ts（${loadError.slice(0, 120)}）`);
  console.log('    Node >= 22.18 默认支持类型擦除，可升级 Node 后重跑。');
} else {
  test('默认布局为 6 车位 4 桩且占用 3 席', () => {
    const lay = layout.buildStationLayout({});
    eq(lay.spots.length, 6, '车位数：');
    eq(lay.piles.length, 4, '桩数：');
    eq(layout.occupiedCount(lay), 3, '占用数：');
    eq(layout.chargingCount(lay), 3, '充电桩数：');
  });

  test('车位编号与桩归属一一对应', () => {
    const lay = layout.buildStationLayout({});
    eq(lay.spots[0].code, 'B001', '首车位编号：');
    eq(lay.piles[0].id, 'P01', '首桩编号：');
    ok(layout.spotOfPile(lay, 'P01')?.id === 'S01', 'P01 应归属 S01');
    ok(layout.pileById(lay, 'P99') === null, '未知桩应返回 null');
  });

  test('同 seed 同布局（确定性）', () => {
    const a = layout.buildStationLayout({ seed: 7 });
    const b = layout.buildStationLayout({ seed: 7 });
    eq(a, b, '布局：');
  });

  test('桩详情同 id 同结果且 SOC 在合理区间', () => {
    const d1 = store.getPileDetail('P01');
    const d2 = store.getPileDetail('P01');
    eq(d1, d2, '详情：');
    ok(d1.soc >= 30 && d1.soc <= 95, `SOC 越界：${d1.soc}`);
    ok(/^\d{2}:\d{2}:\d{2}$/.test(store.formatElapsed(d1.elapsedSec)), '时长格式：');
  });

  test('tickStats 按充电桩数推进电量且不改其它字段', () => {
    const s0 = store.getStationStats();
    const s1 = store.tickStats(s0, 2, 3);
    ok(s1.todayKwh > s0.todayKwh, '今日电量应增长');
    eq(s1.totalSessions, s0.totalSessions, '次数不应变：');
    eq(store.tickStats(s0, -5, 3).todayKwh, s0.todayKwh, '负 dt 应钳制：');
  });

  test('seriesPoints 输出 7 个点且落在画布内', () => {
    const pts = store.seriesPoints(store.getDailySeries(), 'cur', 232, 84).split(' ');
    eq(pts.length, 7, '点数：');
    for (const p of pts) {
      const [x, y] = p.split(',').map(Number);
      ok(x >= 0 && x <= 232 && y >= 0 && y <= 84, `点越界：${p}`);
    }
  });
}

test('App 外壳装配孪生页与提示 Provider', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8');
  ok(/<ChargeTwinTab/.test(src), '未渲染 ChargeTwinTab');
  ok(/ToastProvider/.test(src), '缺少 ToastProvider');
});

console.log(`\n${'-'.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.message}`);
  process.exit(1);
}
console.log('孪生冒烟测试全部通过 ✓');
