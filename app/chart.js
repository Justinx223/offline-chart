'use strict';
// Kerzenchart auf <canvas>: ziehen = verschieben, Mausrad = zoomen, Shift+ziehen = messen,
// an der Preisachse ziehen = senkrecht zoomen, Doppelklick auf Preisachse = automatisch.

const COLORS = {
  bg: '#0d1117', grid: '#1b222c', border: '#2a3340', text: '#8b96a5', textStrong: '#d6dde6', axisBg: '#0d1117',
  up: '#26a69a', down: '#ef5350', wickUp: '#26a69a', wickDown: '#ef5350', gridOn: true, cross: '#5d6b7e', win: '#22c55e', loss: '#ef4444',
  tpZone: 'rgba(34,197,94,0.13)', slZone: 'rgba(239,68,68,0.13)', measure: 'rgba(96,165,250,0.18)',
};

class Chart {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.bars = null;
    this.ov = { plots: [], hlines: [], bg: null, markers: [], boxes: [], trades: [], pos: null, orders: [] };
    this.barW = 8;
    this.right = 0;
    this.autoY = true;
    this.yMin = 0; this.yMax = 1;
    this.limit = null;
    this.mouse = null;
    this.drag = null;
    this.measure = null;
    this.offsetMs = 3600000;
    this.digits = 2;
    this.pip = 0.1;
    this.title = '';
    this.onClick = null;
    this.onViewChange = null;
    this.dirty = false;
    this.axisW = 74; this.timeH = 24;
    this.th = Object.assign({}, COLORS);
    this.touch = false;
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  // ---------- Daten ----------
  setData(bars, info, keepTime) {
    const oldT = keepTime && this.bars ? this.bars.t[Math.max(0, Math.min(this.bars.n - 1, Math.round(this.right)))] : null;
    this.bars = bars;
    Object.assign(this, info);
    this.ov = { plots: [], hlines: [], bg: null, markers: [], boxes: [], trades: [], pos: null, orders: [] };
    if (oldT != null) this.right = this.indexAt(oldT) + 0.5;
    else this.right = this.last() + 5;
    this.autoY = true;
    this.request();
  }

  // Farben ändern. Text- und Achsenfarben passen sich automatisch an hellen/dunklen Hintergrund an
  setTheme(t) {
    const th = Object.assign({}, COLORS, t);
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(th.bg);
    const lum = m ? (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255 : 0;
    th.light = lum > 0.55;
    th.axisBg = th.bg;
    th.text = th.light ? '#5d6673' : '#8b96a5';
    th.textStrong = th.light ? '#131722' : '#d6dde6';
    th.border = th.light ? '#d1d4dc' : '#2a3340';
    th.cross = th.light ? '#9598a1' : '#5d6b7e';
    if (!t.grid) th.grid = th.light ? '#eef0f3' : '#1b222c';
    this.th = th;
    this.request();
  }

  setOverlay(ov) { this.ov = Object.assign({ plots: [], hlines: [], bg: null, markers: [], boxes: [], trades: [], pos: null, orders: [] }, ov); this.request(); }

  last() { return this.limit != null ? Math.min(this.limit, this.bars.n - 1) : this.bars.n - 1; }

  indexAt(t) {
    const T = this.bars.t;
    let lo = 0, hi = this.bars.n - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m + 1; else hi = m; }
    return lo;
  }

  goToIndex(i, zoomBars) {
    if (zoomBars && this.plotW() > 50) this.barW =Math.max(0.3, Math.min(60, this.plotW() / zoomBars));
    this.right = i + this.plotW() / this.barW / 2;
    this.autoY = true;
    this.request();
  }

  goToEnd() { this.right = this.last() + 5; this.autoY = true; this.request(); }

  // ---------- Maße ----------
  resize() {
    const p = this.cv.parentElement, dpr = window.devicePixelRatio || 1;
    this.W = p.clientWidth; this.H = p.clientHeight;
    this.cv.width = Math.max(1, this.W * dpr); this.cv.height = Math.max(1, this.H * dpr);
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.request();
  }

