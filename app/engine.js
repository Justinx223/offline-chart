'use strict';
// Backtest-Engine: eine Position gleichzeitig, Market- und Pending-Orders, SL/TP.
// Kurse in den Daten sind Bid. Käufe passieren auf Ask = Bid + Spread.
// Innerhalb einer Kerze läuft der Kurs wie im MT5-Tester: steigende Kerze Open→Low→High→Close,
// fallende Kerze Open→High→Low→Close. Mit "Intrabar" wird das für jede M1-Kerze einzeln gemacht.

class Engine {
  constructor(ds, bars, cfg) {
    this.ds = ds;
    this.b = bars;
    this.cfg = cfg;
    this.pip = cfg.pip;
    this.balance = cfg.capital;
    this.pos = null;
    this.orders = [];
    this.queue = [];
    this.trades = [];
    this.logs = [];
    this.equity = new Float64Array(bars.n).fill(NaN);
    this.i = -1;
    this.spr = 0;
    this.t = 0;
    this.cur = 0;
    this.nextId = 1;
    const sym = ds.symbol.toUpperCase();
    // Gewinn wird in USD gerechnet: XXXUSD = direkt, USDXXX = durch den Kurs teilen
    this.convDiv = sym.startsWith('USD') && !sym.slice(3).startsWith('USD') && sym.length >= 6;
  }

  spreadAt(k) {
    const c = this.cfg;
    return (c.useDataSpread ? this.ds.s[k] * this.ds.point : 0) + c.extraSpreadPips * this.pip;
  }

  conv(price) { return this.convDiv ? 1 / price : 1; }

  money(dir, entry, exit, lots) { return dir * (exit - entry) * lots * this.cfg.contract * this.conv(exit); }

  log(msg) {
    if (this.logs.length < 2000) this.logs.push({ i: this.i, t: this.b.t[Math.max(0, this.i)], msg: String(msg) });
  }

  // ---------- Ablauf pro Kerze ----------
  processBar(i) {
    this.i = i;
    const b = this.b, ds = this.ds;
    if (this.cfg.intrabar && b.sub1[i] > b.sub0[i]) {
      for (let k = b.sub0[i]; k <= b.sub1[i]; k++)
        this.subBar(ds.o[k], ds.h[k], ds.l[k], ds.c[k], this.spreadAt(k), ds.t[k], k === b.sub0[i]);
    } else {
      this.subBar(b.o[i], b.h[i], b.l[i], b.c[i], this.spreadAt(b.sub0[i]), b.t[i], true);
    }
    if (this.orders.length) this.orders = this.orders.filter(o => o.expireIdx == null || o.expireIdx > i);
    this.equity[i] = this.balance + this.floating(b.c[i], this.spr);
  }

  subBar(o, h, l, c, spr, t, first) {
    this.spr = spr;
    this.t = t;
    if (first && this.queue.length) this.execQueue(o);
    this.cur = o;
    this.checkGap(o);
    const path = c > o ? [l, h, c] : [h, l, c];
    for (const target of path) this.moveTo(target);
    const p = this.pos;
    if (p) {
      const fav = p.dir > 0 ? h - p.entry : p.entry - (l + spr);
      const adv = p.dir > 0 ? p.entry - l : (h + spr) - p.entry;
      if (fav > p.mfe) p.mfe = fav;
      if (adv > p.mae) p.mae = adv;
    }
  }

  // Auslöse-Punkte in Bid-Kursen. up = wird beim Steigen erreicht
  events() {
    const ev = [], spr = this.spr, p = this.pos;
    if (p) {
      if (p.dir > 0) {
        if (p.sl != null) ev.push({ lvl: p.sl, up: false, kind: 'sl' });
        if (p.tp != null) ev.push({ lvl: p.tp, up: true, kind: 'tp' });
      } else {
        if (p.sl != null) ev.push({ lvl: p.sl - spr, up: true, kind: 'sl' });
        if (p.tp != null) ev.push({ lvl: p.tp - spr, up: false, kind: 'tp' });
      }
    } else {
      for (const o of this.orders) {
        if (o.type === 'buystop') ev.push({ lvl: o.price - spr, up: true, kind: 'order', o });
        else if (o.type === 'buylimit') ev.push({ lvl: o.price - spr, up: false, kind: 'order', o });
        else if (o.type === 'sellstop') ev.push({ lvl: o.price, up: false, kind: 'order', o });
        else ev.push({ lvl: o.price, up: true, kind: 'order', o });
      }
    }
    return ev;
  }

