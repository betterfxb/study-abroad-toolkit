/**
 * Tab · 储能充电站孪生：3D 场景 + 深色数据 HUD。
 *
 * 数据层全部走 ./twinStore.ts 纯函数（mock 实时跳动），后续接网关时
 * 只需把 stats / pileDetail 换成 api 订阅，3D 与 HUD 不用动。
 */

import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../components/Toasts';
import { ChargeScene } from './ChargeScene';
import { buildStationLayout, chargingCount, occupiedCount } from './layout';
import {
  formatElapsed,
  getDailySeries,
  getPileDetail,
  getStationStats,
  seriesPoints,
  tickStats,
} from './twinStore';
import './twin.css';

function nowLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ChargeTwinTab() {
  const toast = useToast();
  const layout = useMemo(() => buildStationLayout({ spotCount: 6 }), []);
  const series = useMemo(() => getDailySeries(), []);
  const [stats, setStats] = useState(getStationStats);
  const [night, setNight] = useState(false);
  const [solarRoof, setSolarRoof] = useState(false);
  const [roam, setRoam] = useState(false);
  const [xray, setXray] = useState(false);
  const [bottomTab, setBottomTab] = useState<'storage' | 'pile'>('pile');
  const [selectedPile, setSelectedPile] = useState<string | null>(null);
  const [clock, setClock] = useState(nowLabel);

  const chg = chargingCount(layout);
  const occ = occupiedCount(layout);

  // mock 实时推进：2 秒一跳
  useEffect(() => {
    const timer = window.setInterval(() => {
      setStats((s) => tickStats(s, 2, chg));
      setClock(nowLabel());
    }, 2000);
    return () => window.clearInterval(timer);
  }, [chg]);

  const detail = selectedPile ? getPileDetail(selectedPile) : null;
  const curPts = seriesPoints(series, 'cur', 232, 84);
  const prevPts = seriesPoints(series, 'prev', 232, 84);
  const socDash = detail ? `${(detail.soc / 100) * 163} 163` : '0 163';

  return (
    <div className="twin-page">
      <div className="panel mb-[16px]">
        <div className="panel-title">
          储能充电站数字孪生
          <span className="sub">6 车位 · 4 充电桩 · 膜结构雨棚 · 程序化建模 Demo（对标参考视频）</span>
        </div>
        <div className="stat">
          <span>车位占用 <b>{occ} / {layout.spots.length}</b></span>
          <span>充电中 <b>{chg}</b></span>
          <span>雨棚 <b>{solarRoof ? '光伏板' : '膜结构'}</b></span>
          <span>模式 <b>{night ? '夜景' : '白天'}</b></span>
        </div>
      </div>

      <div className="twin-stage">
        <ChargeScene
          layout={layout}
          night={night}
          solarRoof={solarRoof}
          roam={roam}
          xray={xray}
          selectedPile={selectedPile}
          onSelectPile={setSelectedPile}
          onCarClick={() => setXray((v) => !v)}
        />

        {/* 顶栏 */}
        <div className="twin-hud twin-top">
          <span className="twin-title">国扑储能充电站</span>
          <span className="twin-sub">Energy Storage Charging Station</span>
          <span className="twin-spacer" />
          <span className="twin-chip">32°C</span>
          <span className="twin-chip">{clock}</span>
          <span className="twin-chip">{night ? '夜晚' : '白天'}</span>
        </div>

        {/* 左侧统计 */}
        <div className="twin-hud twin-left">
          <div className="twin-card">
            <div className="twin-kv2">
              <div className="twin-kv">
                <div className="k">总充电量</div>
                <div className="v">{stats.totalKwh.toFixed(2)}</div>
              </div>
              <div className="twin-kv">
                <div className="k">总充电次数</div>
                <div className="v">{stats.totalSessions}</div>
              </div>
              <div className="twin-kv">
                <div className="k">今日充电量</div>
                <div className="v">{stats.todayKwh.toFixed(2)}</div>
              </div>
              <div className="twin-kv">
                <div className="k">故障功率</div>
                <div className="v red">{stats.faultKw.toFixed(2)}</div>
              </div>
            </div>
          </div>
          <div className="twin-card">
            <h4>当日使用情况统计 <span className="en">Daily usage statistics</span></h4>
            <div className="twin-legend">
              <span><i style={{ background: '#38bdf8' }} />本月</span>
              <span><i style={{ background: '#94a3b8' }} />上月</span>
            </div>
            <svg viewBox="0 0 232 84" width="100%" height="84" aria-label="当日使用曲线">
              <polyline points={prevPts} fill="none" stroke="#94a3b8" strokeWidth="2" />
              <polyline points={curPts} fill="none" stroke="#38bdf8" strokeWidth="2.5" />
              <polygon points={`${curPts} 226,78 6,78`} fill="rgba(56,189,248,0.18)" stroke="none" />
            </svg>
            <div className="twin-legend">
              {series.map((d) => (
                <span key={d.day}>{d.day}</span>
              ))}
            </div>
          </div>
        </div>

        {/* 右侧工具栏 */}
        <div className="twin-hud twin-right">
          <button
            className="twin-tool"
            onClick={() => toast.info('换电站视角演示版暂未接入')}
            title="换电站"
          >
            <span className="dot">⇄</span>换电站
          </button>
          <button
            className={`twin-tool ${bottomTab === 'storage' ? 'on' : ''}`}
            onClick={() => setBottomTab('storage')}
            title="储能电池"
          >
            <span className="dot">▦</span>储能电池
          </button>
          <button
            className={`twin-tool ${solarRoof ? 'on' : ''}`}
            onClick={() => setSolarRoof((v) => !v)}
            title="太阳能板 / 膜结构切换"
          >
            <span className="dot">☀</span>太阳能板
          </button>
          <button
            className={`twin-tool ${bottomTab === 'pile' ? 'on' : ''}`}
            onClick={() => {
              setBottomTab('pile');
              setSelectedPile((cur) => cur ?? layout.piles[0]?.id ?? null);
            }}
            title="充电桩"
          >
            <span className="dot">⚡</span>充电桩
          </button>
          <button
            className={`twin-tool ${xray ? 'on' : ''}`}
            onClick={() => setXray((v) => !v)}
            title="车辆 X 光（点击车辆也可切换）"
          >
            <span className="dot">◈</span>透视
          </button>
          <button
            className={`twin-tool ${roam ? 'on' : ''}`}
            onClick={() => setRoam((v) => !v)}
            title="漫游"
          >
            <span className="dot">▶</span>漫游
          </button>
          <button
            className={`twin-tool ${night ? 'on' : ''}`}
            onClick={() => setNight((v) => !v)}
            title="白天 / 夜晚"
          >
            <span className="dot">{night ? '☾' : '☀'}</span>{night ? '夜晚' : '白天'}
          </button>
        </div>

        {/* 桩详情卡 */}
        {detail && (
          <div className="twin-hud twin-card twin-detail">
            <button className="twin-close" onClick={() => setSelectedPile(null)} aria-label="关闭">×</button>
            <h4>充电桩 {detail.id} <span className="en">charging</span></h4>
            <div className="soc-row">
              <svg viewBox="0 0 64 64" width="64" height="64">
                <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(125,211,252,0.2)" strokeWidth="7" />
                <circle
                  cx="32"
                  cy="32"
                  r="26"
                  fill="none"
                  stroke="#38bdf8"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={socDash}
                  transform="rotate(-90 32 32)"
                />
              </svg>
              <div>
                <div className="soc-num">{detail.soc}%</div>
                <div className="soc-time">充电时长 {formatElapsed(detail.elapsedSec)}</div>
              </div>
            </div>
            <div className="twin-rows">
              <div className="twin-row"><span className="k">安全防护</span><span className="v">{detail.protectLevel}</span></div>
              <div className="twin-row"><span className="k">电池年龄</span><span className="v">{detail.batteryAge}</span></div>
              <div className="twin-row"><span className="k">电池温度</span><span className="v">{detail.tempC}°C</span></div>
              <div className="twin-row"><span className="k">当前功率</span><span className="v">{detail.powerKw} kW</span></div>
              <div className="twin-row"><span className="k">电压 / 电流</span><span className="v">{detail.voltage}V / {detail.current}A</span></div>
            </div>
          </div>
        )}

        {/* 储能卡 */}
        {bottomTab === 'storage' && !detail && (
          <div className="twin-hud twin-card twin-detail">
            <h4>储能电池 <span className="en">storage</span></h4>
            <div className="twin-rows">
              <div className="twin-row"><span className="k">集装箱</span><span className="v">4 仓</span></div>
              <div className="twin-row"><span className="k">总容量</span><span className="v">800 kWh</span></div>
              <div className="twin-row"><span className="k">当前 SOC</span><span className="v">76%</span></div>
              <div className="twin-row"><span className="k">今日放电</span><span className="v">1,240 kWh</span></div>
            </div>
          </div>
        )}

        {/* 底部页签 */}
        <div className="twin-hud twin-bottom">
          <button
            className={`twin-tab ${bottomTab === 'storage' ? 'on' : ''}`}
            onClick={() => setBottomTab('storage')}
          >
            储能
          </button>
          <button
            className={`twin-tab ${bottomTab === 'pile' ? 'on' : ''}`}
            onClick={() => setBottomTab('pile')}
          >
            充电桩
          </button>
        </div>

        <div className="twin-hud twin-hint">
          拖拽旋转 · 滚轮缩放 · 点击充电桩查看详情 · 点击车辆切换透视
        </div>
      </div>

      <p className="note">
        Demo 数据为本地 mock（2 秒推进一次），对接真实网关数据时 HUD 与 3D 无需改动，只替换数据源。
      </p>
    </div>
  );
}
