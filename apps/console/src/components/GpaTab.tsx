/**
 * 独立承接页 · 成绩换算（GPA 4.0 / 英制等级）。
 * 纯本地计算，不依赖后端；与「成绩换算」首页卡片一一对应。
 */

import { useState } from 'react';
import { GPA_REFERENCE, weightedGpa, type GpaCourseInput } from '../lib/gpa';

interface Row {
  id: number;
  name: string;
  credits: string;
  score: string;
}

let seq = 1;

export function GpaTab() {
  const [rows, setRows] = useState<Row[]>([
    { id: seq++, name: '', credits: '3', score: '88' },
    { id: seq++, name: '', credits: '4', score: '76' },
  ]);

  const update = (id: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => setRows((rs) => [...rs, { id: seq++, name: '', credits: '3', score: '' }]);
  const remove = (id: number) => setRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.id !== id)));

  const input: GpaCourseInput[] = rows.map((r) => ({
    credits: Number(r.credits) || 0,
    score: Number(r.score) || 0,
  }));
  const result = weightedGpa(input);
  const hasValid = input.some((c) => c.credits > 0);

  return (
    <div className="panel">
      <div className="panel-title">
        成绩换算 · GPA 4.0 / 英制等级
        <span className="sub">百分制加权换算，纯本地计算</span>
      </div>

      <div className="form-grid">
        {rows.map((r) => (
          <div className="field full" key={r.id}>
            <div className="flex gap-[8px] items-center">
              <input
                className="flex-1"
                placeholder="课程名（可选）"
                value={r.name}
                onChange={(e) => update(r.id, { name: e.target.value })}
              />
              <input
                className="w-[80px]"
                placeholder="学分"
                inputMode="decimal"
                value={r.credits}
                onChange={(e) => update(r.id, { credits: e.target.value })}
              />
              <input
                className="w-[96px]"
                placeholder="百分制"
                inputMode="decimal"
                value={r.score}
                onChange={(e) => update(r.id, { score: e.target.value })}
              />
              <button className="btn sm" onClick={() => remove(r.id)} disabled={rows.length <= 1}>
                删
              </button>
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={add}>+ 添加课程</button>
      </div>

      <div className="stat">
        <span>加权 GPA <b>{result.gpa.toFixed(1)}</b> / 4.0</span>
        <span>加权均分 <b>{hasValid ? result.avgPct.toFixed(1) : '—'}</b></span>
        <span>英制等级 <b>{hasValid ? result.ukClass : '—'}</b></span>
      </div>

      <div className="panel-title mt-[16px]">换算参照表</div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>百分制</th><th>GPA 4.0</th><th>英制等级</th></tr>
          </thead>
          <tbody>
            {GPA_REFERENCE.map((x) => (
              <tr key={x.range}>
                <td>{x.range}</td>
                <td>{x.gpa.toFixed(1)}</td>
                <td>{x.uk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="note">
        说明：GPA 与英制等级为国内常用阶梯映射，仅作横向参考；院校官方算法可能不同，请以目标项目要求为准。
      </p>
    </div>
  );
}