  checkGap(o) {
    for (let guard = 0; guard < 10; guard++) {
      const e = this.events().find(e => (e.up ? o >= e.lvl : o <= e.lvl));
      if (!e) return;
      this.fire(e, o);
    }
  }

  moveTo(target) {
    for (let guard = 0; guard < 20; guard++) {
      const up = target > this.cur;
      if (target === this.cur) return;
      let best = null, bd = Infinity;
      for (const e of this.events()) {
        if (e.up !== up) continue;
        const inside = up ? e.lvl >= this.cur && e.lvl <= target : e.lvl <= this.cur && e.lvl >= target;
        if (!inside) continue;
        const d = Math.abs(e.lvl - this.cur);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) break;
      this.fire(best, best.lvl);
      this.cur = best.lvl;
    }
    this.cur = target;
  }

  // bid = Bid-Kurs, bei dem das Ereignis passiert (Level oder Open bei Kurslücke)
  fire(e, bid) {
    const slip = this.cfg.slipPips * this.pip, spr = this.spr, p = this.pos;
    if (e.kind === 'sl') {
      const px = p.dir > 0 ? bid - slip : bid + spr + slip;
      this.closePos(px, p.slMoved ? (this.money(p.dir, p.entry, px, 1) >= 0 ? 'BE/Trail' : 'SL nachgez.') : 'SL');
    } else if (e.kind === 'tp') {
      this.closePos(p.dir > 0 ? bid : bid + spr, 'TP');
    } else {
      const o = e.o, isStop = o.type.endsWith('stop');
      const px = o.dir > 0 ? bid + spr + (isStop ? slip : 0) : bid - (isStop ? slip : 0);
      this.orders = this.orders.filter(x => x !== o && !(o.oco && x.oco === o.oco));
      this.openPos(o.dir, px, o.opts, o.label);
    }
  }

  execQueue(o) {
    const q = this.queue, slip = this.cfg.slipPips * this.pip, spr = this.spr;
    this.queue = [];
    for (const r of q) {
      if (r.kind === 'close') {
        if (this.pos) this.closePos(this.pos.dir > 0 ? o - slip : o + spr + slip, r.reason || 'Schließen');
      } else {
        if (this.pos && this.pos.dir === r.dir) continue;
        if (this.pos) this.closePos(this.pos.dir > 0 ? o - slip : o + spr + slip, 'Umkehr');
        this.openPos(r.dir, r.dir > 0 ? o + spr + slip : o - slip, r.opts, r.dir > 0 ? 'Buy' : 'Sell');
      }
    }
  }

  levels(dir, px, opts) {
    const pip = this.pip;
    let sl = opts.sl != null ? opts.sl : opts.slPips != null ? px - dir * opts.slPips * pip : opts.slDist != null ? px - dir * opts.slDist : null;
    let tp = opts.tp != null ? opts.tp : opts.tpPips != null ? px + dir * opts.tpPips * pip : opts.tpDist != null ? px + dir * opts.tpDist : null;
    if (tp == null && opts.rr != null && sl != null) tp = px + dir * opts.rr * Math.abs(px - sl);
    // wie MT5: Kurse auf die Nachkommastellen des Symbols runden
    const round = v => (v == null || !isFinite(v) ? null : +v.toFixed(this.ds.digits));
    return { sl: round(sl), tp: round(tp) };
  }

