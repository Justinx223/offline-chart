'use strict';
// Indikatoren. Alle Funktionen liefern Float64Array, NaN = noch kein Wert (Anlaufphase).
const ta = (() => {
  function nanArr(n) { const a = new Float64Array(n); a.fill(NaN); return a; }
  function asSeries(x, n) {
    if (typeof x === 'number') { const a = new Float64Array(n); a.fill(x); return a; }
    return x;
  }
  function firstValid(s) { for (let i = 0; i < s.length; i++) if (!isNaN(s[i])) return i; return s.length; }

  function sma(src, len) {
    const n = src.length, out = nanArr(n);
    let sum = 0, bad = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (isNaN(v)) bad++; else sum += v;
      if (i >= len) { const o = src[i - len]; if (isNaN(o)) bad--; else sum -= o; }
      if (i >= len - 1 && bad === 0) out[i] = sum / len;
    }
    return out;
  }

  function ema(src, len) {
    const n = src.length, out = nanArr(n), a = 2 / (len + 1);
    let prev = NaN, cnt = 0;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      if (isNaN(v)) { if (!isNaN(prev)) out[i] = prev; continue; }
      prev = isNaN(prev) ? v : a * v + (1 - a) * prev;
      if (++cnt >= len) out[i] = prev;
    }
    return out;
  }

  // Wilder-Glättung (wie Pine ta.rma): Start mit SMA, danach alpha = 1/len
  function rma(src, len) {
    const n = src.length, out = nanArr(n), a = 1 / len;
    let prev = NaN, sum = 0, cnt = 0;
    for (let i = firstValid(src); i < n; i++) {
      const v = src[i];
      if (isNaN(prev)) {
        if (isNaN(v)) { sum = 0; cnt = 0; continue; }
        sum += v;
        if (++cnt === len) { prev = sum / len; out[i] = prev; }
        continue;
      }
      prev = isNaN(v) ? prev : a * v + (1 - a) * prev;
      out[i] = prev;
    }
    return out;
  }

  function wma(src, len) {
    const n = src.length, out = nanArr(n), d = len * (len + 1) / 2;
    for (let i = len - 1; i < n; i++) {
      let s = 0;
      for (let k = 0; k < len; k++) s += src[i - k] * (len - k);
      out[i] = s / d;
    }
    return out;
  }

  function stdev(src, len) {
    const n = src.length, out = nanArr(n), m = sma(src, len);
    for (let i = len - 1; i < n; i++) {
      if (isNaN(m[i])) continue;
      let s = 0;
      for (let k = 0; k < len; k++) { const d = src[i - k] - m[i]; s += d * d; }
      out[i] = Math.sqrt(s / len);
    }
    return out;
  }

  function tr(high, low, close) {
    const n = high.length, out = new Float64Array(n);
    out[0] = high[0] - low[0];
    for (let i = 1; i < n; i++)
      out[i] = Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    return out;
  }

  function atr(high, low, close, len = 14) { return rma(tr(high, low, close), len); }

  function rsi(src, len = 14) {
    const n = src.length, up = nanArr(n), dn = nanArr(n);
    for (let i = 1; i < n; i++) {
      const d = src[i] - src[i - 1];
      up[i] = Math.max(d, 0); dn[i] = Math.max(-d, 0);
    }
    const ru = rma(up, len), rd = rma(dn, len), out = nanArr(n);
    for (let i = 0; i < n; i++) {
      if (isNaN(ru[i])) continue;
      out[i] = rd[i] === 0 ? 100 : ru[i] === 0 ? 0 : 100 - 100 / (1 + ru[i] / rd[i]);
    }
    return out;
  }

  // Parabolic SAR (gleiche Logik wie Pine ta.sar)
  function sar(high, low, close, start = 0.02, inc = 0.02, max = 0.2) {
    const n = high.length, out = nanArr(n);
    let result = NaN, maxMin = NaN, acc = NaN, isBelow = false;
    for (let i = 1; i < n; i++) {
      let firstTrendBar = false;
      if (i === 1) {
        if (close[1] > close[0]) { isBelow = true; maxMin = high[1]; result = low[0]; }
        else { isBelow = false; maxMin = low[1]; result = high[0]; }
        firstTrendBar = true;
        acc = start;
      }
      result = result + acc * (maxMin - result);
      if (isBelow) {
        if (result > low[i]) { firstTrendBar = true; isBelow = false; result = Math.max(high[i], maxMin); maxMin = low[i]; acc = start; }
      } else if (result < high[i]) {
        firstTrendBar = true; isBelow = true; result = Math.min(low[i], maxMin); maxMin = high[i]; acc = start;
      }
      if (!firstTrendBar) {
        if (isBelow) { if (high[i] > maxMin) { maxMin = high[i]; acc = Math.min(acc + inc, max); } }
        else if (low[i] < maxMin) { maxMin = low[i]; acc = Math.min(acc + inc, max); }
      }
      if (isBelow) { result = Math.min(result, low[i - 1]); if (i > 1) result = Math.min(result, low[i - 2]); }
      else { result = Math.max(result, high[i - 1]); if (i > 1) result = Math.max(result, high[i - 2]); }
      out[i] = result;
    }
    return out;
  }

  // ADX / DMI (wie Pine ta.dmi) -> { adx, plus, minus }
  function adx(high, low, close, len = 14, smooth = len) {
    const n = high.length, pdm = nanArr(n), mdm = nanArr(n);
    for (let i = 1; i < n; i++) {
      const up = high[i] - high[i - 1], down = low[i - 1] - low[i];
      pdm[i] = up > down && up > 0 ? up : 0;
      mdm[i] = down > up && down > 0 ? down : 0;
    }
    const t = rma(tr(high, low, close), len), rp = rma(pdm, len), rm = rma(mdm, len);
    const plus = nanArr(n), minus = nanArr(n), dx = nanArr(n);
    for (let i = 0; i < n; i++) {
      if (isNaN(t[i]) || isNaN(rp[i])) continue;
      plus[i] = t[i] ? 100 * rp[i] / t[i] : 0;
      minus[i] = t[i] ? 100 * rm[i] / t[i] : 0;
      const s = plus[i] + minus[i];
      dx[i] = Math.abs(plus[i] - minus[i]) / (s === 0 ? 1 : s);
    }
    const a = rma(dx, smooth);
    for (let i = 0; i < n; i++) a[i] *= 100;
    return { adx: a, plus, minus };
  }

  function highest(src, len) {
    const n = src.length, out = nanArr(n), dq = new Int32Array(n);
    let h = 0, t = 0;
    for (let i = 0; i < n; i++) {
      while (t > h && src[dq[t - 1]] <= src[i]) t--;
      dq[t++] = i;
      if (dq[h] <= i - len) h++;
      if (i >= len - 1) out[i] = src[dq[h]];
    }
    return out;
  }

  function lowest(src, len) {
    const n = src.length, out = nanArr(n), dq = new Int32Array(n);
    let h = 0, t = 0;
    for (let i = 0; i < n; i++) {
      while (t > h && src[dq[t - 1]] >= src[i]) t--;
      dq[t++] = i;
      if (dq[h] <= i - len) h++;
      if (i >= len - 1) out[i] = src[dq[h]];
    }
    return out;
  }

  function bb(src, len = 20, mult = 2) {
    const mid = sma(src, len), sd = stdev(src, len), n = src.length;
    const upper = nanArr(n), lower = nanArr(n);
    for (let i = 0; i < n; i++) { upper[i] = mid[i] + mult * sd[i]; lower[i] = mid[i] - mult * sd[i]; }
    return { mid, upper, lower };
  }

  function macd(src, fast = 12, slow = 26, sig = 9) {
    const f = ema(src, fast), s = ema(src, slow), n = src.length, m = nanArr(n);
    for (let i = 0; i < n; i++) m[i] = f[i] - s[i];
    const signal = ema(m, sig), hist = nanArr(n);
    for (let i = 0; i < n; i++) hist[i] = m[i] - signal[i];
    return { macd: m, signal, hist };
  }

  function stoch(high, low, close, kLen = 14, kSmooth = 3, dLen = 3) {
    const hh = highest(high, kLen), ll = lowest(low, kLen), n = close.length, raw = nanArr(n);
    for (let i = 0; i < n; i++) { const r = hh[i] - ll[i]; raw[i] = r ? 100 * (close[i] - ll[i]) / r : 50; }
    const k = sma(raw, kSmooth);
    return { k, d: sma(k, dLen) };
  }

  function donchian(high, low, len = 20) {
    const upper = highest(high, len), lower = lowest(low, len), n = high.length, mid = nanArr(n);
    for (let i = 0; i < n; i++) mid[i] = (upper[i] + lower[i]) / 2;
    return { upper, lower, mid };
  }

  function change(src, len = 1) {
    const n = src.length, out = nanArr(n);
    for (let i = len; i < n; i++) out[i] = src[i] - src[i - len];
    return out;
  }

  function crossover(a, b, i) {
    if (i < 1) return false;
    const a0 = a[i], a1 = a[i - 1];
    const b0 = typeof b === 'number' ? b : b[i], b1 = typeof b === 'number' ? b : b[i - 1];
    return a0 > b0 && a1 <= b1;
  }

  function crossunder(a, b, i) {
    if (i < 1) return false;
    const a0 = a[i], a1 = a[i - 1];
    const b0 = typeof b === 'number' ? b : b[i], b1 = typeof b === 'number' ? b : b[i - 1];
    return a0 < b0 && a1 >= b1;
  }

  // Rechnen mit Reihen: ta.calc(i => close[i] - open[i]) erzeugt eine neue Reihe
  let currentLength = 0;
  function calc(fn) {
    const out = nanArr(currentLength);
    for (let i = 0; i < currentLength; i++) { const v = fn(i); out[i] = v == null ? NaN : +v; }
    return out;
  }

  return {
    sma, ema, rma, wma, stdev, tr, atr, rsi, sar, adx, highest, lowest, bb, macd, stoch, donchian, change,
    crossover, crossunder, calc, asSeries,
    _setLength(n) { currentLength = n; },
  };
})();
