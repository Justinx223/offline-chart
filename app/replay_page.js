'use strict';
// Replay.html: Chart der letzten 2 Jahre mit EMA 9 / EMA 21 / Parabolic SAR, Zeichenwerkzeugen und Replay.

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rp.' + k, JSON.stringify(v)); } catch { /* Speicher gesperrt */ } },
};
const SERVER_OFFSET = 1;            // Serverzeit minus deutsche Zeit (Stunden)
const YEARS = 2;

const ICONS = {
  cursor: '<path d="M6 3l12 8-5.5 1.5L10 18z"/>',
  trend: '<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="5" r="1.8"/>',
  ray: '<path d="M5 19L21 3"/><circle cx="5" cy="19" r="1.8"/><circle cx="12" cy="12" r="1.8"/>',
  ext: '<path d="M2 22L22 2"/><circle cx="9" cy="15" r="1.8"/><circle cx="15" cy="9" r="1.8"/>',
  hline: '<path d="M2 12h20"/><circle cx="12" cy="12" r="1.8"/>',
  hray: '<path d="M7 12h15"/><circle cx="5" cy="12" r="1.8"/>',
  vline: '<path d="M12 2v20"/><circle cx="12" cy="12" r="1.8"/>',
  channel: '<path d="M3 15L15 5M9 20L21 10"/><path d="M6 17.5L18 7.5" stroke-dasharray="2 2"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  fib: '<path d="M3 5h18M3 9.5h18M3 14h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>',
  long: '<rect x="4" y="4" width="16" height="9" fill="rgba(8,153,129,.5)" stroke="none"/><rect x="4" y="13" width="16" height="6" fill="rgba(242,54,69,.5)" stroke="none"/><path d="M4 13h16"/>',
  short: '<rect x="4" y="5" width="16" height="6" fill="rgba(242,54,69,.5)" stroke="none"/><rect x="4" y="11" width="16" height="9" fill="rgba(8,153,129,.5)" stroke="none"/><path d="M4 11h16"/>',
  text: '<path d="M5 5h14M12 5v15M9 20h6"/>',
  brush: '<path d="M3 17c3-6 5 2 8-4s5-6 10-3"/>',
  measure: '<rect x="3" y="14" width="18" height="6" rx="1"/><path d="M7 14v3M11 14v2M15 14v3M19 14v2"/><path d="M4 10L20 4M17 3.5l3 .5-1 3"/>',
  magnet: '<path d="M6 4v8a6 6 0 0012 0V4"/><path d="M6 8h4M14 8h4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="1.5"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};
const COLOR_PRESETS = [
  { name: 'Dunkel', c: { bg: '#0d1117', grid: '#1b222c', gridOn: true, up: '#26a69a', down: '#ef5350', wickUp: '#26a69a', wickDown: '#ef5350', e1: '#22c55e', e2: '#ef4444', sar: '#a3e635' } },
  { name: 'Hell', c: { bg: '#ffffff', grid: '#f0f3fa', gridOn: true, up: '#089981', down: '#f23645', wickUp: '#089981', wickDown: '#f23645', e1: '#16a34a', e2: '#dc2626', sar: '#2563eb' } },
  { name: 'Schwarz', c: { bg: '#000000', grid: '#161616', gridOn: true, up: '#00c853', down: '#ff1744', wickUp: '#00c853', wickDown: '#ff1744', e1: '#00e5ff', e2: '#ffab00', sar: '#e0e0e0' } },
  { name: 'Grau', c: { bg: '#ffffff', grid: '#eeeeee', gridOn: true, up: '#b0b0b0', down: '#262626', wickUp: '#262626', wickDown: '#262626', e1: '#16a34a', e2: '#dc2626', sar: '#2563eb' } },
  { name: 'Blau/Orange', c: { bg: '#131722', grid: '#1e2230', gridOn: true, up: '#2962ff', down: '#ff9800', wickUp: '#2962ff', wickDown: '#ff9800', e1: '#26c6da', e2: '#ec407a', sar: '#ffee58' } },
];
const svg = name => `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`;

const RP = {
  ds: null, bars: null, tfName: store.get('tf', 'M15'), cache: new Map(),
  ind: Object.assign({ e1on: true, e1len: 9, e2on: true, e2len: 21, sarOn: true }, store.get('ind', {})),
  replay: null,

  init() {
    $('nojs').style.display = 'none';   // JavaScript läuft -> Hinweis ausblenden
    this.chart = new Chart($('chart'));
    this.tools = new DrawingTools(this.chart);
    this.chart.onClick = (i, price, e) => this.chartClick(i, price, e);
    this.tools.onChange = items => store.set('draw.' + this.ds.symbol, items);
    this.tools.onSelect = d => this.showProps(d);
    this.tools.onToolChange = t => { for (const b of $('tools').querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === t); };
    this.colors = Object.assign({}, COLOR_PRESETS[0].c, store.get('colors', {}));
    this.buildToolbar();
    this.bindUi();
    this.bindColors();
    this.applyColors();
    this.setupOffline();

    const sel = $('symbol'), idx = window.OFFLINE_INDEX || [];
    for (const e of idx) sel.add(new Option(e.symbol, e.symbol));
    if (!idx.length) {
      OfflineData.sets.set('DEMO', demoDataset());
      sel.add(new Option('DEMO (Zufallsdaten)', 'DEMO'));
    }
    const want = store.get('symbol', 'XAUUSD');
    sel.value = [...sel.options].some(o => o.value === want) ? want : sel.options[0].value;
    this.selectSymbol(sel.value);
  },

  status(m) { $('status').textContent = m; $('status').title = m; },

  // ---------- Daten ----------
  async selectSymbol(sym) {
    this.stopReplay();
    $('busy').classList.add('show');
    await new Promise(r => setTimeout(r, 20));
    try {
      const full = await OfflineData.load(sym);
      this.ds = lastYears(full, YEARS);
      this.cache.clear();
      store.set('symbol', sym);
      const pip = this.pip();
      $('rpLots').value = store.get('lots', 0.1);
      $('rpSl').value = store.get('sl.' + sym, pip < 0.001 ? 10 : 300);
      $('rpTp').value = store.get('tp.' + sym, pip < 0.001 ? 20 : 600);
      this.tools.load(store.get('draw.' + sym, []));
      this.setTf(this.tfName);
      const off = SERVER_OFFSET * 3600000;
      this.status(`${sym}: ${fmtDate(this.ds.t[0] - off)} – ${fmtDate(this.ds.t[this.ds.n - 1] - off)} · 1 Pip = ${pip}`);
    } catch (e) {
      this.status('Fehler: ' + e.message);
    }
    $('busy').classList.remove('show');
  },

  pip() { const d = this.ds.digits; return d === 5 || d === 3 ? this.ds.point * 10 : this.ds.point; },

  setTf(name) {
    this.tfName = name;
    store.set('tf', name);
    for (const b of $('tfs').children) b.classList.toggle('on', b.dataset.tf === name);
    if (!this.cache.has(name)) this.cache.set(name, aggregate(this.ds, TIMEFRAMES[name]));
    this.bars = this.cache.get(name);
    this.chart.setData(this.bars, { digits: this.ds.digits, pip: this.pip(), offsetMs: SERVER_OFFSET * 3600000, title: `${this.ds.symbol} · ${name}` }, true);
    if (this.replay) {
      this.chart.limit = this.limitFor(this.replay.rt);
      this.chart.right = this.chart.limit + 10;
    }
    this.refresh();
  },

  indicators() {
    const b = this.bars, s = this.ind, plots = [];
    const get = (key, fn) => { const k = this.tfName + key; if (!this.cache.has(k)) this.cache.set(k, fn()); return this.cache.get(k); };
    if (s.e1on) plots.push({ data: get('e' + s.e1len, () => ta.ema(b.c, s.e1len)), name: 'EMA ' + s.e1len, color: this.colors.e1, style: 'line', pane: 'main', width: 1.6 });
    if (s.e2on) plots.push({ data: get('e' + s.e2len, () => ta.ema(b.c, s.e2len)), name: 'EMA ' + s.e2len, color: this.colors.e2, style: 'line', pane: 'main', width: 1.6 });
    if (s.sarOn) plots.push({ data: get('sar', () => ta.sar(b.h, b.l, b.c, 0.02, 0.02, 0.2)), name: 'SAR', color: this.colors.sar, style: 'dots', pane: 'main', width: 1 });
    return plots;
  },

  // Overlay neu setzen (Indikatoren + Trades aus dem Replay)
  refresh() {
    const ov = { plots: this.indicators() };
    const r = this.replay;
    if (r) {
      const eng = r.eng, ch = this.chart, idx = t => Math.floor(ch.fracIndex(t));
      ov.trades = eng.trades.map(t => ({ ...t, entryIdx: idx(t.entryTime), exitIdx: idx(t.exitTime) }));
      ov.pos = eng.pos ? { ...eng.pos, entryIdx: idx(eng.pos.entryTime) } : null;
      ov.orders = eng.orders.map(o => ({ ...o }));
      this.updateInfo();
    }
    this.chart.setOverlay(ov);
  },

  // ---------- Replay ----------
  // Replay läuft intern auf M1: rt = Zeitpunkt, bis zu dem alles sichtbar ist.
  // So bleiben offene Trades erhalten, wenn man den Zeitrahmen wechselt.
  startReplay(i) {
    this.pickReplay = false;
    $('btnReplay').classList.remove('on');
    i = Math.max(30, Math.min(this.bars.n - 2, i));
    const ds = this.ds;
    if (!this.cache.has('base')) this.cache.set('base', aggregate(ds, ds.baseTf));
    const pip = this.pip(), sym = ds.symbol.toUpperCase();
    const contract = sym.startsWith('XAU') || sym === 'DEMO' ? 100 : sym.startsWith('XAG') ? 5000 : /^[A-Z]{6}/.test(sym) ? 100000 : 1;
    const eng = new Engine(ds, this.cache.get('base'), {
      capital: 10000, lots: 0.1, riskPct: 0, useDataSpread: true, extraSpreadPips: 0, commission: 0, slipPips: 0,
      intrabar: false, serverOffset: SERVER_OFFSET, pip, contract,
    });
    const rt = this.bars.t[i] + this.bars.tf * 60000;
    const next = lowerBound(ds.t, ds.n, rt);
    eng.i = next - 1; eng.t = ds.t[next - 1]; eng.spr = eng.spreadAt(next - 1);
    this.replay = { rt, eng, next, playing: false, timer: null };
    this.chart.limit = this.limitFor(rt);
    this.chart.right = this.chart.limit + 10;
    this.chart.autoY = true;
    $('replayBar').classList.add('show');
    this.refresh();
    this.status(this.chart.touch || matchMedia('(pointer: coarse)').matches ? 'Replay · +1 / +5 / +10 = Kerzen vorwärts · ▶ abspielen · lange drücken = Fadenkreuz'
      : 'Replay · → nächste Kerze · Leertaste abspielen · B / S kaufen / verkaufen · C schließen · Strg+Klick Buy-Order, Alt+Klick Sell-Order am Preis');
  },

  limitFor(rt) {
    const b = this.bars, ms = b.tf * 60000;
    let k = lowerBound(b.t, b.n, rt) - 1;
    while (k > 0 && b.t[k] + ms > rt) k--;
    return Math.max(0, k);
  },

  advance(rt) {
    const r = this.replay, ds = this.ds;
    r.rt = Math.max(r.rt, rt);
    while (r.next < ds.n && ds.t[r.next] < r.rt) r.eng.processBar(r.next++);
  },

  step(count = 1) {
    const r = this.replay;
    if (!r) return;
    for (let k = 0; k < count; k++) {
      const lim = this.chart.limit;
      if (lim >= this.bars.n - 1) { this.pause(); this.status('Ende der Daten erreicht'); break; }
      this.advance(this.bars.t[lim + 1] + this.bars.tf * 60000);
      this.chart.limit = lim + 1;
    }
    const ch = this.chart, vis = ch.plotW() / ch.barW;
    if (ch.limit > ch.right - 3) ch.right = ch.limit + Math.min(10, vis * 0.3);
    this.refresh();
  },

  play() {
    const r = this.replay;
    if (!r) return;
    if (r.playing) { this.pause(); return; }
    r.playing = true;
    $('rpPlay').textContent = '⏸';
    const tick = () => {
      if (this.replay !== r || !r.playing) return;
      this.step(1);
      r.timer = setTimeout(tick, 1000 / parseFloat($('rpSpeed').value));
    };
    tick();
  },

  pause() {
    const r = this.replay;
    if (!r) return;
    r.playing = false;
    clearTimeout(r.timer);
    $('rpPlay').textContent = '▶';
  },

  stopReplay() {
    this.pickReplay = false;
    $('btnReplay').classList.remove('on');
    if (!this.replay) return;
    this.pause();
    this.replay = null;
    this.chart.limit = null;
    $('replayBar').classList.remove('show');
    this.refresh();
  },

  // Sofort zum aktuellen Kurs (Close der letzten sichtbaren Minute) handeln, wie im TradingView-Replay
  orderNow(dir) {
    const r = this.replay;
    if (!r) return;
    const eng = r.eng, k = r.next - 1, c = this.ds.c[k], spr = eng.spreadAt(k);
    const sl = parseFloat($('rpSl').value), tp = parseFloat($('rpTp').value), lots = parseFloat($('rpLots').value);
    eng.i = k; eng.t = this.ds.t[k]; eng.spr = spr;
    if (eng.pos && eng.pos.dir === dir) { this.status('Es ist schon eine Position in diese Richtung offen'); return; }
    if (eng.pos) eng.closePos(eng.pos.dir > 0 ? c : c + spr, 'Umkehr');
    eng.openPos(dir, dir > 0 ? c + spr : c, { slPips: sl > 0 ? sl : null, tpPips: tp > 0 ? tp : null, lots: lots > 0 ? lots : 0.01, comment: 'Manuell' });
    this.refresh();
  },

  closeNow() {
    const r = this.replay;
    if (!r) return;
    const eng = r.eng, k = r.next - 1, c = this.ds.c[k], spr = eng.spreadAt(k);
    eng.i = k; eng.t = this.ds.t[k]; eng.spr = spr;
    if (eng.pos) eng.closePos(eng.pos.dir > 0 ? c : c + spr, 'Manuell');
    eng.cancel();
    this.refresh();
  },

  pendingAt(dir, price) {
    const r = this.replay, eng = r.eng, k = r.next - 1, c = this.ds.c[k], pip = this.pip();
    const sl = parseFloat($('rpSl').value), tp = parseFloat($('rpTp').value), lots = parseFloat($('rpLots').value);
    price = +price.toFixed(this.ds.digits);
    eng.i = k; eng.spr = eng.spreadAt(k);
    const type = dir > 0 ? (price > c ? 'buystop' : 'buylimit') : (price < c ? 'sellstop' : 'selllimit');
    const id = eng.pending(type, price, { sl: sl > 0 ? price - dir * sl * pip : null, tp: tp > 0 ? price + dir * tp * pip : null, lots: lots > 0 ? lots : 0.01, comment: 'Manuell' });
    if (id == null) this.status('Order ungültig (zu nah am Kurs)');
    this.refresh();
  },

  updateInfo() {
    const r = this.replay, eng = r.eng, k = r.next - 1;
    const fl = eng.floating(this.ds.c[k], eng.spreadAt(k));
    const tr = eng.trades, net = tr.reduce((s, t) => s + t.pnl, 0), wins = tr.filter(t => t.pnl > 0).length;
    const m = v => (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
    let h = `${fmtDate(r.rt - SERVER_OFFSET * 3600000, true)} · Konto <b>${m(eng.balance)}</b>`;
    if (eng.pos) {
      const p = eng.pos, px = p.dir > 0 ? this.ds.c[k] : this.ds.c[k] + eng.spreadAt(k), pips = p.dir * (px - p.entry) / this.pip();
      h += ` · offen <b class="${fl >= 0 ? 'pos' : 'neg'}">${m(fl)} (${pips.toFixed(1)} P)</b>`;
    }
    if (tr.length) h += ` · ${tr.length} Trades · ${(wins / tr.length * 100).toFixed(0)} % Treffer · Netto <b class="${net >= 0 ? 'pos' : 'neg'}">${m(net)}</b>`;
    $('rpInfo').innerHTML = h;
  },

  chartClick(i, price, e) {
    if (this.pickReplay) { this.startReplay(i); return; }
    if (this.replay && (e.ctrlKey || e.altKey)) this.pendingAt(e.ctrlKey ? 1 : -1, price);
  },

  // ---------- Zeichenleiste & Eigenschaften ----------
  buildToolbar() {
    const box = $('tools');
    const add = (html, title, onclick, data) => {
      const b = document.createElement('button');
      b.innerHTML = html; b.title = title; b.onclick = onclick;
      if (data) Object.assign(b.dataset, data);
      box.appendChild(b);
      return b;
    };
    const hr = () => { const d = document.createElement('div'); d.className = 'hr'; box.appendChild(d); };
    add(svg('cursor'), 'Cursor (Esc)', () => this.tools.setTool('cursor'), { tool: 'cursor' }).classList.add('on');
    hr();
    const groups = [['trend', 'ray', 'ext', 'hline', 'hray', 'vline', 'channel'], ['fib', 'rect', 'long', 'short'], ['text', 'brush', 'measure']];
    for (const g of groups) {
      for (const t of g) {
        const def = DRAW_TOOLS[t];
        add(svg(t), def.name + (def.key ? ` (Alt+${def.key})` : ''), () => this.tools.setTool(this.tools.tool === t ? 'cursor' : t), { tool: t });
      }
      hr();
    }
    const mag = add(svg('magnet'), 'Magnet: Punkte rasten an Open/High/Low/Close ein', () => {
      this.tools.magnet = !this.tools.magnet; mag.classList.toggle('on', this.tools.magnet); store.set('magnet', this.tools.magnet);
    });
    this.tools.magnet = store.get('magnet', false); mag.classList.toggle('on', this.tools.magnet);
    const lock = add(svg('lock'), 'Zeichenmodus halten (Werkzeug bleibt nach dem Zeichnen aktiv)', () => {
      this.tools.keepTool = !this.tools.keepTool; lock.classList.toggle('on', this.tools.keepTool);
    });
    const eye = add(svg('eye'), 'Zeichnungen aus-/einblenden', () => {
      this.tools.hidden = !this.tools.hidden; eye.classList.toggle('on', this.tools.hidden); this.tools.select(null);
    });
    add(svg('undo'), 'Rückgängig (Strg+Z)', () => this.tools.undo());
    add(svg('trash'), 'Alle Zeichnungen löschen', () => { if (this.tools.items.length && confirm('Alle Zeichnungen dieses Symbols löschen?')) this.tools.clear(); });
  },

  showProps(d) {
    const box = $('props');
    if (!d) { box.classList.remove('show'); return; }
    box.innerHTML = '';
    if (!['long', 'short'].includes(d.type)) {
      for (const col of DRAW_COLORS) {
        const b = document.createElement('button');
        b.className = 'sw' + (d.color === col ? ' on' : '');
        b.style.background = col; b.title = col;
        b.onclick = () => { this.tools.setProp('color', col); this.showProps(d); };
        box.appendChild(b);
      }
      const w = document.createElement('select');
      for (const v of [1, 2, 3, 4]) w.add(new Option(d.type === 'text' ? 'Größe ' + v : v + ' px', v));
      w.value = d.width; w.title = 'Linienstärke';
      w.onchange = () => this.tools.setProp('width', +w.value);
      box.appendChild(w);
      if (!['text', 'fib', 'brush'].includes(d.type)) {
        const st = document.createElement('select');
        for (const [v, l] of [['solid', '———'], ['dashed', '– – –'], ['dotted', '·······']]) st.add(new Option(l, v));
        st.value = d.style; st.title = 'Linienart';
        st.onchange = () => this.tools.setProp('style', st.value);
        box.appendChild(st);
      }
    }
    if (d.type === 'text') {
      const b = document.createElement('button'); b.textContent = 'Text ändern';
      b.onclick = () => { const t = prompt('Text:', d.text); if (t != null) this.tools.setProp('text', t); };
      box.appendChild(b);
    }
    const del = document.createElement('button');
    del.innerHTML = '🗑'; del.title = 'Löschen (Entf)';
    del.onclick = () => this.tools.remove(d);
    box.appendChild(del);
    box.classList.add('show');
  },

  // ---------- Bedienung ----------
  bindUi() {
    for (const name of Object.keys(TIMEFRAMES)) {
      const b = document.createElement('button');
      b.textContent = name; b.dataset.tf = name;
      b.onclick = () => this.ds && this.setTf(name);
      $('tfs').appendChild(b);
    }
    for (const k of ['e1on', 'e2on', 'sarOn']) { $(k).checked = this.ind[k]; $(k).onchange = () => this.setInd(k, $(k).checked); }
    for (const k of ['e1len', 'e2len']) { $(k).value = this.ind[k]; $(k).onchange = () => { const v = parseInt($(k).value); if (v > 0) this.setInd(k, v); }; }
    $('symbol').onchange = e => this.selectSymbol(e.target.value);
    $('btnEnd').onclick = () => this.chart.goToEnd();
    $('gotoDate').onchange = e => {
      if (!e.target.value || !this.bars) return;
      this.chart.goToIndex(this.chart.indexAt(parseTime(e.target.value) + SERVER_OFFSET * 3600000), 150);
    };
    $('btnReplay').onclick = () => {
      if (this.replay) { this.stopReplay(); return; }
      this.pickReplay = !this.pickReplay;
      $('btnReplay').classList.toggle('on', this.pickReplay);
      this.status(this.pickReplay ? 'Klicke im Chart auf die Kerze, ab der das Replay starten soll' : '');
    };
    $('btnRandom').onclick = () => {
      this.stopReplay();
      const n = this.bars.n, i = Math.floor(n * 0.05 + Math.random() * n * 0.9);
      this.startReplay(i);
    };
    $('rpPlay').onclick = () => this.play();
    $('rpStep1').onclick = () => this.step(1);
    $('rpStep5').onclick = () => this.step(5);
    $('rpStep10').onclick = () => this.step(10);
    $('zoomIn').onclick = () => this.chart.zoom(1.3);
    $('zoomOut').onclick = () => this.chart.zoom(1 / 1.3);
    $('rpBuy').onclick = () => this.orderNow(1);
    $('rpSell').onclick = () => this.orderNow(-1);
    $('rpClose').onclick = () => this.closeNow();
    $('rpExit').onclick = () => this.stopReplay();
    $('rpLots').onchange = () => store.set('lots', parseFloat($('rpLots').value));
    $('rpSl').onchange = () => store.set('sl.' + this.ds.symbol, parseFloat($('rpSl').value));
    $('rpTp').onchange = () => store.set('tp.' + this.ds.symbol, parseFloat($('rpTp').value));

    window.addEventListener('keydown', e => {
      const tag = document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') { if (e.key === 'Escape') document.activeElement.blur(); return; }
      const k = e.key, ch = this.chart, tools = this.tools;
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); tools.undo(); return; }
      if (e.altKey && k.length === 1) {
        const t = Object.keys(DRAW_TOOLS).find(t => DRAW_TOOLS[t].key === k.toUpperCase());
        if (t) { e.preventDefault(); tools.setTool(t); return; }
      }
      if (k === 'Delete' || k === 'Backspace') { if (tools.sel) { e.preventDefault(); tools.remove(tools.sel); } return; }
      if (k === 'Escape') {
        if (this.pickReplay) $('btnReplay').click();
        tools.setTool('cursor'); tools.select(null); ch.measure = null; ch.request();
        return;
      }
      if (this.replay) {
        if (k === 'ArrowRight') { e.preventDefault(); this.step(e.shiftKey ? 10 : 1); return; }
        if (k === ' ') { e.preventDefault(); this.play(); return; }
        if (k === 'b' || k === 'B') { this.orderNow(1); return; }
        if (k === 's' || k === 'S') { this.orderNow(-1); return; }
        if (k === 'c' || k === 'C') { this.closeNow(); return; }
      }
      if (k === 'ArrowLeft') { ch.right -= 100 / ch.barW; ch.clampRight(); ch.request(); }
      else if (k === 'ArrowRight') { ch.right += 100 / ch.barW; ch.clampRight(); ch.request(); }
      else if (k === '+' || k === '=') { ch.barW = Math.min(60, ch.barW * 1.2); ch.request(); }
      else if (k === '-') { ch.barW = Math.max(0.3, ch.barW / 1.2); ch.request(); }
      else if (k === 'End') ch.goToEnd();
      else if (/^[1-7]$/.test(k)) this.setTf(Object.keys(TIMEFRAMES)[+k - 1]);
    });
  },

  // ---------- Farben ----------
  applyColors() {
    const c = this.colors;
    this.chart.setTheme({ bg: c.bg, grid: c.grid, gridOn: c.gridOn, up: c.up, down: c.down, wickUp: c.wickUp, wickDown: c.wickDown });
    $('chartBox').style.background = c.bg;
    $('e1dot').style.background = c.e1; $('e2dot').style.background = c.e2; $('sardot').style.background = c.sar;
    for (const el of document.querySelectorAll('[data-c]')) el.value = c[el.dataset.c];
    $('gridOn').checked = c.gridOn;
    store.set('colors', c);
    if (this.bars) this.refresh();
  },

  bindColors() {
    $('btnColors').onclick = () => $('colorPanel').classList.toggle('show');
    $('colorsClose').onclick = () => $('colorPanel').classList.remove('show');
    for (const el of document.querySelectorAll('[data-c]')) {
      el.addEventListener('input', () => {
        const k = el.dataset.c;
        // Docht automatisch mitziehen, solange er die gleiche Farbe wie die Kerze hatte
        if (k === 'up' && this.colors.wickUp === this.colors.up) this.colors.wickUp = el.value;
        if (k === 'down' && this.colors.wickDown === this.colors.down) this.colors.wickDown = el.value;
        this.colors[k] = el.value;
        this.applyColors();
      });
    }
    $('gridOn').onchange = () => { this.colors.gridOn = $('gridOn').checked; this.applyColors(); };
    for (const pr of COLOR_PRESETS) {
      const b = document.createElement('button');
      b.innerHTML = `<i style="background:linear-gradient(90deg, ${pr.c.up} 0 33%, ${pr.c.down} 33% 66%, ${pr.c.bg} 66%)"></i>${pr.name}`;
      b.onclick = () => { this.colors = Object.assign({}, pr.c); this.applyColors(); };
      $('presets').appendChild(b);
    }
  },

  // ---------- Offline (iPad / Home-Bildschirm) ----------
  // Läuft die Seite über https, werden App und Daten im Browser gespeichert und funktionieren danach ohne Internet.
  async setupOffline() {
    const el = $('offline');
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    try { await navigator.serviceWorker.register('sw.js'); } catch { el.textContent = '⚠ Offline nicht möglich'; return; }
    const files = ['daten/index.js', ...(window.OFFLINE_INDEX || []).map(e => 'daten/' + e.symbol + '.js')];
    const cache = await caches.open('replay-daten');
    const missing = [];
    for (const f of files) if (!(await cache.match(f))) missing.push(f);
    for (let k = 0; k < missing.length; k++) {
      el.textContent = `⏳ Offline speichern ${k + 1}/${missing.length}…`;
      try { await cache.add(missing[k]); } catch { el.textContent = '⚠ Speichern fehlgeschlagen – online neu laden'; return; }
    }
    el.textContent = '✓ Offline bereit';
    el.classList.add('ok');
    el.title = 'Antippen, um die Daten neu herunterzuladen (nur mit Internet)';
    el.style.cursor = 'pointer';
    el.onclick = async () => {
      if (!navigator.onLine) { alert('Dafür wird Internet gebraucht.'); return; }
      if (!confirm('Kursdaten neu herunterladen?')) return;
      await caches.delete('replay-daten');
      location.reload();
    };
  },

  setInd(k, v) {
    this.ind[k] = v;
    store.set('ind', this.ind);
    this.refresh();
  },
};

// erster Index mit t[i] >= x
function lowerBound(t, n, x) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; }
  return lo;
}

// nur die letzten X Jahre behalten
function lastYears(ds, years) {
  const from = ds.t[ds.n - 1] - years * 365.25 * 86400000;
  const k = lowerBound(ds.t, ds.n, from);
  if (k === 0) return ds;
  const out = Object.assign({}, ds, { n: ds.n - k });
  for (const f of ['t', 'o', 'h', 'l', 'c', 's']) out[f] = ds[f].subarray(k);
  return out;
}

RP.init();