  lotsFor(opts, px, sl) {
    if (opts.lots) return opts.lots;
    const risk = opts.risk != null ? opts.risk : this.cfg.riskPct;
    if (risk > 0 && sl != null && Math.abs(px - sl) > 0) {
      const perLot = Math.abs(px - sl) * this.cfg.contract * this.conv(px);
      const lots = Math.floor(this.balance * risk / 100 / perLot / 0.01) * 0.01;
      return Math.min(100, Math.max(0.01, +lots.toFixed(2)));
    }
    return this.cfg.lots;
  }

  px(v) { return +v.toFixed(this.ds.digits + 1); }

  openPos(dir, px, opts = {}, label = '') {
    px = this.px(px);
    const { sl, tp } = this.levels(dir, px, opts);
    this.pos = {
      id: this.nextId++, dir, entry: px, lots: this.lotsFor(opts, px, sl), sl, tp, sl0: sl, tp0: tp,
      entryIdx: this.i, entryTime: this.t, comment: opts.comment || label, slMoved: false, mfe: 0, mae: 0,
    };
    // SL/TP schon auf der falschen Seite (z. B. durch Kurslücke) -> sofort prüfen
    this.checkGap(this.cur = px - (dir > 0 ? this.spr : 0));
  }

  closePos(px, reason) {
    const p = this.pos;
    if (!p) return;
    px = this.px(px);
    const comm = p.lots * this.cfg.commission;
    const gross = this.money(p.dir, p.entry, px, p.lots);
    const pnl = gross - comm;
    const risk = p.sl0 != null ? Math.abs(p.entry - p.sl0) : 0;
    this.balance += pnl;
    this.trades.push({
      id: p.id, dir: p.dir, entryIdx: p.entryIdx, exitIdx: this.i, entryTime: p.entryTime, exitTime: this.t,
      entry: p.entry, exit: px, lots: p.lots, sl0: p.sl0, tp0: p.tp0, slLast: p.sl,
      pips: p.dir * (px - p.entry) / this.pip, pnl, comm, reason, comment: p.comment,
      r: risk > 0 ? p.dir * (px - p.entry) / risk : NaN,
      mfe: p.mfe / this.pip, mae: p.mae / this.pip, balance: this.balance,
    });
    this.pos = null;
  }

  floating(bidClose, spr) {
    const p = this.pos;
    if (!p) return 0;
    const px = p.dir > 0 ? bidClose : bidClose + spr;
    return this.money(p.dir, p.entry, px, p.lots) - p.lots * this.cfg.commission;
  }

  finish(lastIdx) {
    if (this.pos && lastIdx >= 0) {
      this.i = lastIdx;
      const c = this.b.c[lastIdx];
      this.closePos(this.pos.dir > 0 ? c : c + this.spr, 'Ende');
      this.equity[lastIdx] = this.balance;
    }
  }

  // ---------- Befehle für Strategien und Replay ----------
  market(dir, opts = {}) {
    this.queue = this.queue.filter(r => r.kind !== 'open');
    this.queue.push({ kind: 'open', dir, opts });
  }

  close(reason) {
    if (this.pos || this.queue.some(r => r.kind === 'open')) {
      this.queue = this.queue.filter(r => r.kind !== 'open');
      if (this.pos) this.queue.push({ kind: 'close', reason });
    }
  }

  pending(type, price, opts = {}) {
    const c = this.b.c[this.i], spr = this.spr;
    const ok = type === 'buystop' ? price > c + spr : type === 'sellstop' ? price < c
      : type === 'buylimit' ? price < c + spr : price > c;
    const names = { buystop: 'Buy Stop', sellstop: 'Sell Stop', buylimit: 'Buy Limit', selllimit: 'Sell Limit' };
    if (!(ok && isFinite(price))) {
      this.log(`${names[type]} @ ${price} ungültig (Kurs ${c}) – Order nicht gelegt`);
      return null;
    }
    const o = {
      id: this.nextId++, type, dir: type.startsWith('buy') ? 1 : -1, price, opts, oco: opts.oco || null,
      label: names[type], placedIdx: this.i, expireIdx: opts.expireBars ? this.i + opts.expireBars : null,
    };
    this.orders.push(o);
    return o.id;
  }

