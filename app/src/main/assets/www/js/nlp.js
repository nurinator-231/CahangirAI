/* nlp.js — Azərbaycan dili üçün yüngül, asılılıqsız anlayış mühərriki (tam oflayn).
   Vaxt/tarix analizi, tapşırıq mətninin ayrılması, kalkulyator, tarix formatları. */
(function (root) {
  'use strict';

  /* ---------- mətn normallaşdırma ---------- */
  const MAP = { 'ə': 'e', 'ı': 'i', 'ö': 'o', 'ü': 'u', 'ş': 's', 'ç': 'c', 'ğ': 'g' };
  function lower(s) { return String(s).replace(/İ/g, 'i').replace(/I/g, 'ı').toLowerCase(); }
  /* fold: diakritiksiz kiçik hərf (uzunluq saxlanılır) — "xatırlat" == "xatirlat" */
  function fold(s) { return lower(s).replace(/[əıöüşçğ]/g, c => MAP[c]); }
  function clean(w) {
    return w.replace(/^[("'“«\[]+/, '').replace(/[,;!?)"'”»\]]+$/, '').replace(/[.:]+$/, '');
  }
  function tokenize(text) {
    const toks = []; const re = /\S+/g; let m;
    while ((m = re.exec(text))) toks.push({ raw: m[0], f: clean(fold(m[0])) });
    return toks;
  }
  function capAz(w) {
    if (!w) return w;
    const first = w[0] === 'i' ? 'İ' : w[0] === 'ı' ? 'I' : w[0].toUpperCase();
    return first + lower(w.slice(1));
  }

  /* ---------- sayılar ---------- */
  const UNIT = { bir: 1, iki: 2, uc: 3, dord: 4, bes: 5, alti: 6, yeddi: 7, sekkiz: 8, doqquz: 9 };
  const TEN = { on: 10, iyirmi: 20, otuz: 30, qirx: 40, elli: 50, altmis: 60, yetmis: 70, seksen: 80, doxsan: 90 };
  const SUFS = ['da', 'de', 'ya', 'ye', 'a', 'e', 'dan', 'den'];

  function wordNum(f) {
    if (f in UNIT) return { v: UNIT[f], suf: '', base: f };
    if (f in TEN) return { v: TEN[f], suf: '', base: f };
    for (const s of SUFS) {
      if (f.length > s.length && f.endsWith(s)) {
        const b = f.slice(0, -s.length);
        if (b in UNIT) return { v: UNIT[b], suf: s, base: b };
        if (b in TEN) return { v: TEN[b], suf: s, base: b };
      }
    }
    return null;
  }
  const TU = [
    [/^saniy/, 1000], [/^(deqiqe|deq$|dq$|dk$)/, 60000], [/^saat/, 3600000],
    [/^gun/, 'd'], [/^hefte/, 'w']
  ];
  function timeUnit(f) { for (const [re, ms] of TU) if (re.test(f)) return ms; return null; }
  function numCtx(prev, after) {
    if (/^(saat|seher|axsam|gece|gunorta|gunduz)/.test(prev)) return true;
    return !!after && timeUnit(after) !== null;
  }

  /* sözlə yazılmış sayları rəqəmə çevirib "vahidlər" siyahısı qaytarır */
  function mergeNumbers(toks) {
    const U = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]; const prev = i ? toks[i - 1].f : '';
      const dm = /^(\d{1,3})(?:-?(da|de|ya|ye|a|e))?$/.exec(t.f);
      if (dm) { U.push({ f: t.f, idx: [i], num: +dm[1], suf: dm[2] || '', hyph: t.f.includes('-') }); continue; }
      const w = wordNum(t.f);
      if (w) {
        let v = w.v, suf = w.suf; const idx = [i]; let j = i;
        if (w.base in TEN && !w.suf && toks[i + 1]) {
          const n2 = wordNum(toks[i + 1].f);
          if (n2 && n2.base in UNIT) { v += n2.v; suf = n2.suf; idx.push(i + 1); j = i + 1; }
        }
        const after = toks[j + 1] ? toks[j + 1].f : '';
        if (numCtx(prev, after)) {
          U.push({ f: String(v) + (suf ? '-' + suf : ''), idx, num: v, suf, hyph: !!suf, word: true });
          i = j; continue;
        }
      }
      if (/^yarim/.test(t.f)) { U.push({ f: t.f, idx: [i], half: true }); continue; }
      U.push({ f: t.f, idx: [i] });
    }
    return U;
  }

  /* ---------- tarix sabitləri ---------- */
  const MONTHS = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'İyun', 'İyul', 'Avqust', 'Sentyabr', 'Oktyabr', 'Noyabr', 'Dekabr'];
  const MONTHF = MONTHS.map(fold);
  const WEEKDAYS = ['Bazar', 'Bazar ertəsi', 'Çərşənbə axşamı', 'Çərşənbə', 'Cümə axşamı', 'Cümə', 'Şənbə'];
  const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const pad = n => String(n).padStart(2, '0');
  const clock = d => pad(d.getHours()) + ':' + pad(d.getMinutes());
  const dayDiff = (a, b) => Math.round((sod(a) - sod(b)) / 86400000);

  function wdayAt(U, k) {
    const a = U[k].f, b = (U[k + 1] || {}).f || '';
    if (a === 'bazar' && /^ertes/.test(b)) return { w: 1, len: 2 };
    if (/^cersenbe/.test(a)) return /^axsam/.test(b) ? { w: 2, len: 2 } : { w: 3, len: 1 };
    if (/^cume/.test(a)) return /^axsam/.test(b) ? { w: 4, len: 2 } : { w: 5, len: 1 };
    if (/^senbe/.test(a)) return { w: 6, len: 1 };
    if (/^bazar(a|da)?$/.test(a) && /^gun/.test(b)) return { w: 0, len: 2 };
    return null;
  }
  const periodOf = f => /^seher/.test(f) ? 'm' : /^gunorta/.test(f) ? 'n' : /^gunduz/.test(f) ? 'd'
    : /^axsam/.test(f) ? 'e' : /^gece/.test(f) ? 'g' : null;

  /* ---------- əsas: vaxt analizi ---------- */
  function parseWhen(text, nowDate, opts) {
    opts = opts || {};
    const now = nowDate ? new Date(nowDate) : new Date();
    const toks = tokenize(text); const U = mergeNumbers(toks);
    const used = new Set(); const mark = u => u.idx.forEach(i => used.add(i));
    let relMs = 0, relDays = 0, relFound = false;
    let hour = null, minute = 0, lit = false, hourK = -1;
    let dayOff = null, wday = null, dateSel = null, repeat = null;
    const periodKs = [];

    for (let k = 0; k < U.length; k++) {
      const u = U[k], f = u.f, nx = U[k + 1], nf = nx ? nx.f : '';
      /* təkrar */
      if (f === 'her' || f === 'hergun' || f === 'gundelik') {
        if (f !== 'her') { repeat = { type: 'daily' }; mark(u); continue; }
        if (nx && nx.num !== undefined && U[k + 2] && timeUnit(U[k + 2].f) !== null) {
          const tu = timeUnit(U[k + 2].f); const mult = tu === 'd' ? 86400000 : tu === 'w' ? 604800000 : tu;
          repeat = { type: 'interval', ms: nx.num * mult };
          mark(u); mark(nx); mark(U[k + 2]); k += 2;
          if (U[k + 1] && (U[k + 1].f === 'bir' || (U[k + 1].word && U[k + 1].num === 1))) { mark(U[k + 1]); k++; }
          relFound = true; relMs = repeat.ms; continue;
        }
        if (/^gun/.test(nf)) { repeat = { type: 'daily' }; mark(u); mark(nx); k++; continue; }
        if (/^hefte/.test(nf)) { repeat = { type: 'weekly', wday: null }; mark(u); mark(nx); k++; continue; }
        const wd = nx && wdayAt(U, k + 1);
        if (wd) {
          repeat = { type: 'weekly', wday: wd.w }; wday = wd.w; mark(u);
          for (let q = 1; q <= wd.len; q++) mark(U[k + q]);
          k += wd.len;
          if (U[k + 1] && /^gun/.test(U[k + 1].f)) { mark(U[k + 1]); k++; }
          continue;
        }
        if (nf === 'bazar') { repeat = { type: 'weekly', wday: 0 }; wday = 0; mark(u); mark(nx); k++; continue; }
        if (periodOf(nf)) { repeat = { type: 'daily' }; mark(u); continue; }
        continue;
      }
      /* gün sözləri */
      if (f === 'bugun') { dayOff = 0; mark(u); continue; }
      if (f === 'bu' && nx && (/^gun$/.test(nf))) { dayOff = 0; mark(u); mark(nx); k++; continue; }
      if (f === 'bu' && nx && periodOf(nf)) { dayOff = 0; mark(u); continue; }
      if (/^sabah(a|ki)?$/.test(f)) { dayOff = 1; mark(u); continue; }
      if (f === 'birisigun' || f === 'birisi' || (f === 'o' && nf === 'biri' && U[k + 2] && /^gun/.test(U[k + 2].f))) {
        dayOff = 2; mark(u);
        if (f === 'o') { mark(nx); mark(U[k + 2]); k += 2; } else if (nx && /^gun/.test(nf)) { mark(nx); k++; }
        continue;
      }
      const wd = wdayAt(U, k);
      if (wd) {
        wday = wd.w; for (let q = 0; q < wd.len; q++) mark(U[k + q]); k += wd.len - 1;
        if (U[k + 1] && /^gun/.test(U[k + 1].f)) { mark(U[k + 1]); k++; }
        continue;
      }
      /* tarix: 15 noyabr */
      if (u.num !== undefined && u.num >= 1 && u.num <= 31 && nx) {
        const mi = MONTHF.findIndex(m => nf.startsWith(m));
        if (mi >= 0) {
          dateSel = { d: u.num, m: mi + 1, y: null }; mark(u); mark(nx); k++;
          if (U[k + 1] && U[k + 1].num >= 2000 && !U[k + 1].suf) { dateSel.y = U[k + 1].num; mark(U[k + 1]); k++; }
          continue;
        }
      }
      /* tarix: 15.11.2026 / 15/11 / 25.11 */
      let dm = /^(\d{1,2})([./])(\d{1,2})(?:[./](\d{2,4}))?(?:-?(?:da|de|ya|ye|a|e))?$/.exec(f);
      if (dm) {
        const a = +dm[1], b = +dm[3], hasY = !!dm[4];
        const looksTime = dm[2] === '.' && !hasY && a <= 23 && b <= 59;
        if (!looksTime && b >= 1 && b <= 12 && a >= 1 && a <= 31) {
          let y = hasY ? +dm[4] : null; if (y !== null && y < 100) y += 2000;
          dateSel = { d: a, m: b, y }; mark(u); continue;
        }
      }
      /* saat 19:00 / 19:00 / 19.30-da */
      const tm = /^(\d{1,2})[:.](\d{2})(?:-?(?:da|de|ya|ye|a|e|dek|qeder))?$/.exec(f);
      if (tm && +tm[1] <= 24 && +tm[2] <= 59) {
        hour = +tm[1]; minute = +tm[2]; lit = tm[1].length === 2 && tm[1][0] === '0' || hour === 0 || hour >= 13; hourK = k;
        mark(u); if (k > 0 && U[k - 1].f === 'saat') mark(U[k - 1]); continue;
      }
      /* "saat 7", "saat 7 yarım", "saat yeddidə" */
      if (f === 'saat' && nx && nx.num !== undefined && nx.num <= 24 && !(U[k + 2] && timeUnit(U[k + 2].f) !== null && !U[k + 2].half)) {
        hour = nx.num; minute = 0; lit = hour === 0 || hour >= 13; hourK = k + 1;
        mark(u); mark(nx); k++;
        const h2 = U[k + 1];
        if (h2 && h2.half) { minute = 30; mark(h2); k++; }
        else if (h2 && h2.num !== undefined && h2.num <= 59 && !h2.suf && (!U[k + 2] || timeUnit(U[k + 2].f) === null) && String(h2.num).length === 2 && !h2.word) {
          minute = h2.num; mark(h2); k++;
        }
        continue;
      }
      /* nisbi: 30 dəqiqə sonra / yarım saat / 2 saatdan sonra */
      if ((u.num !== undefined || u.half) && nx && timeUnit(nf) !== null) {
        const n = u.half ? 0.5 : u.num; const tu = timeUnit(nf);
        if (tu === 'd') relDays += n; else if (tu === 'w') relDays += 7 * n; else relMs += n * tu;
        relFound = true; mark(u); mark(nx); k++;
        if (U[k + 1] && U[k + 1].f === 'sonra') { mark(U[k + 1]); k++; }
        continue;
      }
      /* "7-də" (defisli) tək saat */
      if (u.num !== undefined && u.hyph && /^(de|da)$/.test(u.suf) && u.num <= 24 && hour === null &&
          !(nx && timeUnit(nf) !== null)) {
        hour = u.num; minute = 0; lit = hour === 0 || hour >= 13; hourK = k; mark(u); continue;
      }
      if (periodOf(f)) periodKs.push(k);
    }

    /* dövr sözləri (səhər/axşam/gecə...) — yalnız lazım olanda silinir */
    let period = null;
    for (const k of periodKs) {
      const u = U[k]; const p = periodOf(u.f);
      const adjacentHour = hourK >= 0 && (k === hourK + 1 || k === hourK - 1 || (k === hourK - 2 && U[k + 1] && U[k + 1].f === 'saat'));
      /* "axşam 7" / "səhər saat 8" — saatdan əvvəl gələn dövr */
      const nextIsHour = U[k + 1] && (U[k + 1].num !== undefined || U[k + 1].f === 'saat');
      if (hour === null || (!lit && (adjacentHour || nextIsHour)) ) {
        /* saat yoxdur və ya ona bitişikdir → vaxt sözü kimi qəbul et */
        if (hour === null || adjacentHour || nextIsHour) { period = p; mark(u); }
      } else if (U[k - 1] && (U[k - 1].f === 'her' || U[k - 1].f === 'bu' || U[k - 1].f === 'sabah')) {
        period = p; mark(u);
      }
    }
    /* "axşam 7" kimi hallarda saat dövrdən sonra gəlir (nextIsHour) və hələ tapılmayıbsa */
    if (hour === null && period) {
      for (const k of periodKs) {
        const nx = U[k + 1]; const nn = U[k + 2];
        if (nx && nx.num !== undefined && nx.num <= 24 && !(nn && timeUnit(nn.f) !== null)) {
          hour = nx.num; minute = 0; mark(nx);
          if (nn && nn.half) { minute = 30; mark(nn); }
          break;
        }
        if (nx && nx.f === 'saat' && nn && nn.num !== undefined && nn.num <= 24) {
          hour = nn.num; minute = 0; mark(nx); mark(nn); break;
        }
      }
    }

    const res = { ts: null, dateOnly: null, repeat, hasTime: false, past: false, relative: false, used, explicitDay: false };
    if (relDays > 0 && relMs === 0 && hour === null && !period && dayOff === null && wday === null && !dateSel) {
      dayOff = relDays; relFound = false; relDays = 0;
    }
    if (relFound && relMs + relDays * 86400000 > 0 && hour === null && !period && wday === null && !dateSel && dayOff === null) {
      res.ts = now.getTime() + relMs + relDays * 86400000; res.hasTime = true; res.relative = true;
      return res;
    }

    let day = sod(now);
    let explicitDay = dayOff !== null || wday !== null || !!dateSel;
    if (opts.baseDay) { day = sod(new Date(opts.baseDay)); explicitDay = true; }
    else if (dateSel) {
      day = new Date(dateSel.y !== null ? dateSel.y : now.getFullYear(), dateSel.m - 1, dateSel.d);
      if (dateSel.y === null && day < sod(now)) day.setFullYear(day.getFullYear() + 1);
    } else if (wday !== null) day.setDate(day.getDate() + ((wday - now.getDay() + 7) % 7));
    else if (dayOff !== null) day.setDate(day.getDate() + dayOff);
    res.explicitDay = explicitDay;

    let h = hour, m = minute;
    if (h === null && period) { h = { m: 8, n: 12, d: 14, e: 19, g: 23 }[period]; m = 0; lit = true; }
    if (h === null) {
      if (explicitDay || repeat) res.dateOnly = day;
      if (repeat && repeat.type === 'weekly' && repeat.wday === null) repeat.wday = day.getDay();
      return res;
    }
    res.hasTime = true;
    let amb = false;
    if (h === 24) { h = 0; day.setDate(day.getDate() + 1); lit = true; }
    if (period && !lit && h >= 1 && h <= 12) {
      if (period === 'n' && h >= 1 && h <= 6) h += 12;
      else if (period === 'd' && h <= 11) h += 12;
      else if (period === 'e') { if (h <= 11) h += 12; else { h = 0; day.setDate(day.getDate() + 1); } }
      else if (period === 'g') { if (h === 12) { h = 0; day.setDate(day.getDate() + 1); } else if (h >= 6) h += 12; }
    } else if (!period && !lit && h >= 1 && h <= 12) amb = true;

    const at = (d, hh) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, m, 0, 0);
    let cand;
    if (amb) {
      if (!explicitDay) {
        const c1 = at(day, h === 12 ? 12 : h);
        const c2 = h === 12 ? at(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1), 0) : at(day, h + 12);
        cand = [c1, c2].find(c => c > now);
        if (!cand) { const t = new Date(day); t.setDate(t.getDate() + 1); cand = at(t, h === 12 ? 12 : h); }
      } else {
        cand = at(day, h >= 7 && h <= 11 ? h : h === 12 ? 12 : h + 12);
      }
    } else {
      cand = at(day, h);
      if (cand <= now) {
        if (!explicitDay) cand.setDate(cand.getDate() + 1);
        else if (wday !== null && !dateSel && dayOff === null && !opts.baseDay) cand.setDate(cand.getDate() + 7);
        else res.past = true;
      }
    }
    if (repeat && repeat.type === 'weekly' && repeat.wday === null) repeat.wday = cand.getDay();
    if (repeat && repeat.type === 'daily' && cand <= now) cand.setDate(cand.getDate() + 1);
    res.ts = cand.getTime();
    return res;
  }

  /* ---------- tapşırıq mətni ---------- */
  const STOP = /^(xatirla\w*|yadima|sal|mene|meni|zehmet|olmasa|lutfen|alarm|qur|quraq|oyat|ki|taymer\w*|geri|sayim)$/;
  function extractTask(text, used, extraStop) {
    const toks = tokenize(text); const out = [];
    for (let i = 0; i < toks.length; i++) {
      if (used && used.has(i)) continue;
      if (STOP.test(toks[i].f)) continue;
      if (extraStop && extraStop.test(toks[i].f)) continue;
      out.push(toks[i].raw);
    }
    return out.join(' ').replace(/^[\s:,.\-–]+|[\s:,.\-–]+$/g, '').replace(/\s{2,}/g, ' ');
  }

  /* ---------- formatlar ---------- */
  function fmtWhen(ts, nowDate) {
    const d = new Date(ts), n = nowDate ? new Date(nowDate) : new Date(); const df = dayDiff(d, n);
    const hm = clock(d);
    if (df === 0) return 'bu gün ' + hm;
    if (df === 1) return 'sabah ' + hm;
    if (df === -1) return 'dünən ' + hm;
    if (df > 1 && df < 7) return WEEKDAYS[d.getDay()] + ' ' + hm;
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== n.getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + hm;
  }
  function fmtDate(nowDate) {
    const d = nowDate ? new Date(nowDate) : new Date();
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + WEEKDAYS[d.getDay()].toLowerCase();
  }
  function fmtDuration(ms) {
    let s = Math.round(ms / 1000); const parts = [];
    const d = Math.floor(s / 86400); s -= d * 86400; const h = Math.floor(s / 3600); s -= h * 3600;
    const mi = Math.floor(s / 60); s -= mi * 60;
    if (d) parts.push(d + ' gün'); if (h) parts.push(h + ' saat'); if (mi) parts.push(mi + ' dəqiqə'); if (s) parts.push(s + ' saniyə');
    return parts.join(' ') || '0 saniyə';
  }
  function fmtRepeat(r) {
    if (!r) return '';
    if (r.type === 'daily') return 'hər gün';
    if (r.type === 'weekly') return 'hər ' + WEEKDAYS[r.wday != null ? r.wday : 0].toLowerCase();
    if (r.type === 'interval') return 'hər ' + fmtDuration(r.ms);
    return '';
  }
  /* təkrarlanan xatırlatmanın növbəti vaxtı (now-dan sonra) */
  function nextDue(due, repeat, nowMs) {
    if (!repeat) return null;
    let d = new Date(due); let guard = 0;
    const step = () => {
      if (repeat.type === 'daily') d.setDate(d.getDate() + 1);
      else if (repeat.type === 'weekly') d.setDate(d.getDate() + 7);
      else if (repeat.type === 'interval') d = new Date(d.getTime() + Math.max(60000, repeat.ms));
    };
    do { step(); guard++; } while (d.getTime() <= nowMs && guard < 5000);
    return d.getTime();
  }

  /* ---------- təhlükəsiz kalkulyator ---------- */
  function evalExpr(s) {
    const t = s.match(/\d+(?:\.\d+)?|[-+*/^()]/g);
    if (!t || t.join('').length < s.replace(/\s/g, '').length) return null;
    let p = 0;
    const peek = () => t[p];
    function prim() {
      const x = t[p++];
      if (x === undefined) throw 0;
      if (x === '(') { const v = add(); if (t[p++] !== ')') throw 0; return v; }
      if (x === '-') return -pow();
      if (x === '+') return pow();
      if (/^\d/.test(x)) return parseFloat(x);
      throw 0;
    }
    function pow() { let b = prim(); if (peek() === '^') { p++; b = Math.pow(b, pow()); } return b; }
    function mul() {
      let v = pow();
      while (peek() === '*' || peek() === '/') { const o = t[p++]; const r = pow(); v = o === '*' ? v * r : v / r; }
      return v;
    }
    function add() {
      let v = mul();
      while (peek() === '+' || peek() === '-') { const o = t[p++]; const r = mul(); v = o === '+' ? v + r : v - r; }
      return v;
    }
    try { const v = add(); if (p !== t.length || !isFinite(v)) return null; return v; } catch (e) { return null; }
  }
  function fmtNum(n) { return String(+n.toFixed(8)).replace('.', ','); }
  function calc(text) {
    let s = fold(text).replace(/(\d),(\d)/g, '$1.$2');
    /* faiz: "150-nin 20 faizi" / "20 faiz 150" */
    let pm = /(\d+(?:\.\d+)?)\s*-?\s*(?:nin|nun|in|un|ın)?\s+(\d+(?:\.\d+)?)\s*faiz/.exec(s);
    if (pm) { const v = parseFloat(pm[1]) * parseFloat(pm[2]) / 100; return { expr: pm[2] + '% × ' + pm[1], value: v, text: fmtNum(v) }; }
    pm = /(\d+(?:\.\d+)?)\s*(?:faiz|%)\s*(?:-?\w*)\s+(\d+(?:\.\d+)?)/.exec(s);
    if (pm) { const v = parseFloat(pm[1]) * parseFloat(pm[2]) / 100; return { expr: pm[1] + '% × ' + pm[2], value: v, text: fmtNum(v) }; }
    s = s.replace(/\b(ustegel|arti|plus)\b/g, ' + ')
      .replace(/\b(cixilsin|cixsin|cixsa|cixmaq|cix|minus|eksi)\b/g, ' - ')
      .replace(/\b(vurulsun|vursaq|vursa|vur|defe|vuruldu)\b/g, ' * ')
      .replace(/\b(bolunsun|bolsun|bolsek|bolsa|bol)\b/g, ' / ')
      .replace(/[×x]/g, m => m === 'x' ? ' * ' : ' * ').replace(/÷/g, ' / ');
    const runs = s.match(/[\d(][\d.+\-*\/^()\s]*[\d)]/g);
    if (!runs) return null;
    runs.sort((a, b) => b.length - a.length);
    for (const r of runs) {
      if (!/[+*\/^]|\s-\s|\d\s*-\s*\d/.test(r)) continue;
      if (/\d-\d/.test(r) && !/\s-\s/.test(r) && !/[+*\/^]/.test(r)) continue; /* tarix kimi 2026-11-01 */
      const v = evalExpr(r);
      if (v !== null) return { expr: r.replace(/\s+/g, ' ').trim(), value: v, text: fmtNum(v) };
    }
    return null;
  }

  const api = {
    fold, lower, tokenize, capAz, parseWhen, extractTask, fmtWhen, fmtDate, fmtDuration, fmtRepeat, nextDue,
    calc, evalExpr, timeUnit, MONTHS, WEEKDAYS, clock, pad, dayDiff, sod
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CahangirNLP = api;
})(typeof window !== 'undefined' ? window : globalThis);
