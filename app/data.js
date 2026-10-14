'use strict';
// Daten laden (daten/*.js, CSV-Dateien, Demo) und in andere Zeitrahmen umrechnen.
// Zeiten sind Millisekunden in SERVERZEIT (so wie MT5 sie liefert), als wäre es UTC.

const TIMEFRAMES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440 };

const OfflineData = {
  sets: new Map(),      // Symbol -> Datensatz
  waiting: new Map(),   // Symbol -> resolve-Funktion beim Nachladen

  // wird von daten/SYMBOL.js aufgerufen
  add(head, text) {
    const ds = parseCompact(head, text);
    this.sets.set(ds.symbol, ds);
    const done = this.waiting.get(ds.symbol);
    if (done) { this.waiting.delete(ds.symbol); done(ds); }
  },

  // lädt daten/SYMBOL.js per <script> (fetch geht bei file:// nicht)
  load(symbol) {
    if (this.sets.has(symbol)) return Promise.resolve(this.sets.get(symbol));
    return new Promise((resolve, reject) => {
      this.waiting.set(symbol, resolve);
      const s = document.createElement('script');
      s.src = 'daten/' + encodeURIComponent(symbol) + '.js';
      s.onerror = () => { this.waiting.delete(symbol); reject(new Error('daten/' + symbol + '.js nicht gefunden')); };
      document.head.appendChild(s);
    });
  },
};

function makeDataset(symbol, digits, n) {
  return {
    symbol, digits, point: Math.pow(10, -digits), n, baseTf: 1,
    t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n),
    l: new Float64Array(n), c: new Float64Array(n), s: new Float64Array(n),
  };
}

function parseCompact(head, text) {
  const n = head.bars;
  const ds = makeDataset(head.symbol, head.digits, n);
  const f = ds.point;
  let pos = 0, row = 0, minute = 0, close = 0;
  const vals = [0, 0, 0, 0, 0, 0];
  const L = text.length;
  while (pos < L && row < n) {
    // Zeile mit 6 Ganzzahlen von Hand zerlegen (schneller als split)
    for (let k = 0; k < 6; k++) {
      let neg = false, v = 0, ch = text.charCodeAt(pos);
      if (ch === 45) { neg = true; pos++; ch = text.charCodeAt(pos); }
      while (ch >= 48 && ch <= 57) { v = v * 10 + ch - 48; pos++; ch = text.charCodeAt(pos); }
      vals[k] = neg ? -v : v;
      pos++; // Komma oder Zeilenumbruch
    }
    minute += vals[0];
    const o = close + vals[1];
    close = o + vals[4];
    ds.t[row] = minute * 60000;
    ds.o[row] = o * f; ds.h[row] = (o + vals[2]) * f; ds.l[row] = (o - vals[3]) * f; ds.c[row] = close * f;
    ds.s[row] = vals[5];
    row++;
  }
  ds.n = row;
  trimDataset(ds);
  ds.baseTf = detectTf(ds);
  return ds;
}

function trimDataset(ds) {
  for (const f of ['t', 'o', 'h', 'l', 'c', 's']) if (ds[f].length !== ds.n) ds[f] = ds[f].subarray(0, ds.n);
  return ds;
}

// CSV: Data_Export.mq5 (time,open,high,low,close,spread,digits), MT5-Export (<DATE> <TIME> ...) oder ähnliche
function parseCsv(name, text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('Datei ist leer');
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  let start = /[a-zA-Z<]/.test(lines[0]) ? 1 : 0;
  const header = start ? lines[0].toLowerCase().replace(/[<>]/g, '').split(sep) : [];
  const col = (names, def) => { for (const nm of names) { const k = header.indexOf(nm); if (k >= 0) return k; } return def; };
  const hasTimeCol = header.includes('time') && header.includes('date');
  const iDate = col(['date', 'time', 'datetime', 'timestamp'], 0);
  const iTime = hasTimeCol ? header.indexOf('time') : -1;
  const off = hasTimeCol ? 1 : 0;
  const iO = col(['open'], 1 + off), iH = col(['high'], 2 + off), iL = col(['low'], 3 + off), iC = col(['close'], 4 + off);
  const iS = col(['spread'], -1), iD = col(['digits'], -1);

  const rows = lines.length - start;
  let symbol = name.replace(/\.[^.]+$/, '').replace(/^export_/, '').replace(/_M\d+$|_H\d+$|_D1$/, '').toUpperCase();
  let digits = 0;
  const tmp = makeDataset(symbol, 5, rows);
  let n = 0;
  for (let r = start; r < lines.length; r++) {
    const p = lines[r].split(sep);
    if (p.length < 5) continue;
    const ts = parseTime(iTime >= 0 ? p[iDate] + ' ' + p[iTime] : p[iDate]);
    if (isNaN(ts)) continue;
    tmp.t[n] = ts; tmp.o[n] = +p[iO]; tmp.h[n] = +p[iH]; tmp.l[n] = +p[iL]; tmp.c[n] = +p[iC];
    tmp.s[n] = iS >= 0 ? +p[iS] || 0 : 0;
    if (iD >= 0 && p[iD]) digits = +p[iD];
    else if (r < start + 200) digits = Math.max(digits, decimals(p[iO]), decimals(p[iC]));
    n++;
  }
  if (!n) throw new Error('Keine Kerzen erkannt. Erwartet: Zeit, Open, High, Low, Close');
  // nach Zeit sortieren (manche Exporte sind absteigend)
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => tmp.t[a] - tmp.t[b]);
  const ds = makeDataset(symbol, digits || 5, n);
  order.forEach((k, i) => { ds.t[i] = tmp.t[k]; ds.o[i] = tmp.o[k]; ds.h[i] = tmp.h[k]; ds.l[i] = tmp.l[k]; ds.c[i] = tmp.c[k]; ds.s[i] = tmp.s[k]; });
  ds.baseTf = detectTf(ds);
  return ds;
}