  cancel(filter) {
    this.orders = this.orders.filter(o => {
      if (filter == null) return false;
      if (filter === 'buy' || filter === 'sell') return o.dir !== (filter === 'buy' ? 1 : -1);
      if (typeof filter === 'number') return o.id !== filter;
      return o.oco !== filter;
    });
  }

  setSL(price) {
    if (!this.pos || price == null || !isFinite(price)) return;
    if (price !== this.pos.sl) { this.pos.sl = price; this.pos.slMoved = true; }
  }

  setTP(price) { if (this.pos) this.pos.tp = price == null || !isFinite(price) ? null : price; }

  posView() {
    const p = this.pos;
    if (!p) return null;
    const c = this.b.c[this.i];
    const exitPx = p.dir > 0 ? c : c + this.spr;
    return {
      dir: p.dir, long: p.dir > 0, short: p.dir < 0, entry: p.entry, sl: p.sl, tp: p.tp, sl0: p.sl0, tp0: p.tp0,
      lots: p.lots, entryIdx: p.entryIdx, bars: this.i - p.entryIdx, comment: p.comment,
      pips: p.dir * (exitPx - p.entry) / this.pip, profit: this.floating(c, this.spr),
    };
  }
}

// ---------- Auswertung ----------
function computeStats(eng, from, to) {
  const tr = eng.trades, cfg = eng.cfg;
  const s = { trades: tr.length, net: 0, grossWin: 0, grossLoss: 0, wins: 0, losses: 0, pips: 0, comm: 0,
    longN: 0, longWin: 0, longNet: 0, shortN: 0, shortWin: 0, shortNet: 0, rSum: 0, rN: 0,
    maxConsLoss: 0, maxConsWin: 0, avgBars: 0, maxDD: 0, maxDDPct: 0, capital: cfg.capital };
  let cl = 0, cw = 0, bars = 0;
  for (const t of tr) {
    s.net += t.pnl; s.pips += t.pips; s.comm += t.comm; bars += t.exitIdx - t.entryIdx;
    if (t.pnl > 0) { s.wins++; s.grossWin += t.pnl; cw++; cl = 0; } else { s.losses++; s.grossLoss -= t.pnl; cl++; cw = 0; }
    s.maxConsLoss = Math.max(s.maxConsLoss, cl); s.maxConsWin = Math.max(s.maxConsWin, cw);
    if (t.dir > 0) { s.longN++; s.longNet += t.pnl; if (t.pnl > 0) s.longWin++; }
    else { s.shortN++; s.shortNet += t.pnl; if (t.pnl > 0) s.shortWin++; }
    if (!isNaN(t.r)) { s.rSum += t.r; s.rN++; }
  }
  s.winrate = tr.length ? s.wins / tr.length * 100 : 0;
  s.pf = s.grossLoss > 0 ? s.grossWin / s.grossLoss : s.grossWin > 0 ? Infinity : 0;
  s.avgWin = s.wins ? s.grossWin / s.wins : 0;
  s.avgLoss = s.losses ? s.grossLoss / s.losses : 0;
  s.expectancy = tr.length ? s.net / tr.length : 0;
  s.avgR = s.rN ? s.rSum / s.rN : NaN;
  s.avgBars = tr.length ? bars / tr.length : 0;
  s.netPct = s.net / cfg.capital * 100;
  // Drawdown auf Basis der Kontokurve je Kerze (inkl. offener Trades)
  let peak = cfg.capital;
  const eq = eng.equity;
  for (let i = from; i <= to; i++) {
    const v = eq[i];
    if (isNaN(v)) continue;
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > s.maxDD) { s.maxDD = dd; s.maxDDPct = dd / peak * 100; }
  }
  s.recovery = s.maxDD > 0 ? s.net / s.maxDD : s.net > 0 ? Infinity : 0;
  return s;
}
