'use strict';
// Führt den Strategie-Code aus. Der Code bekommt alle Funktionen als Variablen (siehe Hilfe-Tab).

const Runner = (() => {
  // Wie viele Zeilen setzt der Browser vor den Code einer new Function? (für "Fehler in Zeile X")
  const LINE_OFFSET = (() => {
    try { new Function('a', '"use strict";\nthrow new Error("x")')(); } catch (e) {
      const m = /<anonymous>:(\d+):\d+/.exec(e.stack) || /> Function:(\d+):\d+/.exec(e.stack);
      if (m) return +m[1] - 1;
    }
    return 3;
  })();

  function errorLine(e) {
    const m = /<anonymous>:(\d+):\d+/.exec(e.stack || '') || /> Function:(\d+):\d+/.exec(e.stack || '');
    return m ? +m[1] - LINE_OFFSET : null;
  }

  // Deutsche Uhrzeit je Kerze (Serverzeit minus Versatz), einmal pro Datensatz berechnet
  function timeInfo(bars, offsetHours) {
    const key = 'ti' + offsetHours;
    if (bars[key]) return bars[key];
    const n = bars.n, mod = new Int16Array(n), day = new Int32Array(n), wd = new Int8Array(n);
    const off = offsetHours * 60;
    for (let i = 0; i < n; i++) {
      const m = Math.floor(bars.t[i] / 60000) - off;
      const d = Math.floor(m / 1440);
      day[i] = d; mod[i] = m - d * 1440; wd[i] = ((d + 4) % 7 + 7) % 7;
    }
    return (bars[key] = { mod, day, wd });
  }

  function htfMap(bars, h) {
    // Index der letzten ABGESCHLOSSENEN Kerze des höheren Zeitrahmens (kein Blick in die Zukunft)
    const n = bars.n, idx = new Int32Array(n), tfMs = bars.tf * 60000, hMs = h.tf * 60000;
    let k = -1;
    for (let i = 0; i < n; i++) {
      const end = bars.t[i] + tfMs;
      while (k + 1 < h.n && h.t[k + 1] + hMs <= end) k++;
      idx[i] = k;
    }
    return idx;
  }

  function prepare(code, ctx) {
    const { ds, bars, cfg, inputValues = {} } = ctx;
    const n = bars.n;
    const engine = new Engine(ds, bars, cfg);
    const ti = timeInfo(bars, cfg.serverOffset);
    const run = {
      engine, bars, ds, cfg, inputsDef: [], plots: [], hlines: [], markers: [], boxes: [], bg: null,
      onBar: null, error: null, htfCache: {},
    };
    ta._setLength(n);

    const point = ds.point;
    const spreadPts = bars.s;
    const hl2 = new Float64Array(n), hlc3 = new Float64Array(n);
    for (let i = 0; i < n; i++) { hl2[i] = (bars.h[i] + bars.l[i]) / 2; hlc3[i] = (bars.h[i] + bars.l[i] + bars.c[i]) / 3; }

    const api = {
      open: bars.o, high: bars.h, low: bars.l, close: bars.c, time: bars.t, spread: spreadPts, hl2, hlc3,
      bars: n, pip: cfg.pip, point, symbol: ds.symbol, tf: bars.tf, digits: ds.digits, ta,

      input(name, def, label, opts = {}) {
        if (!run.inputsDef.some(d => d.name === name)) run.inputsDef.push({ name, def, label: label || name, opts });
        if (!(name in inputValues)) return def;
        const v = inputValues[name];
        if (typeof def === 'number') { const x = parseFloat(v); return isNaN(x) ? def : x; }
        if (typeof def === 'boolean') return v === true || v === 'true';
        return v;
      },
      series(fill = NaN) { const a = new Float64Array(n); a.fill(fill); return a; },
      plot(data, name = 'Linie', color = '#60a5fa', opts = {}) {
        if (typeof data === 'function') data = ta.calc(data);
        run.plots.push({ data, name, color, style: opts.style || 'line', pane: opts.pane || 'main', width: opts.width || 1.5 });
        return data;
      },
      hline(value, name = '', color = '#64748b', opts = {}) { run.hlines.push({ value, name, color, pane: opts.pane || 'main' }); },
      bgcolor(cond, color = 'rgba(148,163,184,0.08)') {
        if (!run.bg) run.bg = new Array(n).fill(null);
        for (let i = 0; i < n; i++) if (typeof cond === 'function' ? cond(i) : cond[i]) run.bg[i] = color;
      },
      marker(i, text = '', color = '#facc15', pos = 'above') { if (run.markers.length < 20000) run.markers.push({ i, text, color, pos }); },
      box(i1, i2, top, bottom, color = 'rgba(96,165,250,0.12)', text = '') {
        if (run.boxes.length < 20000) run.boxes.push({ i1, i2, top, bottom, color, text });
      },
      onBar(fn) { run.onBar = fn; },
      log(...msg) { engine.log(msg.map(m => typeof m === 'number' ? +m.toFixed(6) : m).join(' ')); },

      // Zeit (deutsche Zeit)
      hour: i => Math.floor(ti.mod[i] / 60),
      minute: i => ti.mod[i] % 60,
      minuteOfDay: i => ti.mod[i],
      weekday: i => ti.wd[i],
      day: i => ti.day[i],
      newDay: i => i === 0 || ti.day[i] !== ti.day[i - 1],
      inSession(i, fromHour, toHour) {
        const m = ti.mod[i], a = fromHour * 60, b = toHour * 60;
        return a <= b ? m >= a && m < b : m >= a || m < b;
      },
      dateStr: i => fmtDate(bars.t[i] - cfg.serverOffset * 3600000, true),

      // Handel
      buy: (opts = {}) => engine.market(1, opts),
      sell: (opts = {}) => engine.market(-1, opts),
      buyStop: (price, opts = {}) => engine.pending('buystop', price, opts),
      sellStop: (price, opts = {}) => engine.pending('sellstop', price, opts),
      buyLimit: (price, opts = {}) => engine.pending('buylimit', price, opts),
      sellLimit: (price, opts = {}) => engine.pending('selllimit', price, opts),
      closePosition: (reason = 'Schließen') => engine.close(reason),
      cancelOrders: filter => engine.cancel(filter),
      setSL: price => engine.setSL(price),
      setTP: price => engine.setTP(price),
      pos: () => engine.posView(),
      orders: () => engine.orders.map(o => ({ id: o.id, type: o.type, price: o.price, oco: o.oco, sl: o.opts.sl, tp: o.opts.tp })),
      trades: engine.trades,
      lastTrade: () => engine.trades[engine.trades.length - 1] || null,
      balance: () => engine.balance,

      htf(name) {
        const tf = TIMEFRAMES[name];
        if (!tf) throw new Error('Unbekannter Zeitrahmen: ' + name + ' (M1 M5 M15 M30 H1 H4 D1)');
        if (run.htfCache[name]) return run.htfCache[name];
        const h = aggregate(ds, tf), idx = htfMap(bars, h);
        const obj = {
          open: h.o, high: h.h, low: h.l, close: h.c, time: h.t, n: h.n, idx,
          map(series) { const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = idx[i] >= 0 ? series[idx[i]] : NaN; return out; },
        };
        return (run.htfCache[name] = obj);
      },
      crossover: (a, b, i) => ta.crossover(a, b, i),
      crossunder: (a, b, i) => ta.crossunder(a, b, i),
      nz: (v, d = 0) => (v == null || isNaN(v) ? d : v),
    };

    const names = Object.keys(api);
    let fn;
    try {
      fn = new Function(...names, '"use strict";\n' + code);
    } catch (e) {
      run.error = { msg: 'Syntaxfehler: ' + e.message, line: null };
      return run;
    }
    try {
      fn(...names.map(k => api[k]));
    } catch (e) {
      run.error = { msg: e.message, line: errorLine(e) };
    }
    return run;
  }

  function rangeIdx(bars, cfg) {
    let from = 0, to = bars.n - 1;
    const off = cfg.serverOffset * 3600000;
    if (cfg.from) { const t = parseTime(cfg.from) + off; while (from < to && bars.t[from] < t) from++; }
    if (cfg.to) { const t = parseTime(cfg.to) + 86400000 + off; while (to > from && bars.t[to] >= t) to--; }
    return [from, to];
  }

  function backtest(code, ctx) {
    const run = prepare(code, ctx);
    if (run.error) return run;
    const [from, to] = rangeIdx(run.bars, run.cfg);
    run.from = from; run.to = to;
    const eng = run.engine, onBar = run.onBar;
    let i = from;
    try {
      for (; i <= to; i++) {
        eng.processBar(i);
        if (onBar) onBar(i);
      }
    } catch (e) {
      run.error = { msg: e.message + ' (Kerze ' + fmtDate(run.bars.t[i] - run.cfg.serverOffset * 3600000, true) + ')', line: errorLine(e) };
    }
    eng.finish(Math.min(i, to));
    run.stats = computeStats(eng, from, to);
    return run;
  }

  return { prepare, backtest, rangeIdx, errorLine, timeInfo };
})();

function fmtDate(ms, withTime) {
  const d = new Date(ms), p = v => String(v).padStart(2, '0');
  const s = `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : s;
}