  plotW() { return this.W - this.axisW; }
  hasSub() { return this.ov.plots.some(p => p.pane === 'sub'); }
  layout() {
    const total = this.H - this.timeH;
    const sub = this.hasSub() ? Math.round(total * 0.24) : 0;
    return { mainTop: 0, mainH: total - sub, subTop: total - sub, subH: sub };
  }
  x(i) { return this.plotW() - (this.right - i + 0.5) * this.barW; }
  idxAtX(px) { return Math.round(this.right - (this.plotW() - px) / this.barW - 0.5); }
  visible() {
    const i0 = Math.max(0, Math.floor(this.right - this.plotW() / this.barW) - 1);
    const i1 = Math.min(this.last(), Math.ceil(this.right) + 1);
    return [i0, i1];
  }
  // Zeit <-> (gebrochener) Kerzenindex, auch vor/hinter den Daten (für Zeichnungen)
  fracIndex(t) {
    const b = this.bars, n = b.n, ms = b.tf * 60000;
    if (t <= b.t[0]) return (t - b.t[0]) / ms;
    if (t >= b.t[n - 1]) return n - 1 + (t - b.t[n - 1]) / ms;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b.t[m] <= t) lo = m; else hi = m - 1; }
    return lo + Math.min(0.999, (t - b.t[lo]) / ms);
  }
  timeAt(f) {
    const b = this.bars, n = b.n, ms = b.tf * 60000, k = Math.floor(f);
    if (k < 0) return b.t[0] + f * ms;
    if (k >= n - 1) return b.t[n - 1] + (f - (n - 1)) * ms;
    return b.t[k] + (f - k) * ms;
  }
  xToIndexF(px) { return this.right - (this.plotW() - px) / this.barW - 0.5; }
  timeToX(t) { return this.x(this.fracIndex(t)); }
  y(p) { const L = this.L; return L.mainTop + (this.yMax - p) / (this.yMax - this.yMin) * L.mainH; }
  priceAtY(py) { const L = this.L; return this.yMax - (py - L.mainTop) / L.mainH * (this.yMax - this.yMin); }

  request() {
    if (this.dirty) return;
    this.dirty = true;
    requestAnimationFrame(() => { this.dirty = false; this.render(); });
  }

  // ---------- Maus & Touch ----------
  // Maus: ziehen = verschieben, Rad = zoomen. Touch: 1 Finger verschieben, 2 Finger zoomen,
  // lange drücken = Fadenkreuz. Doppelklick/-tipp auf die Preisachse = automatische Skalierung.
  bindEvents() {
    const cv = this.cv, fingers = new Map();
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    let lastTap = null;

    cv.addEventListener('pointerdown', e => {
      try { cv.setPointerCapture(e.pointerId); } catch { /* z. B. synthetische Events */ }
      const { x: mx, y: my } = pos(e);
      fingers.set(e.pointerId, { x: mx, y: my });
      this.touch = e.pointerType === 'touch' || e.pointerType === 'pen';
      clearTimeout(this.pressTimer);

      // zweiter Finger: Zoomen mit zwei Fingern (laufende Zeichen-Aktion abbrechen)
      if (fingers.size === 2) {
        if (this.drag && this.drag.mode === 'ext' && this.interact && this.interact.cancelGesture) this.interact.cancelGesture();
        const [a, b] = [...fingers.values()], mid = Math.min((a.x + b.x) / 2, this.plotW());
        this.drag = { mode: 'pinch', dist: Math.max(40, Math.abs(a.x - b.x)), barW: this.barW, im: this.xToIndexF(mid) };
        this.mouse = null; this.crossLock = false;
        return;
      }
      if (fingers.size > 2 || e.button !== 0) return;

      // Doppelklick / Doppeltipp
      const now = Date.now();
      const dbl = lastTap && now - lastTap.t < 320 && Math.hypot(lastTap.x - mx, lastTap.y - my) < 24;
      lastTap = dbl ? null : { t: now, x: mx, y: my };
      if (dbl && mx > this.plotW()) { this.autoY = true; this.request(); return; }
      if (dbl && this.interact) { this.interact.dblclick(mx, my); this.request(); }

      if (this.crossLock) { this.crossLock = false; this.mouse = null; this.request(); }

      // Zeichenwerkzeuge (falls vorhanden) bekommen den Klick zuerst
      if (this.interact && mx <= this.plotW() && my < (this.L || this.layout()).mainH && !e.shiftKey && this.interact.down(mx, my, e)) {
        this.drag = { mode: 'ext' };
        if (this.touch) this.mouse = { x: mx, y: my };
        this.request();
        return;
      }
      if (mx > this.plotW()) {
        if (this.autoY) this.autoY = false;
        this.drag = { mode: 'axis', y: my, min: this.yMin, max: this.yMax };
      } else if (e.shiftKey) {
        this.measure = { i0: this.idxAtX(mx), p0: this.priceAtY(my), i1: this.idxAtX(mx), p1: this.priceAtY(my) };
        this.drag = { mode: 'measure' };
      } else {
        const d = this.drag = { mode: 'pan', x: mx, y: my, right: this.right, min: this.yMin, max: this.yMax, moved: false };
        if (this.touch) {
          // lange drücken ohne zu bewegen = Fadenkreuz mit Kurswerten
          this.pressTimer = setTimeout(() => {
            if (this.drag === d && !d.moved) { this.drag = { mode: 'cross' }; this.mouse = { x: mx, y: my }; this.crossLock = true; this.request(); }
          }, 450);
        }
      }
    });

    cv.addEventListener('pointermove', e => {
      const { x: mx, y: my } = pos(e);
      if (fingers.has(e.pointerId)) fingers.set(e.pointerId, { x: mx, y: my });
      const d = this.drag;
      if (d && d.mode === 'pinch') {
        if (fingers.size < 2) return;
        const [a, b] = [...fingers.values()], mid = Math.min((a.x + b.x) / 2, this.plotW());
        this.barW = Math.max(0.3, Math.min(60, d.barW * Math.max(40, Math.abs(a.x - b.x)) / d.dist));
        this.right = d.im + 0.5 + (this.plotW() - mid) / this.barW;
        this.clampRight();
        if (this.onViewChange) this.onViewChange();
        this.request();
        return;
      }
      if (!this.touch || (d && (d.mode === 'cross' || d.mode === 'ext'))) this.mouse = { x: mx, y: my };
      if (this.interact) {
        this.interact.move(mx, my, e, !!(d && d.mode === 'ext'));
        if (!d && !this.touch) cv.style.cursor = this.interact.cursor(mx, my);
      }
      if (d && d.mode === 'pan') {
        if (Math.abs(mx - d.x) + Math.abs(my - d.y) > (this.touch ? 8 : 3)) { d.moved = true; clearTimeout(this.pressTimer); }
        if (!d.moved) return;
        this.right = d.right - (mx - d.x) / this.barW;
        this.clampRight();
        if (!this.autoY) {
          const dp = (my - d.y) / this.L.mainH * (d.max - d.min);
          this.yMin = d.min + dp; this.yMax = d.max + dp;
        }
        if (this.onViewChange) this.onViewChange();
      } else if (d && d.mode === 'axis') {
        const f = Math.exp((my - d.y) * 0.006), mid = (d.min + d.max) / 2, half = (d.max - d.min) / 2 * f;
        this.yMin = mid - half; this.yMax = mid + half;
      } else if (d && d.mode === 'measure') {
        this.measure.i1 = this.idxAtX(mx); this.measure.p1 = this.priceAtY(my);
      }
      this.request();
    });

    const end = e => {
      fingers.delete(e.pointerId);
      clearTimeout(this.pressTimer);
      const d = this.drag;
      if (d && d.mode === 'pinch') { if (!fingers.size) this.drag = null; return; }
      this.drag = null;
      if (e.type === 'pointercancel') {
        if (d && d.mode === 'ext' && this.interact.cancelGesture) this.interact.cancelGesture();
        this.request();
        return;
      }
      const { x: mx, y: my } = pos(e);
      if (d && d.mode === 'cross') return;
      if (d && d.mode === 'ext') { this.interact.up(mx, my, e); if (this.touch) this.mouse = null; this.request(); return; }
      if (d && d.mode === 'pan' && !d.moved && this.onClick && mx < this.plotW())
        this.onClick(this.idxAtX(mx), this.priceAtY(my), e);
      if (d && d.mode === 'measure') setTimeout(() => { if (!this.drag) { this.measure = null; this.request(); } }, 4000);
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.crossLock && !this.drag) { this.mouse = null; this.request(); } });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const r = cv.getBoundingClientRect(), mx = Math.min(e.clientX - r.left, this.plotW());
      if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.right += (e.deltaX || e.deltaY) / this.barW * 0.6;
      } else {
        const im = this.right - (this.plotW() - mx) / this.barW;
        const f = e.deltaY > 0 ? 1 / 1.15 : 1.15;
        this.barW = Math.max(0.3, Math.min(60, this.barW * f));
        this.right = im + (this.plotW() - mx) / this.barW;
      }
      this.clampRight();
      if (this.onViewChange) this.onViewChange();
      this.request();
    }, { passive: false });
  }

  // Zoom-Knöpfe (z. B. auf dem iPad)
  zoom(f) {
    const im = this.right - this.plotW() / this.barW / 2;
    this.barW = Math.max(0.3, Math.min(60, this.barW * f));
    this.right = im + this.plotW() / this.barW / 2;
    this.clampRight();
    this.request();
  }

  clampRight() {
    if (!this.bars) return;
    const vis = this.plotW() / this.barW;
    this.right = Math.max(Math.min(10, vis * 0.5), Math.min(this.last() + vis * 0.7, this.right));
  }

  // ---------- Zeichnen ----------
  render() {
    const c = this.ctx, W = this.W, H = this.H;
    c.fillStyle = this.th.bg; c.fillRect(0, 0, W, H);
    if (!this.bars || !this.bars.n) {
      c.fillStyle = this.th.text; c.font = '14px system-ui'; c.fillText('Keine Daten geladen', 20, 30);
      return;
    }
    this.L = this.layout();
    const [i0, i1] = this.visible();
    if (this.autoY) this.autoScale(i0, i1);
    const L = this.L, pw = this.plotW();

    c.save();
    c.beginPath(); c.rect(0, 0, pw, L.mainH); c.clip();
    this.drawBg(i0, i1);
    this.drawGrid(i0, i1);
    this.drawBoxes(i0, i1);
    this.drawTradeZones(i0, i1);
    this.drawCandles(i0, i1);
    for (const p of this.ov.plots) if (p.pane === 'main') this.drawPlot(p, i0, i1, v => this.y(v));
    for (const h of this.ov.hlines) if (h.pane === 'main') this.hLine(this.y(h.value), h.color, [4, 4]);
    this.drawTrades(i0, i1);
    this.drawMarkers(i0, i1);
    this.drawLive();
    if (this.interact) this.interact.draw(c);
    this.drawMeasure();
    c.restore();

    if (L.subH) this.drawSub(i0, i1);
    this.drawPriceAxis();
    this.drawTimeAxis(i0, i1);
    this.drawCrosshair();
    this.drawLegend();
  }

  autoScale(i0, i1) {
    const b = this.bars;
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (b.l[i] < lo) lo = b.l[i]; if (b.h[i] > hi) hi = b.h[i]; }
    for (const p of this.ov.plots) {
      if (p.pane !== 'main') continue;
      for (let i = i0; i <= i1; i++) {
        const v = p.data[i];
        if (v === v && v > lo - (hi - lo) * 0.5 && v < hi + (hi - lo) * 0.5) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < this.pip) { hi += this.pip; lo -= this.pip; }
    const pad = (hi - lo) * 0.08;
    this.yMin = lo - pad; this.yMax = hi + pad;
  }

  drawBg(i0, i1) {
    const bg = this.ov.bg;
    if (!bg) return;
    // gleiche Farben am Stück zeichnen, sonst entstehen beim Herauszoomen Streifen
    const c = this.ctx, bw = this.barW, h = this.H - this.timeH;
    let start = i0;
    for (let i = i0; i <= i1 + 1; i++) {
      if (i <= i1 && bg[i] === bg[start]) continue;
      if (bg[start]) {
        const x1 = Math.round(this.x(start) - bw / 2), x2 = Math.round(this.x(i - 1) + bw / 2);
        c.fillStyle = bg[start];
        c.fillRect(x1, 0, Math.max(1, x2 - x1), h);
      }
      start = i;
    }
  }

  niceStep(range, target) {
    const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
    return 10 * p;
  }

  drawGrid(i0, i1) {
    const c = this.ctx, L = this.L, pw = this.plotW();
    if (!this.th.gridOn) return;
    c.strokeStyle = this.th.grid; c.lineWidth = 1;
    const step = this.niceStep(this.yMax - this.yMin, Math.max(2, L.mainH / 55));
    c.beginPath();
    for (let v = Math.ceil(this.yMin / step) * step; v < this.yMax; v += step) {
      const y = Math.round(this.y(v)) + 0.5; c.moveTo(0, y); c.lineTo(pw, y);
    }
    for (const tk of this.timeTicks(i0, i1)) { const x = Math.round(this.x(tk.i)) + 0.5; c.moveTo(x, 0); c.lineTo(x, this.H); }
    c.stroke();
  }

  timeTicks(i0, i1) {
    const b = this.bars, tf = b.tf, cand = [1, 5, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 10080, 43200, 129600, 525600];
    const minutesPerPx = tf / this.barW;
    const step = cand.find(m => m / minutesPerPx >= 95) || 525600;
    const ticks = [], off = this.offsetMs;
    let prev = null;
    for (let i = Math.max(1, i0); i <= i1; i++) {
      const t = b.t[i] - off;
      let key;
      if (step >= 43200) { const d = new Date(t); key = d.getUTCFullYear() * 12 + d.getUTCMonth(); key = Math.floor(key / (step / 43200)); }
      else if (step === 10080) key = Math.floor((t / 86400000 + 3) / 7);
      else key = Math.floor(t / (step * 60000));
      if (prev !== null && key !== prev) ticks.push({ i, step });
      prev = key;
    }
    return ticks;
  }

  drawCandles(i0, i1) {
    const c = this.ctx, b = this.bars, bw = this.barW;
    const body = Math.max(1, Math.floor(bw * 0.7));
    for (const up of [true, false]) {
      c.strokeStyle = bw >= 3 ? (up ? this.th.wickUp : this.th.wickDown) : (up ? this.th.up : this.th.down);
      c.fillStyle = up ? this.th.up : this.th.down;
      c.beginPath();
      for (let i = i0; i <= i1; i++) {
        if ((b.c[i] >= b.o[i]) !== up) continue;
        const x = Math.round(this.x(i)) + 0.5;
        c.moveTo(x, this.y(b.h[i])); c.lineTo(x, this.y(b.l[i]));
      }
      c.lineWidth = 1; c.stroke();
      if (bw >= 3) {
        for (let i = i0; i <= i1; i++) {
          if ((b.c[i] >= b.o[i]) !== up) continue;
          const x = Math.round(this.x(i) - body / 2);
          const y1 = this.y(Math.max(b.o[i], b.c[i])), y2 = this.y(Math.min(b.o[i], b.c[i]));
          c.fillRect(x, Math.round(y1), body, Math.max(1, Math.round(y2 - y1)));
        }
      }
    }
  }

  drawPlot(p, i0, i1, Y) {
    const c = this.ctx, d = p.data;
    c.strokeStyle = c.fillStyle = p.color; c.lineWidth = p.width;
    if (p.style === 'dots') {
      const r = Math.max(1, Math.min(2.5, this.barW / 4));
      for (let i = i0; i <= i1; i++) {
        const v = d[i]; if (v !== v) continue;
        c.beginPath(); c.arc(this.x(i), Y(v), r, 0, 6.283); c.fill();
      }
      return;
    }
    if (p.style === 'hist') {
      const z = Y(0), w = Math.max(1, this.barW * 0.6);
      for (let i = i0; i <= i1; i++) {
        const v = d[i]; if (v !== v) continue;
        c.fillStyle = v >= 0 ? p.color : (p.color2 || '#ef4444');
        const y = Y(v); c.fillRect(this.x(i) - w / 2, Math.min(y, z), w, Math.abs(y - z) || 1);
      }
      return;
    }
    c.beginPath();
    let pen = false;
    for (let i = i0; i <= i1; i++) {
      const v = d[i];
      if (v !== v) { pen = false; continue; }
      const x = this.x(i), y = Y(v);
      if (!pen) { c.moveTo(p.style === 'step' ? x - this.barW / 2 : x, y); pen = true; }
      else if (p.style === 'step') { c.lineTo(x - this.barW / 2, Y(d[i - 1])); c.lineTo(x - this.barW / 2, y); }
      else c.lineTo(x, y);
      if (p.style === 'step') c.lineTo(x + this.barW / 2, y);
    }
    c.stroke();
  }

  hLine(y, color, dash, x0 = 0, x1 = this.plotW()) {
    const c = this.ctx;
    c.save(); c.strokeStyle = color; c.lineWidth = 1; c.setLineDash(dash || []);
    c.beginPath(); c.moveTo(x0, Math.round(y) + 0.5); c.lineTo(x1, Math.round(y) + 0.5); c.stroke();
    c.restore();
  }

  drawBoxes(i0, i1) {
    const c = this.ctx;
    for (const b of this.ov.boxes) {
      if (b.i2 < i0 || b.i1 > i1 || b.i1 > this.last()) continue;
      const x1 = this.x(b.i1) - this.barW / 2, x2 = this.x(Math.min(b.i2, this.last())) + this.barW / 2;
      const y1 = this.y(b.top), y2 = this.y(b.bottom);
      c.fillStyle = b.color; c.fillRect(x1, y1, x2 - x1, y2 - y1);
      if (b.text) { c.fillStyle = this.th.text; c.font = '11px system-ui'; c.fillText(b.text, x1 + 3, y1 - 4); }
    }
  }

  visibleTrades(i0, i1) {
    const last = this.last();
    return this.ov.trades.filter(t => t.exitIdx >= i0 && t.entryIdx <= i1 && t.exitIdx <= last);
  }

  drawTradeZones(i0, i1) {
    if (this.barW < 1.2) return;
    const c = this.ctx;
    for (const t of this.visibleTrades(i0, i1)) {
      const x1 = this.x(t.entryIdx) - this.barW / 2, x2 = this.x(t.exitIdx) + this.barW / 2, ye = this.y(t.entry);
      if (t.tp0 != null) { c.fillStyle = this.th.tpZone; const y = this.y(t.tp0); c.fillRect(x1, Math.min(y, ye), x2 - x1, Math.abs(y - ye)); }
      if (t.sl0 != null) { c.fillStyle = this.th.slZone; const y = this.y(t.sl0); c.fillRect(x1, Math.min(y, ye), x2 - x1, Math.abs(y - ye)); }
    }
  }

  drawTrades(i0, i1) {
    const c = this.ctx;
    const show = this.barW >= 4;
    for (const t of this.visibleTrades(i0, i1)) {
      const xa = this.x(t.entryIdx), xb = this.x(t.exitIdx), ya = this.y(t.entry), yb = this.y(t.exit);
      const col = t.pnl >= 0 ? this.th.win : this.th.loss;
      c.save(); c.strokeStyle = col; c.lineWidth = 1.2; c.setLineDash([5, 3]);
      c.beginPath(); c.moveTo(xa, ya); c.lineTo(xb, yb); c.stroke(); c.restore();
      this.triangle(xa, t.dir > 0 ? this.y(this.bars.l[t.entryIdx]) + 12 : this.y(this.bars.h[t.entryIdx]) - 12, t.dir > 0, t.dir > 0 ? this.th.up : this.th.down);
      c.fillStyle = col; c.beginPath(); c.arc(xb, yb, 3, 0, 6.283); c.fill();
      if (show) {
        c.font = '10px system-ui'; c.fillStyle = col;
        const txt = (t.pips >= 0 ? '+' : '') + t.pips.toFixed(1) + ' P';
        c.fillText(txt, xb + 5, yb + (t.dir > 0 === t.pnl >= 0 ? -5 : 12));
      }
    }
  }

  triangle(x, y, up, color) {
    const c = this.ctx, s = Math.max(4, Math.min(7, this.barW * 0.6));
    c.fillStyle = color; c.beginPath();
    if (up) { c.moveTo(x, y - s); c.lineTo(x - s, y + s * 0.6); c.lineTo(x + s, y + s * 0.6); }
    else { c.moveTo(x, y + s); c.lineTo(x - s, y - s * 0.6); c.lineTo(x + s, y - s * 0.6); }
    c.closePath(); c.fill();
  }

  drawMarkers(i0, i1) {
    const c = this.ctx, b = this.bars, last = this.last();
    c.font = '10px system-ui'; c.textAlign = 'center';
    for (const m of this.ov.markers) {
      if (m.i < i0 || m.i > i1 || m.i > last) continue;
      const above = m.pos !== 'below', x = this.x(m.i);
      const y = above ? this.y(b.h[m.i]) - 8 : this.y(b.l[m.i]) + 8;
      c.fillStyle = m.color; c.beginPath(); c.arc(x, y, 2.5, 0, 6.283); c.fill();
      if (m.text && this.barW >= 3) c.fillText(m.text, x, above ? y - 6 : y + 13);
    }
    c.textAlign = 'left';
  }

  // offene Position und Pending-Orders (Replay / Ende des Backtests)
  drawLive() {
    const c = this.ctx, pw = this.plotW(), p = this.ov.pos;
    const tag = (y, text, color) => {
      c.font = '11px system-ui'; const w = c.measureText(text).width + 8;
      c.fillStyle = color; c.fillRect(pw - w - 4, y - 8, w, 16);
      c.fillStyle = '#0d1117'; c.fillText(text, pw - w, y + 4);
    };
    if (p) {
      const x0 = Math.max(0, this.x(p.entryIdx));
      this.hLine(this.y(p.entry), '#94a3b8', [], x0);
      tag(this.y(p.entry), (p.dir > 0 ? 'Long ' : 'Short ') + p.lots + ' @ ' + p.entry.toFixed(this.digits), '#94a3b8');
      if (p.sl != null) { this.hLine(this.y(p.sl), this.th.loss, [6, 3], x0); tag(this.y(p.sl), 'SL ' + p.sl.toFixed(this.digits), this.th.loss); }
      if (p.tp != null) { this.hLine(this.y(p.tp), this.th.win, [6, 3], x0); tag(this.y(p.tp), 'TP ' + p.tp.toFixed(this.digits), this.th.win); }
    }
    for (const o of this.ov.orders || []) {
      const col = o.dir > 0 ? '#38bdf8' : '#f472b6';
      this.hLine(this.y(o.price), col, [2, 3]);
      tag(this.y(o.price), o.label + ' ' + o.price.toFixed(this.digits), col);
    }
  }

  drawMeasure() {
    const m = this.measure;
    if (!m) return;
    const c = this.ctx, x1 = this.x(m.i0), x2 = this.x(m.i1), y1 = this.y(m.p0), y2 = this.y(m.p1);
    c.fillStyle = this.th.measure; c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    const d = m.p1 - m.p0, bars = m.i1 - m.i0;
    const mins = Math.abs(bars) * this.bars.tf;
    const txt = `${d >= 0 ? '+' : ''}${d.toFixed(this.digits)}  (${(d / this.pip).toFixed(1)} Pips, ${(d / m.p0 * 100).toFixed(2)} %)  ·  ${bars} Kerzen  ·  ${Math.floor(mins / 60)}h ${mins % 60}m`;
    c.font = '12px system-ui';
    const w = c.measureText(txt).width + 12, bx = Math.min(x1, x2), by = Math.max(y1, y2) + 6;
    c.fillStyle = '#1e3a5f'; c.fillRect(bx, by, w, 20);
    c.fillStyle = '#e2e8f0'; c.fillText(txt, bx + 6, by + 14);
  }

  drawSub(i0, i1) {
    const c = this.ctx, L = this.L, pw = this.plotW();
    const plots = this.ov.plots.filter(p => p.pane === 'sub');
    const hl = this.ov.hlines.filter(h => h.pane === 'sub');
    let lo = Infinity, hi = -Infinity;
    for (const p of plots) for (let i = i0; i <= i1; i++) { const v = p.data[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    for (const h of hl) { lo = Math.min(lo, h.value); hi = Math.max(hi, h.value); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi === lo) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.1; lo -= pad; hi += pad;
    const top = L.subTop + 4, h = L.subH - 8;
    const Y = v => top + (hi - v) / (hi - lo) * h;
    this.subY = { lo, hi, top, h };
    c.fillStyle = this.th.bg; c.fillRect(0, L.subTop, this.W, L.subH);
    c.strokeStyle = this.th.border; c.beginPath(); c.moveTo(0, L.subTop + 0.5); c.lineTo(this.W, L.subTop + 0.5); c.stroke();
    c.save(); c.beginPath(); c.rect(0, L.subTop, pw, L.subH); c.clip();
    for (const hh of hl) this.hLine(Y(hh.value), hh.color, [4, 4]);
    for (const p of plots) this.drawPlot(p, i0, i1, Y);
    c.restore();
    c.fillStyle = this.th.text; c.font = '11px system-ui';
    const step = this.niceStep(hi - lo, Math.max(2, h / 40));
    for (let v = Math.ceil(lo / step) * step; v < hi; v += step) c.fillText(this.fmtNum(v, step), pw + 6, Y(v) + 4);
  }

  fmtNum(v, step) { const d = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step))); return v.toFixed(d); }

  drawPriceAxis() {
    const c = this.ctx, L = this.L, pw = this.plotW();
    c.fillStyle = this.th.axisBg; c.fillRect(pw, 0, this.axisW, L.mainH);
    c.strokeStyle = this.th.border; c.beginPath(); c.moveTo(pw + 0.5, 0); c.lineTo(pw + 0.5, this.H); c.stroke();
    c.fillStyle = this.th.text; c.font = '11px system-ui';
    const step = this.niceStep(this.yMax - this.yMin, Math.max(2, L.mainH / 55));
    for (let v = Math.ceil(this.yMin / step) * step; v < this.yMax; v += step) {
      const y = this.y(v); if (y < 8 || y > L.mainH - 4) continue;
      c.fillText(v.toFixed(this.digits), pw + 6, y + 4);
    }
    // letzter Kurs
    const li = this.last(), b = this.bars, v = b.c[li], y = this.y(v);
    if (y > 0 && y < L.mainH) {
      const col = b.c[li] >= b.o[li] ? this.th.up : this.th.down;
      this.hLine(y, col, [1, 3], 0, pw);
      c.fillStyle = col; c.fillRect(pw, y - 9, this.axisW, 18);
      c.fillStyle = '#fff'; c.fillText(v.toFixed(this.digits), pw + 6, y + 4);
    }
  }

  drawTimeAxis(i0, i1) {
    const c = this.ctx, top = this.H - this.timeH, pw = this.plotW();
    c.fillStyle = this.th.axisBg; c.fillRect(0, top, this.W, this.timeH);
    c.strokeStyle = this.th.border; c.beginPath(); c.moveTo(0, top + 0.5); c.lineTo(this.W, top + 0.5); c.stroke();
    c.fillStyle = this.th.text; c.font = '11px system-ui'; c.textAlign = 'center';
    for (const tk of this.timeTicks(i0, i1)) {
      const x = this.x(tk.i); if (x < 20 || x > pw - 20) continue;
      c.fillText(this.fmtTick(this.bars.t[tk.i] - this.offsetMs, tk.step), x, top + 16);
    }
    c.textAlign = 'left';
  }

  fmtTick(t, step) {
    const d = new Date(t), p = v => String(v).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    if (step >= 43200) return d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : months[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(2);
    if (step >= 1440) return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.`;
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.`;
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  hoverIndex() {
    if (!this.mouse || this.mouse.x > this.plotW()) return this.last();
    return Math.max(0, Math.min(this.last(), this.idxAtX(this.mouse.x)));
  }

  drawCrosshair() {
    const m = this.mouse;
    if (!m || this.drag && this.drag.mode !== 'measure') return;
    const c = this.ctx, pw = this.plotW(), L = this.L;
    if (m.x > pw || m.y > this.H - this.timeH) return;
    const i = this.idxAtX(m.x), x = Math.round(this.x(i)) + 0.5;
    c.save(); c.strokeStyle = this.th.cross; c.setLineDash([4, 4]); c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, this.H - this.timeH); c.moveTo(0, Math.round(m.y) + 0.5); c.lineTo(pw, Math.round(m.y) + 0.5); c.stroke();
    c.restore();
    c.font = '11px system-ui';
    let label;
    if (m.y < L.mainH) label = this.priceAtY(m.y).toFixed(this.digits);
    else if (this.subY) { const s = this.subY; label = (s.hi - (m.y - s.top) / s.h * (s.hi - s.lo)).toFixed(2); }
    if (label) { c.fillStyle = '#334155'; c.fillRect(pw, m.y - 9, this.axisW, 18); c.fillStyle = '#fff'; c.fillText(label, pw + 6, m.y + 4); }
    if (i >= 0 && i < this.bars.n) {
      const txt = fmtDate(this.bars.t[i] - this.offsetMs, true), w = c.measureText(txt).width + 12;
      c.fillStyle = '#334155'; c.fillRect(x - w / 2, this.H - this.timeH + 1, w, this.timeH - 2);
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.fillText(txt, x, this.H - this.timeH + 16); c.textAlign = 'left';
    }
  }

  drawLegend() {
    const c = this.ctx, b = this.bars, i = this.hoverIndex(), d = this.digits;
    c.font = '12px system-ui';
    let x = 10, y = 18;
    const put = (txt, col) => { c.fillStyle = col; c.fillText(txt, x, y); x += c.measureText(txt).width + 10; };
    put(this.title, this.th.textStrong);
    const col = b.c[i] >= b.o[i] ? this.th.up : this.th.down;
    put(`O ${b.o[i].toFixed(d)}  H ${b.h[i].toFixed(d)}  L ${b.l[i].toFixed(d)}  C ${b.c[i].toFixed(d)}`, col);
    put(`${((b.h[i] - b.l[i]) / this.pip).toFixed(1)} Pips`, this.th.text);
    x = 10; y = 36;
    for (const p of this.ov.plots) {
      if (p.pane !== 'main') continue;
      const v = p.data[i];
      put(`${p.name} ${v === v ? v.toFixed(d) : '–'}`, p.color);
      if (x > this.plotW() - 150) { x = 10; y += 16; }
    }
    const t = this.ov.trades.find(t => i >= t.entryIdx && i <= t.exitIdx && t.exitIdx <= this.last());
    if (t) {
      x = 10; y += 18;
      put(`Trade #${t.id} ${t.dir > 0 ? 'Long' : 'Short'} ${t.lots} Lot · ${t.pips >= 0 ? '+' : ''}${t.pips.toFixed(1)} Pips · ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)} $ · ${t.reason}${t.comment ? ' · ' + t.comment : ''}`, t.pnl >= 0 ? this.th.win : this.th.loss);
    }
    if (this.L.subH) {
      x = 10; y = this.L.subTop + 16;
      for (const p of this.ov.plots) {
        if (p.pane !== 'sub') continue;
        const v = p.data[i];
        put(`${p.name} ${v === v ? v.toFixed(2) : '–'}`, p.color);
      }
    }
  }
}

