/** /jobs 快照加载器：fetch JSON 渲染 Top5 + 更新日期 + 超 3 天黄条；失败保留静态演示。 */
(function () {
  'use strict';
  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
  ready(function () {
    var live = document.getElementById('snapshotLive');
    var stamp = document.getElementById('snapshotStamp');
    var warn = document.getElementById('snapshotWarn');
    if (!live) return;
    var FALLBACK = '沿用演示数据';
    fetch('../assets/jobs-snapshot.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (data) {
        if (!data || !Array.isArray(data.jobs) || !data.jobs.length) throw new Error('empty');
        var top = data.jobs.slice(0, 5);
        var html = '';
        for (var i = 0; i < top.length; i++) {
          var j = top[i];
          var tags = (j.tags || []).join('/');
          html += '<li class="rv rv-left in" style="--d:' + (i * 100) + 'ms"><b>' +
            esc(j.company) + ' · ' + esc(j.title) + '</b> —— ' +
            esc(j.city) + ' · ' + esc(j.education) + ' · ' + esc(tags) +
            ' · 截止 ' + esc((j.deadline || '').slice(5)) + '</li>';
        }
        live.innerHTML = html;
        var d = new Date(data.updated_at);
        var ds = isNaN(d) ? '' : d.toISOString().slice(0, 10);
        if (stamp) stamp.textContent = '快照更新于 ' + ds + '（共 ' + data.total + ' 条，按 DDL 升序取前 5）';
        if (warn && ds) {
          var age = (Date.now() - d.getTime()) / 86400000;
          if (age > 3) {
            warn.hidden = false;
            warn.textContent = '快照已超过 3 天未更新（' + ds + '），以下为最近一次生成结果；完整列表请访问控制台。';
          }
        }
      })
      .catch(function () { if (stamp) stamp.textContent = FALLBACK + '（快照文件缺失或不可用）'; });
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
  });
})();
