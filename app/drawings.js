'use strict';
// Zeichenwerkzeuge wie bei TradingView. Punkte werden als {t: Zeit, p: Preis} gespeichert,
// damit Zeichnungen beim Wechsel des Zeitrahmens an der richtigen Stelle bleiben.

const DRAW_TOOLS = {
  trend:   { n: 2, name: 'Trendlinie', key: 'T' },
  ray:     { n: 2, name: 'Strahl' },
  ext:     { n: 2, name: 'Erweiterte Linie' },
  hline:   { n: 1, name: 'Horizontale Linie', key: 'H' },
  hray:    { n: 1, name: 'Horizontaler Strahl', key: 'J' },
  vline:   { n: 1, name: 'Vertikale Linie', key: 'V' },
  channel: { n: 3, name: 'Paralleler Kanal', key: 'C' },
  rect:    { n: 2, name: 'Rechteck', key: 'R' },
  fib:     { n: 2, name: 'Fibonacci-Retracement', key: 'F' },
  long:    { n: 1, name: 'Long-Position', key: 'L' },
  short:   { n: 1, name: 'Short-Position', key: 'S' },
  text:    { n: 1, name: 'Text', key: 'X' },
  brush:   { n: 0, name: 'Pinsel', key: 'B' },
  measure: { n: 0, name: 'Messen', key: 'M' },
};

const DRAW_COLORS = ['#2962ff', '#f23645', '#22ab94', '#ff9800', '#e040fb', '#ffeb3b', '#ffffff', '#787b86'];
const FIB_LEVELS = [
  { v: 0, c: '#787b86' }, { v: 0.236, c: '#f23645' }, { v: 0.382, c: '#ff9800' }, { v: 0.5, c: '#4caf50' },
  { v: 0.618, c: '#089981' }, { v: 0.786, c: '#00bcd4' }, { v: 1, c: '#787b86' }, { v: 1.618, c: '#2962ff' },
];

class DrawingTools {
  constructor(chart) {
    this.chart = chart;
    chart.interact = this;
    this.items = [];
    this.tool = 'cursor';
    this.sel = null;
    this.pending = null;
    this.drag = null;
    this.hover = null;
    this.magnet = false;
    this.hidden = false;
    this.keepTool = false;
    this.undoStack = [];
    this.nextId = 1;
    this.lastStyle = { color: DRAW_COLORS[0], width: 2, style: 'solid' };
    this.onChange = null;      // Zeichnungen geändert -> speichern
    this.onSelect = null;      // Auswahl geändert -> Eigenschaften-Leiste
    this.onToolChange = null;  // Werkzeug gewechselt -> Knöpfe
  }

  // ---------- Verwaltung ----------
  load(items) {
    this.items = (items || []).map(d => ({ ...d, pts: d.pts.map(p => ({ ...p })) }));
    this.nextId = this.items.reduce((m, d) => Math.max(m, d.id + 1), 1);
    this.sel = null; this.pending = null; this.undoStack = [];
    this.changed(false);
  }
  setTool(t) {
    if (this.pending) this.cancelPending();
    this.tool = t;
    if (t !== 'cursor') this.select(null);
    if (this.onToolChange) this.onToolChange(t);
    this.chart.request();
  }
  select(d) { this.sel = d; if (this.onSelect) this.onSelect(d); this.chart.request(); }
  snapshot() {
    this.undoStack.push(JSON.stringify(this.items));
    if (this.undoStack.length > 60) this.undoStack.shift();
  }
  undo() {
    if (!this.undoStack.length) return;
    this.items = JSON.parse(this.undoStack.pop());
    this.select(null);
    this.changed(false);
  }
  changed(save = true) { if (save && this.onChange) this.onChange(this.items); this.chart.request(); }
  remove(d) {
    if (!d) return;
    this.snapshot();
    this.items = this.items.filter(x => x !== d);
    if (this.sel === d) this.select(null);
    this.changed();
  }
  clear() { if (!this.items.length) return; this.snapshot(); this.items = []; this.select(null); this.changed(); }
  setProp(k, v) {
    if (!this.sel) return;
    this.snapshot();
    this.sel[k] = v;
    if (k !== 'text') this.lastStyle[k] = v;
    this.changed();
  }
  grip() { return this.chart.touch ? 20 : 8; }

