/** GPA 换算器（纯前端，零依赖，与控制台 gpa.ts / intelligence gpa.py 同口径）。 */
(function () {
  'use strict';
  var LADDER = [[90, 4.0], [85, 3.7], [82, 3.3], [78, 3.0], [75, 2.7], [72, 2.3], [68, 2.0], [64, 1.5], [60, 1.0]];

  function gpaFromScore(score) {
    var s = Math.min(100, Math.max(0, Number(score) || 0));
    for (var i = 0; i < LADDER.length; i++) if (s >= LADDER[i][0]) return LADDER[i][1];
    return 0;
  }
  function ukClass(avg) {
    if (avg >= 70) return 'First (一等荣誉)';
    if (avg >= 60) return '2:1 (二等一)';
    if (avg >= 50) return '2:2 (二等二)';
    if (avg >= 40) return 'Third (三等)';
    return avg > 0 ? 'Fail (未达标)' : '—';
  }
  function round1(n) { return Math.round(n * 10) / 10; }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(function () {
    var input = document.getElementById('gpaInput');
    var out = document.querySelector('#calcOut .out-num');
    var meta = document.getElementById('calcMeta');
    var mode = 'pct';
    var META = {
      pct: '阶梯法：≥90→4.0，≥85→3.7，≥82→3.3，≥78→3.0，≥75→2.7，≥72→2.3，≥68→2.0，≥64→1.5，≥60→1.0，<60→0',
      five: '线性映射：4.0 制 = 5 分制 ÷ 5 × 4（如 4.5 → 3.6）',
      four: '4.0 制原样校验，超出 0–4.0 范围将提示'
    };

    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        document.querySelectorAll('.mode-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        mode = b.getAttribute('data-mode');
        meta.textContent = META[mode];
        input.placeholder = mode === 'five' ? '例如 4.5' : mode === 'four' ? '例如 3.7' : '例如 87';
        if (input.value) calc();
      });
    });

    function calc() {
      var v = Number(input.value);
      if (input.value === '' || !isFinite(v)) { out.textContent = '—'; return; }
      var res;
      if (mode === 'pct') {
        if (v < 0 || v > 100) { out.textContent = '超出范围'; return; }
        res = gpaFromScore(v);
      } else if (mode === 'five') {
        if (v < 0 || v > 5) { out.textContent = '超出范围'; return; }
        res = round1(v / 5 * 4);
      } else {
        if (v < 0 || v > 4) { out.textContent = '超出范围'; return; }
        res = round1(v);
      }
      out.textContent = res.toFixed(1);
    }
    document.getElementById('calcBtn').addEventListener('click', calc);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') calc(); });
    input.addEventListener('input', calc);

    var body = document.getElementById('courseBody');
    var SAMPLE = [
      ['高等数学', '4', '92'],
      ['线性代数', '3', '87'],
      ['大学英语', '2', '83']
    ];

    function rowHtml(name, cred, score) {
      return '<tr><td><input class="c-name" value="' + name + '" /></td>' +
        '<td><input class="c-cred" type="number" value="' + cred + '" min="0" step="0.5" /></td>' +
        '<td><input class="c-score" type="number" value="' + score + '" min="0" max="100" /></td>' +
        '<td class="c-pt">—</td></tr>';
    }

    function recalc() {
      var sumCred = 0, sumGp = 0, sumPct = 0, valid = 0;
      body.querySelectorAll('tr').forEach(function (tr) {
        var cred = Number(tr.querySelector('.c-cred').value);
        var score = tr.querySelector('.c-score').value;
        var pt = tr.querySelector('.c-pt');
        var s = score === '' ? NaN : Number(score);
        if (!(cred > 0) || !isFinite(s)) { pt.textContent = '—'; return; }
        var gp = gpaFromScore(s);
        pt.textContent = gp.toFixed(1);
        sumCred += cred; sumGp += gp * cred; sumPct += s * cred; valid++;
      });
      var g = sumCred ? sumGp / sumCred : 0;
      var a = sumCred ? sumPct / sumCred : 0;
      document.getElementById('wGpa').textContent = valid ? round1(g).toFixed(1) : '—';
      document.getElementById('wAvg').textContent = valid ? round1(a).toFixed(1) : '—';
      document.getElementById('wUk').textContent = valid ? ukClass(a) : '—';
      document.getElementById('wCred').textContent = String(round1(sumCred));
    }

    body.addEventListener('input', recalc);
    document.getElementById('addRow').addEventListener('click', function () {
      body.insertAdjacentHTML('beforeend', rowHtml('新课程', '3', '85'));
      recalc();
    });
    document.getElementById('resetRows').addEventListener('click', function () {
      body.innerHTML = SAMPLE.map(function (r) { return rowHtml(r[0], r[1], r[2]); }).join('');
      recalc();
    });
    recalc();
  });
})();