function decimals(s) { const k = String(s).indexOf('.'); return k < 0 ? 0 : String(s).trim().length - k - 1; }

function parseTime(s) {
  s = String(s).trim();
  if (/^\d{10,13}$/.test(s)) return s.length === 13 ? +s : +s * 1000;
  const m = s.match(/^(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (d) return Date.UTC(+d[3], +d[2] - 1, +d[1], +(d[4] || 0), +(d[5] || 0));
  return NaN;
}

// kleinster typischer Abstand zwischen Kerzen = Zeitrahmen der Rohdaten (Minuten)
function detectTf(ds) {
  const cnt = new Map();
  for (let i = 1; i < Math.min(ds.n, 3000); i++) {
    const d = Math.round((ds.t[i] - ds.t[i - 1]) / 60000);
    if (d > 0) cnt.set(d, (cnt.get(d) || 0) + 1);
  }
  let best = 1, bc = -1;
  for (const [d, c] of cnt) if (c > bc) { best = d; bc = c; }
  return best;
}

// Kerzen zu einem höheren Zeitrahmen zusammenfassen.
// sub0/sub1 = erste/letzte Rohdaten-Kerze, aus der eine Kerze besteht (für genaue SL/TP-Prüfung)
function aggregate(ds, tf) {
  if (tf <= ds.baseTf) {
    const n = ds.n, sub0 = new Int32Array(n), sub1 = new Int32Array(n);
    for (let i = 0; i < n; i++) { sub0[i] = i; sub1[i] = i; }
    return { tf: ds.baseTf, n, t: ds.t, o: ds.o, h: ds.h, l: ds.l, c: ds.c, s: ds.s, sub0, sub1 };
  }
  const ms = tf * 60000, cap = Math.ceil(ds.n / Math.max(1, tf / ds.baseTf)) + 16 + Math.ceil(ds.n * 0.05);
  const out = { tf, n: 0, t: new Float64Array(cap), o: new Float64Array(cap), h: new Float64Array(cap), l: new Float64Array(cap),
    c: new Float64Array(cap), s: new Float64Array(cap), sub0: new Int32Array(cap), sub1: new Int32Array(cap) };
  let k = -1, key = -Infinity;
  for (let i = 0; i < ds.n; i++) {
    const kk = Math.floor(ds.t[i] / ms);
    if (kk !== key) {
      key = kk; k++;
      if (k >= cap) break;
      out.t[k] = kk * ms; out.o[k] = ds.o[i]; out.h[k] = ds.h[i]; out.l[k] = ds.l[i]; out.c[k] = ds.c[i];
      out.s[k] = ds.s[i]; out.sub0[k] = i; out.sub1[k] = i;
    } else {
      if (ds.h[i] > out.h[k]) out.h[k] = ds.h[i];
      if (ds.l[i] < out.l[k]) out.l[k] = ds.l[i];
      out.c[k] = ds.c[i]; out.sub1[k] = i;
    }
  }
  out.n = k + 1;
  for (const f of ['t', 'o', 'h', 'l', 'c', 's', 'sub0', 'sub1']) out[f] = out[f].subarray(0, out.n);
  return out;
}

// Zufällige Gold-ähnliche Daten, damit man das Tool auch ohne echte Daten ausprobieren kann
function demoDataset() {
  const days = 90, perDay = 1440, n = days * perDay;
  const ds = makeDataset('DEMO', 2, n);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const gauss = () => { let s = 0; for (let k = 0; k < 6; k++) s += rnd(); return s - 3; };
  let p = 2400, drift = 0, m = 0;
  const t0 = Date.UTC(2025, 0, 6, 1, 0);
  for (let d = 0; d < days * 1.5 && m < n; d++) {
    const day = new Date(t0 + d * 86400000).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (let k = 0; k < perDay - 60 && m < n; k++) {
      const hr = Math.floor((k + 60) / 60) - 1; // Serverzeit
      const vol = hr >= 9 && hr < 12 ? 0.55 : hr >= 15 && hr < 19 ? 0.7 : 0.25;
      if (rnd() < 0.002) drift = (rnd() - 0.5) * 0.08;
      const o = p;
      let h = o, l = o, c = o;
      for (let s = 0; s < 4; s++) { c += gauss() * vol * 0.5 + drift; h = Math.max(h, c); l = Math.min(l, c); }
      ds.t[m] = t0 + d * 86400000 + k * 60000;
      ds.o[m] = +o.toFixed(2); ds.h[m] = +h.toFixed(2); ds.l[m] = +l.toFixed(2); ds.c[m] = +c.toFixed(2);
      ds.s[m] = hr < 2 || hr > 22 ? 40 : 18;
      p = ds.c[m];
      m++;
    }
  }
  ds.n = m;
  return trimDataset(ds);
}