  // zweiter Finger auf dem iPad: angefangene Aktion verwerfen
  cancelGesture() {
    if (this.pending) { this.cancelPending(); this.undoStack.pop(); this.downAt = null; }
    else if (this.drag && this.drag.kind !== 'measure') { if (this.drag.moved) this.undo(); else this.undoStack.pop(); }
    this.drag = null;
  }

  cancelPending() {
    if (!this.pending) return;
    this.items = this.items.filter(x => x !== this.pending);
    this.pending = null;
    this.chart.request();
  }

  // ---------- Umrechnung ----------
  P(pt) { return { x: this.chart.timeToX(pt.t), y: this.chart.y(pt.p) }; }

  // Mausposition -> Punkt. Zeit rastet immer auf eine Kerze ein, Preis mit Magnet auf O/H/L/C
  toPoint(mx, my) {
    const ch = this.chart, b = ch.bars;
    const k = Math.round(ch.xToIndexF(mx));
    let p = ch.priceAtY(my);
    if (this.magnet && k >= 0 && k <= ch.last()) {
      let best = p, bd = Infinity;
      for (const v of [b.o[k], b.h[k], b.l[k], b.c[k]]) { const d = Math.abs(ch.y(v) - my); if (d < bd) { bd = d; best = v; } }
      if (bd < 40) p = best;
    }
    return { t: ch.timeAt(k), p };
  }

  // ---------- Maus ----------
  down(mx, my, e) {
    const ch = this.chart;
    if (this.tool === 'measure') {
      ch.measure = { i0: ch.idxAtX(mx), p0: ch.priceAtY(my), i1: ch.idxAtX(mx), p1: ch.priceAtY(my) };
      this.drag = { kind: 'measure' };
      return true;
    }
    if (this.tool !== 'cursor') {
      const pt = this.toPoint(mx, my);
      if (this.pending) {
        const d = this.pending;
        d.pts[d.pts.length - 1] = pt;
        if (d.pts.length < DRAW_TOOLS[d.type].n) d.pts.push({ ...pt });
        else this.finish();
        return true;
      }
      this.snapshot();
      const d = { id: this.nextId++, type: this.tool, pts: [pt], ...this.lastStyle };
      this.items.push(d);
      this.downAt = { x: mx, y: my };
      if (d.type === 'brush') { this.pending = d; return true; }
      if (d.type === 'long' || d.type === 'short') {
        const risk = (ch.yMax - ch.yMin) * 0.06, dir = d.type === 'long' ? 1 : -1;
        const t2 = ch.timeAt(Math.round(ch.xToIndexF(mx)) + 25);
        d.pts.push({ t: t2, p: pt.p + dir * risk * 2 }, { t: t2, p: pt.p - dir * risk });
        d.width = 1;
        this.finish(); return true;
      }
      if (d.type === 'text') {
        const txt = prompt('Text:', 'Notiz');
        if (!txt) { this.items.pop(); this.undoStack.pop(); this.setTool('cursor'); return true; }
        d.text = txt;
        this.finish(); return true;
      }
      if (DRAW_TOOLS[d.type].n === 1) { this.finish(); return true; }
      d.pts.push({ ...pt });
      this.pending = d;
      return true;
    }
    // Cursor: Griff der ausgewählten Zeichnung?
    if (this.hidden) return false;
    if (this.sel) {
      const h = this.handles(this.sel).find(h => Math.hypot(h.x - mx, h.y - my) < this.grip());
      if (h) { this.snapshot(); this.drag = { kind: 'handle', d: this.sel, h, moved: false }; return true; }
    }
    const hit = this.hitTest(mx, my);
    if (hit) {
      this.select(hit);
      this.snapshot();
      this.drag = { kind: 'move', d: hit, orig: hit.pts.map(p => ({ ...p })), f0: ch.xToIndexF(mx), p0: ch.priceAtY(my), moved: false };
      return true;
    }
    if (this.sel) this.select(null);
    return false;
  }