// kleine Linien-Grafik (Kontokurve)
function drawLineChart(canvas, values, opts = {}) {
  const dpr = window.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = COLORS.bg; c.fillRect(0, 0, W, H);
  if (values.length < 2) { c.fillStyle = COLORS.text; c.font = '12px system-ui'; c.fillText('Noch keine Trades', 10, 20); return; }
  let lo = Math.min(...values), hi = Math.max(...values);
  if (opts.base != null) { lo = Math.min(lo, opts.base); hi = Math.max(hi, opts.base); }
  if (hi === lo) hi = lo + 1;
  const padL = 6, padR = 56, padT = 8, padB = 8;
  const X = i => padL + i / (values.length - 1) * (W - padL - padR);
  const Y = v => padT + (hi - v) / (hi - lo) * (H - padT - padB);
  if (opts.base != null) {
    c.strokeStyle = '#334155'; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(padL, Y(opts.base)); c.lineTo(W - padR, Y(opts.base)); c.stroke(); c.setLineDash([]);
  }
  const last = values[values.length - 1], col = opts.base == null || last >= opts.base ? '#22c55e' : '#ef4444';
  const g = c.createLinearGradient(0, padT, 0, H);
  g.addColorStop(0, col + '40'); g.addColorStop(1, col + '00');
  c.beginPath(); c.moveTo(X(0), Y(values[0]));
  for (let i = 1; i < values.length; i++) c.lineTo(X(i), Y(values[i]));
  c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
  c.lineTo(X(values.length - 1), H); c.lineTo(X(0), H); c.closePath(); c.fillStyle = g; c.fill();
  c.fillStyle = COLORS.text; c.font = '11px system-ui';
  c.fillText(hi.toFixed(0), W - padR + 6, padT + 8); c.fillText(lo.toFixed(0), W - padR + 6, H - padB);
  c.fillStyle = col; c.fillText(last.toFixed(0), W - padR + 6, Y(last) + 4);
}
