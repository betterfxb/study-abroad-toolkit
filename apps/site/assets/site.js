/** 官网交互：菜单/viewport/动效触发/开关/进度条/跟随光斑（<100 行非空，零依赖） */
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  function isMobile() {
    var d = navigator.userAgentData;
    if (d && typeof d.mobile === 'boolean') return d.mobile;
    var ua = navigator.userAgent || '';
    if (/Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|iPad/i.test(ua)) return true;
    return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  }
  if (isMobile()) {
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover');
  }
  function store() { try { return window.localStorage; } catch (e) { return null; } }
  function reduced() { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } }
  function motionOn() {
    var s = store(); var v = s ? s.getItem('qz.motion') : null;
    if (v === 'off') return false;
    if (v === 'on') return true;
    return !reduced();
  }
  function applyMotion(on) {
    document.documentElement.setAttribute('data-motion', on ? 'on' : 'off');
    var b = document.getElementById('motionToggle');
    if (b) { b.textContent = '减少动态效果：' + (on ? '关' : '开'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  }
  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('menuBtn'), nav = document.getElementById('siteNav');
    if (btn && nav) {
      btn.addEventListener('click', function () { nav.classList.toggle('open'); });
      nav.addEventListener('click', function (e) { if (e.target && e.target.tagName === 'A') nav.classList.remove('open'); });
    }
    var on = motionOn();
    applyMotion(on);
    var t = document.getElementById('motionToggle');
    if (t) t.addEventListener('click', function () {
      on = !on;
      var s = store(); try { if (s) s.setItem('qz.motion', on ? 'on' : 'off'); } catch (e) {}
      applyMotion(on);
    });
    var bar = document.getElementById('scrollProgress');
    window.addEventListener('scroll', function () {
      document.documentElement.classList.add('settled');
      if (!bar) return;
      var h = document.documentElement, max = h.scrollHeight - h.clientHeight;
      bar.style.transform = 'scaleX(' + (max > 0 ? h.scrollTop / max : 0) + ')';
    }, { passive: true });
    var els = document.querySelectorAll('.rv, .rv-line');
    if (on && els.length) {
      if (!('IntersectionObserver' in window)) {
        for (var i = 0; i < els.length; i++) els[i].classList.add('in');
      } else {
        var io = new IntersectionObserver(function (es) {
          for (var k = 0; k < es.length; k++) {
            if (es[k].isIntersecting) { es[k].target.classList.add('in'); io.unobserve(es[k].target); }
          }
        }, { threshold: 0.15 });
        for (var j = 0; j < els.length; j++) io.observe(els[j]);
      }
    }
    // 数字滚动（一次性，reduce/off 直接显示终值）
    var nums = document.querySelectorAll('.stat-num[data-count]');
    function showNum(el) {
      var t = parseFloat(el.getAttribute('data-count')), d = parseInt(el.getAttribute('data-decimal') || '0', 10);
      if (!on) { el.textContent = t.toFixed(d); return; }
      var s0 = performance.now();
      (function tick(n) { var p = Math.min((n - s0) / 900, 1); el.textContent = (t * (1 - Math.pow(1 - p, 3))).toFixed(d); if (p < 1) requestAnimationFrame(tick); })(s0);
    }
    if (nums.length && 'IntersectionObserver' in window) {
      var nio = new IntersectionObserver(function (es) {
        for (var n = 0; n < es.length; n++) { if (es[n].isIntersecting) { showNum(es[n].target); nio.unobserve(es[n].target); } }
      }, { threshold: 0.4 });
      for (var q = 0; q < nums.length; q++) nio.observe(nums[q]);
    } else { for (var w = 0; w < nums.length; w++) showNum(nums[w]); }
    var fine = false;
    try { fine = window.matchMedia('(pointer: fine)').matches; } catch (e) {}
    if (on && fine) {
      var g = document.createElement('div');
      g.className = 'glow-follow'; g.setAttribute('aria-hidden', 'true');
      document.body.appendChild(g);
      var tx = -500, ty = -500, x = tx, y = ty, raf = 0;
      window.addEventListener('mousemove', function (e) {
        tx = e.clientX; ty = e.clientY;
        if (!raf) raf = requestAnimationFrame(function tick() {
          raf = 0;
          x += (tx - x) * 0.12; y += (ty - y) * 0.12;
          g.style.left = x + 'px'; g.style.top = y + 'px';
          if (Math.abs(tx - x) + Math.abs(ty - y) > 1) raf = requestAnimationFrame(tick);
        });
      }, { passive: true });
    }
  });
})();