  move(mx, my, e, dragging) {
    const ch = this.chart;
    if (this.drag && this.drag.kind === 'measure') { ch.measure.i1 = ch.idxAtX(mx); ch.measure.p1 = ch.priceAtY(my); return; }
    const d = this.pending;
    if (d) {
      if (d.type === 'brush') {
        if (dragging) {
          const last = this.P(d.pts[d.pts.length - 1]);
          if (Math.hypot(last.x - mx, last.y - my) > 3) d.pts.push({ t: ch.timeAt(ch.xToIndexF(mx)), p: ch.priceAtY(my) });
        }
      } else {
        d.pts[d.pts.length - 1] = this.toPoint(mx, my);
      }
      ch.request();
      return;
    }
    const g = this.drag;
    if (g && g.kind === 'handle') { g.h.set(this.toPoint(mx, my)); g.moved = true; ch.request(); return; }
    if (g && g.kind === 'move') {
      const dk = Math.round(ch.xToIndexF(mx) - g.f0), dp = ch.priceAtY(my) - g.p0;
      g.d.pts = g.orig.map(p => ({ t: dk ? ch.timeAt(ch.fracIndex(p.t) + dk) : p.t, p: p.p + dp }));
      g.moved = true;
      ch.request();
      return;
    }
    const h = this.hidden || this.tool !== 'cursor' ? null : this.hitTest(mx, my);
    if (h !== this.hover) { this.hover = h; ch.request(); }
  }

  up(mx, my) {
    const g = this.drag;
    this.drag = null;
    if (g && g.kind === 'measure') {
      const ch = this.chart;
      setTimeout(() => { if (!this.drag) { ch.measure = null; ch.request(); } }, 4000);
      if (!this.keepTool) this.setTool('cursor');
      return;
    }
    if (g) {
      if (!g.moved) this.undoStack.pop(); else this.changed();
      return;
    }
    const d = this.pending;
    if (!d) return;
    if (d.type === 'brush') { if (d.pts.length < 2) { this.cancelPending(); this.undoStack.pop(); } else this.finish(); return; }
    // Gezogen statt geklickt: Punkt sofort festlegen
    if (this.downAt && Math.hypot(mx - this.downAt.x, my - this.downAt.y) > 6) {
      this.downAt = null;
      if (d.pts.length < DRAW_TOOLS[d.type].n) d.pts.push({ ...d.pts[d.pts.length - 1] });
      else this.finish();
    }
  }

  finish() {
    const d = this.pending || this.items[this.items.length - 1];
    this.pending = null;
    this.downAt = null;
    if (!this.keepTool) this.setTool('cursor');
    this.select(d);
    this.changed();
  }

  dblclick(mx, my) {
    const d = this.hitTest(mx, my);
    if (d && d.type === 'text') {
      const txt = prompt('Text:', d.text);
      if (txt != null) { this.select(d); this.setProp('text', txt); }
    }
  }

  cursor(mx, my) {
    if (this.tool !== 'cursor') return 'crosshair';
    if (this.sel && this.handles(this.sel).some(h => Math.hypot(h.x - mx, h.y - my) < this.grip())) return 'move';
    return this.hover ? 'pointer' : 'crosshair';
  }

  // ---------- Treffer & Griffe ----------
  handles(d) {
    const ch = this.chart;
    if (d.type === 'long' || d.type === 'short') {
      const [e, tg, st] = d.pts;
      const x1 = ch.timeToX(e.t), x2 = ch.timeToX(tg.t);
      return [
        { x: x1, y: ch.y(e.p), set: pt => { const dt = Math.round(ch.fracIndex(pt.t) - ch.fracIndex(e.t)), dp = pt.p - e.p;
          for (const q of d.pts) { q.t = ch.timeAt(Math.round(ch.fracIndex(q.t)) + dt); q.p += dp; } } },
        { x: x1, y: ch.y(tg.p), set: pt => { tg.p = pt.p; } },
        { x: x1, y: ch.y(st.p), set: pt => { st.p = pt.p; } },
        { x: x2, y: ch.y(e.p), set: pt => { if (pt.t > e.t) { tg.t = pt.t; st.t = pt.t; } } },
      ];
    }
    if (d.type === 'brush') return [];
    if (d.type === 'hline') { const y = ch.y(d.pts[0].p); return [{ x: ch.plotW() - 40, y, set: pt => { d.pts[0].p = pt.p; } }]; }
    if (d.type === 'vline') { const x = ch.timeToX(d.pts[0].t); return [{ x, y: ch.L.mainH / 2, set: pt => { d.pts[0].t = pt.t; } }]; }
    if (d.type === 'rect') {
      // vier Ecken
      const [a, b] = d.pts;
      return [[a, a], [b, b], [a, b], [b, a]].map(([tx, py]) => ({
        x: ch.timeToX(tx.t), y: ch.y(py.p), set: pt => { tx.t = pt.t; py.p = pt.p; },
      }));
    }
    return d.pts.map(q => ({ ...this.P(q), set: pt => { q.t = pt.t; q.p = pt.p; } }));
  }

  hitTest(mx, my) {
    for (let k = this.items.length - 1; k >= 0; k--) if (this.hit(this.items[k], mx, my)) return this.items[k];
    return null;
  }

  hit(d, mx, my) {
    const ch = this.chart, tol = ch.touch ? 14 : 6;
    const segDist = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
      const u = L ? Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / L)) : 0;
      return Math.hypot(a.x + u * dx - mx, a.y + u * dy - my);
    };
    const ps = d.pts.map(q => this.P(q));
    const inBox = (x1, x2, y1, y2) => mx >= Math.min(x1, x2) - tol && mx <= Math.max(x1, x2) + tol && my >= Math.min(y1, y2) - tol && my <= Math.max(y1, y2) + tol;
    switch (d.type) {
      case 'trend': return segDist(ps[0], ps[1]) < tol;
      case 'ray': case 'ext': { const [a, b] = this.extend(ps[0], ps[1], d.type === 'ext'); return segDist(a, b) < tol; }
      case 'hline': return Math.abs(my - ps[0].y) < tol;
      case 'hray': return Math.abs(my - ps[0].y) < tol && mx >= ps[0].x - tol;
      case 'vline': return Math.abs(mx - ps[0].x) < tol;
      case 'rect': case 'fib': return inBox(ps[0].x, ps[1].x, ps[0].y, ps[1].y);
      case 'long': case 'short': return inBox(ps[0].x, ps[1].x, ps[1].y, ps[2].y);
      case 'channel': {
        if (ps.length < 3) return segDist(ps[0], ps[1]) < tol;
        const off = this.channelOffset(d);
        const b0 = { x: ps[0].x, y: ch.y(d.pts[0].p + off) }, b1 = { x: ps[1].x, y: ch.y(d.pts[1].p + off) };
        if (segDist(ps[0], ps[1]) < tol || segDist(b0, b1) < tol) return true;
        if (mx < Math.min(ps[0].x, ps[1].x) || mx > Math.max(ps[0].x, ps[1].x)) return false;
        const u = (mx - ps[0].x) / (ps[1].x - ps[0].x || 1), ya = ps[0].y + u * (ps[1].y - ps[0].y), yb = b0.y + u * (b1.y - b0.y);
        return my >= Math.min(ya, yb) && my <= Math.max(ya, yb);
      }
      case 'text': { const w = (d.text || '').length * (6 + d.width * 1.2) + 8, h = 14 + d.width * 2; return inBox(ps[0].x, ps[0].x + w, ps[0].y - h, ps[0].y + 4); }
      case 'brush': for (let i = 1; i < ps.length; i++) if (segDist(ps[i - 1], ps[i]) < tol) return true; return false;
    }
    return false;
  }

  // Linie über die Punkte hinaus verlängern (Strahl / erweiterte Linie)
  extend(a, b, both) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, far = 20000;
    const e = { x: b.x + dx / len * far, y: b.y + dy / len * far };
    return [both ? { x: a.x - dx / len * far, y: a.y - dy / len * far } : a, e];
  }

  channelOffset(d) {
    // senkrechter Preisabstand des 3. Punkts zur Linie 1-2
    const ch = this.chart, [a, b, c] = d.pts;
    const fa = ch.fracIndex(a.t), fb = ch.fracIndex(b.t), fc = ch.fracIndex(c.t);
    const lineP = fb === fa ? a.p : a.p + (b.p - a.p) * (fc - fa) / (fb - fa);
    return c.p - lineP;
  }

  // ---------- Zeichnen ----------
  draw(c) {
    if (this.hidden) return;
    for (const d of this.items) this.drawOne(c, d, d === this.sel || d === this.hover);
    if (this.sel && this.items.includes(this.sel)) for (const h of this.handles(this.sel)) {
      c.beginPath(); c.arc(h.x, h.y, this.chart.touch ? 7 : 4.5, 0, 6.283);
      c.fillStyle = '#0d1117'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = this.sel.color; c.stroke();
    }
  }

  stroke(c, d, hl) {
    c.strokeStyle = d.color;
    c.lineWidth = d.width + (hl ? 0.5 : 0);
    c.setLineDash(d.style === 'dashed' ? [7, 5] : d.style === 'dotted' ? [2, 3] : []);
  }

  line(c, a, b) { c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }

  tag(c, x, y, text, color, align = 'right') {
    c.save(); c.setLineDash([]);
    c.font = '11px system-ui';
    const w = c.measureText(text).width + 8;
    const bx = align === 'right' ? x - w : x;
    c.fillStyle = color; c.fillRect(bx, y - 8, w, 16);
    c.fillStyle = '#fff'; c.fillText(text, bx + 4, y + 4);
    c.restore();
  }

  drawOne(c, d, hl) {
    const ch = this.chart, ps = d.pts.map(q => this.P(q)), pw = ch.plotW(), dg = ch.digits;
    c.save();
    this.stroke(c, d, hl);
    switch (d.type) {
      case 'trend': this.line(c, ps[0], ps[1]); break;
      case 'ray': case 'ext': { const [a, b] = this.extend(ps[0], ps[1], d.type === 'ext'); this.line(c, a, b); break; }
      case 'hline':
        this.line(c, { x: 0, y: ps[0].y }, { x: pw, y: ps[0].y });
        this.tag(c, pw - 2, ps[0].y, d.pts[0].p.toFixed(dg), d.color);
        break;
      case 'hray':
        this.line(c, ps[0], { x: pw, y: ps[0].y });
        this.tag(c, pw - 2, ps[0].y, d.pts[0].p.toFixed(dg), d.color);
        break;
      case 'vline': this.line(c, { x: ps[0].x, y: 0 }, { x: ps[0].x, y: ch.L.mainH }); break;
      case 'rect': {
        const x = Math.min(ps[0].x, ps[1].x), y = Math.min(ps[0].y, ps[1].y), w = Math.abs(ps[1].x - ps[0].x), h = Math.abs(ps[1].y - ps[0].y);
        c.fillStyle = hexA(d.color, 0.15); c.fillRect(x, y, w, h); c.strokeRect(x, y, w, h);
        break;
      }
      case 'channel': {
        this.line(c, ps[0], ps[1]);
        if (ps.length === 3) {
          const off = this.channelOffset(d);
          const b0 = { x: ps[0].x, y: ch.y(d.pts[0].p + off) }, b1 = { x: ps[1].x, y: ch.y(d.pts[1].p + off) };
          this.line(c, b0, b1);
          c.fillStyle = hexA(d.color, 0.1);
          c.beginPath(); c.moveTo(ps[0].x, ps[0].y); c.lineTo(ps[1].x, ps[1].y); c.lineTo(b1.x, b1.y); c.lineTo(b0.x, b0.y); c.closePath(); c.fill();
          c.setLineDash([4, 4]); c.lineWidth = 1;
          this.line(c, { x: ps[0].x, y: (ps[0].y + b0.y) / 2 }, { x: ps[1].x, y: (ps[1].y + b1.y) / 2 });
        }
        break;
      }
      case 'fib': {
        const [a, b] = d.pts, x1 = Math.min(ps[0].x, ps[1].x), x2 = Math.max(ps[0].x, ps[1].x);
        c.setLineDash([]);
        let prevY = null;
        for (const L of FIB_LEVELS) {
          const price = b.p + (a.p - b.p) * L.v, y = ch.y(price);
          if (prevY != null) { c.fillStyle = hexA(L.c, 0.08); c.fillRect(x1, Math.min(prevY, y), x2 - x1, Math.abs(y - prevY)); }
          prevY = y;
          c.strokeStyle = L.c; c.lineWidth = 1;
          this.line(c, { x: x1, y }, { x: x2, y });
          c.fillStyle = L.c; c.font = '11px system-ui';
          c.fillText(`${L.v} (${price.toFixed(dg)})`, x1 + 4, y - 3);
        }
        c.strokeStyle = hexA(d.color, 0.6); c.setLineDash([4, 4]);
        this.line(c, ps[0], ps[1]);
        break;
      }
      case 'long': case 'short': this.drawPosition(c, d, ps); break;
      case 'text':
        c.fillStyle = d.color;
        c.font = `${11 + d.width * 2}px system-ui`;
        c.fillText(d.text || '', ps[0].x, ps[0].y);
        break;
      case 'brush':
        c.setLineDash([]); c.lineJoin = 'round'; c.lineCap = 'round';
        c.beginPath(); ps.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.stroke();
        break;
    }
    c.restore();
  }

  // Long-/Short-Position mit Ziel- und Stop-Zone, CRV und ob Ziel/Stop schon erreicht wurde
  drawPosition(c, d, ps) {
    const ch = this.chart, dg = ch.digits, pip = ch.pip, dir = d.type === 'long' ? 1 : -1;
    const [e, tg, st] = d.pts;
    const x1 = ps[0].x, x2 = Math.max(ps[1].x, x1 + 10), ye = ps[0].y, yt = ps[1].y, ys = ps[2].y;
    c.setLineDash([]);
    c.fillStyle = 'rgba(8,153,129,0.22)'; c.fillRect(x1, Math.min(ye, yt), x2 - x1, Math.abs(yt - ye));
    c.fillStyle = 'rgba(242,54,69,0.22)'; c.fillRect(x1, Math.min(ye, ys), x2 - x1, Math.abs(ys - ye));
    c.strokeStyle = '#787b86'; c.lineWidth = 1; this.line(c, { x: x1, y: ye }, { x: x2, y: ye });

    // Ergebnis anhand der Kerzen nach dem Einstieg (im Replay nur die sichtbaren)
    const b = ch.bars, k1 = Math.max(0, Math.ceil(ch.fracIndex(e.t))), k2 = Math.min(Math.floor(ch.fracIndex(tg.t)), ch.last());
    let result = null, kHit = null;
    for (let k = k1 + 1; k <= k2; k++) {
      const hitStop = dir > 0 ? b.l[k] <= st.p : b.h[k] >= st.p;
      const hitTarget = dir > 0 ? b.h[k] >= tg.p : b.l[k] <= tg.p;
      if (hitStop || hitTarget) { result = hitStop ? 'stop' : 'target'; kHit = k; break; }
    }
    if (result) {
      const xh = ch.x(kHit);
      c.fillStyle = result === 'target' ? 'rgba(8,153,129,0.35)' : 'rgba(242,54,69,0.35)';
      const y = result === 'target' ? yt : ys;
      c.fillRect(x1, Math.min(ye, y), Math.min(xh, x2) - x1, Math.abs(y - ye));
    }
    const rTarget = Math.abs(tg.p - e.p), rStop = Math.abs(e.p - st.p);
    const pct = v => (v / e.p * 100).toFixed(2);
    c.font = '11px system-ui';
    const label = (txt, y, col) => {
      const w = c.measureText(txt).width + 10, x = (x1 + x2) / 2 - w / 2;
      c.fillStyle = col; c.fillRect(x, y - 9, w, 17); c.fillStyle = '#fff'; c.fillText(txt, x + 5, y + 4);
    };
    label(`Ziel: ${(rTarget / pip).toFixed(1)} Pips (${pct(rTarget)} %) · ${tg.p.toFixed(dg)}`, yt + (dir > 0 ? -12 : 12), '#089981');
    label(`Stop: ${(rStop / pip).toFixed(1)} Pips (${pct(rStop)} %) · ${st.p.toFixed(dg)}`, ys + (dir > 0 ? 12 : -12), '#f23645');
    const rr = rStop ? (rTarget / rStop).toFixed(2) : '–';
    label(`${dir > 0 ? 'Long' : 'Short'} ${e.p.toFixed(dg)} · CRV ${rr}` + (result ? (result === 'target' ? ' · Ziel erreicht ✓' : ' · Stop erreicht ✗') : ''), ye, result === 'target' ? '#089981' : result === 'stop' ? '#f23645' : '#434651');
  }
}

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : hex;
}
