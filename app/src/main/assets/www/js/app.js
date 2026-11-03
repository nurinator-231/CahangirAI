/* app.js — Cahangir: interfeys, səsli xatırlatma mühərriki, səs giriş/çıxışı, ayarlar. Tam oflayn. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const N = window.CahangirNLP, Brain = window.CahangirBrain, LLM = window.CahangirLLM;
  const APP_VERSION = '3.0';
  const THEMES = { blue: [58, 160, 255], violet: [155, 123, 255], green: [47, 224, 160], amber: [255, 180, 84] };

  let storage = null;
  try { storage = window.localStorage; storage.setItem('__t', '1'); storage.removeItem('__t'); } catch (e) { storage = null; }
  const store = window.CahangirStore.create(storage);

  const S = { mode: 'idle', view: 'chat', session: { pending: null }, audioReady: false, speaking: false, utts: [], missedSaid: false };
  const firing = new Map();
  let ringTimer = null, ringN = 0, rec = null, recLang = 'az-AZ';

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const eff = it => (it.snooze && it.snooze > 0) ? it.snooze : it.due;
  const KMAP = { rem: 'reminders', mem: 'memory', prj: 'projects' };

  const env = {
    store, session: S.session, now: () => new Date(),
    firing: () => [...firing.keys()], ack: () => ackAll(), snooze: ms => snoozeAll(ms),
    setVoice: v => { store.setSetting('voice', v); syncSettings(); }, changed: () => renderAll(), llm: llmAdapter
  };

  /* ================= kiçik köməkçilər ================= */
  let toastT = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function addMsg(text, user, cls, ts) {
    const d = document.createElement('div');
    d.className = 'msg' + (user ? ' u' : '') + (cls ? ' ' + cls : '');
    d.textContent = text;
    if (cls !== 'sys') { const mt = document.createElement('span'); mt.className = 'mt'; mt.textContent = N.clock(new Date(ts || Date.now())); d.appendChild(mt); }
    const c = $('chat'); c.appendChild(d); c.scrollTop = c.scrollHeight;
    while (c.children.length > 80) c.removeChild(c.firstChild);
  }
  function setMode(m) {
    S.mode = m;
    $('stl').textContent = { idle: 'Hazır vəziyyətdə', listening: 'Dinləyirəm…', thinking: 'Düşünürəm…', speaking: 'Danışıram…' }[m];
    $('st').textContent = '● ' + { idle: 'Hazır', listening: 'Dinləyir', thinking: 'Düşünür', speaking: 'Danışır' }[m];
  }

  /* ================= naviqasiya ================= */
  const ALL_VIEWS = ['dash', 'chat', 'ftr', 'clip', 'conn', 'rem', 'mem', 'prj', 'sys', 'set'];
  function go(v) {
    S.view = v;
    document.querySelectorAll('.nav[data-v]').forEach(b => {
      b.classList.toggle('on', b.dataset.v === v);
      if (b.classList.contains('on')) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    ALL_VIEWS.forEach(k => {
      const el = $('v-' + k);
      if (el) el.classList.toggle('hide', k !== v);
    });
    $('composer').classList.toggle('hide', v !== 'chat');
    renderAll();
    if (v === 'chat') { const c = $('chat'); c.scrollTop = c.scrollHeight; }
    if (v === 'set') syncSettings();
    updateHint();
  }
  document.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => go(b.dataset.v)));

  /* ================= vaxt / saat ================= */
  let lastMinute = -1;
  function tick() {
    const d = new Date(); const mk = d.getHours() * 60 + d.getMinutes();
    if (mk !== lastMinute) {
      lastMinute = mk;
      $('clk').textContent = N.clock(d);
      $('dt').textContent = d.getDate() + ' ' + N.MONTHS[d.getMonth()] + ' ' + d.getFullYear();
      $('dw').textContent = N.WEEKDAYS[d.getDay()];
      renderToday(); renderHero();
    }
    if (S.view === 'chat' && d.getSeconds() % 15 === 0) renderHero();
    checkReminders(d.getTime());
  }
  function net() {
    const on = navigator.onLine;
    $('ot').textContent = on ? 'Onlayn' : 'Oflayn rejim';
    $('os').textContent = on ? 'İnternet var' : 'İnternet tələb olunmur';
    $('od').classList.toggle('off', !on);
    $('sx').textContent = on ? 'Onlayn' : 'Oflayn';
  }

  /* ================= siyahıların çəkilişi ================= */
  function badgeFor(it) {
    if (firing.has(it.id)) return '<span class="badge ring">çalır</span>';
    if (!it.done && it.firedAt && it.kind === 'reminders') return '<span class="badge late">vaxtı keçib</span>';
    return '';
  }
  function metaFor(it, now) {
    const parts = [];
    if (it.kind === 'reminders') {
      if (it.timer) parts.push('⏱ taymer');
      parts.push(eff(it) ? N.fmtWhen(eff(it), now) : 'vaxtsız');
      if (it.repeat) parts.push('🔁 ' + N.fmtRepeat(it.repeat));
    }
    return parts.join(' · ');
  }
  function itemHTML(it, now, opts) {
    opts = opts || {}; const meta = metaFor(it, now);
    return '<div class="it ' + (it.done ? 'd' : '') + '" data-id="' + it.id + '">' +
      (opts.check ? '<input type="checkbox" data-act="toggle" aria-label="Tamamlandı" ' + (it.done ? 'checked' : '') + '>' : '') +
      '<div class="tx">' + esc(it.text) + badgeFor(it) + (meta ? '<span class="meta">' + esc(meta) + '</span>' : '') + '</div>' +
      (it.kind === 'reminders' && !it.done ? '<button type="button" data-act="snz" title="10 dəq. sonraya" aria-label="10 dəqiqə sonraya">💤</button>' : '') +
      '<button type="button" data-act="edit" title="Düzəliş" aria-label="Düzəliş">✎</button>' +
      '<button type="button" data-act="del" title="Sil" aria-label="Sil">✕</button></div>';
  }
  function renderRem() {
    const now = new Date(); const all = store.items('reminders');
    const late = all.filter(i => !i.done && i.firedAt).sort((a, b) => eff(a) - eff(b));
    const wait = all.filter(i => !i.done && !i.firedAt).sort((a, b) => (eff(a) || 9e15) - (eff(b) || 9e15));
    const done = all.filter(i => i.done).sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0)).slice(0, 10);
    let h = '';
    if (late.length) h += '<div class="sect">Vaxtı keçən / çalan</div>' + late.map(i => itemHTML(i, now, { check: true })).join('');
    h += '<div class="sect">Gözləyən</div>' + (wait.length ? wait.map(i => itemHTML(i, now, { check: true })).join('') : '<div class="empty">Gözləyən xatırlatma yoxdur. Yuxarıya yaz: “sabah saat 9-da toplantı xatırlat”.</div>');
    if (done.length) h += '<div class="sect">Tamamlanıb</div>' + done.map(i => itemHTML(i, now, { check: true })).join('');
    $('remList').innerHTML = h;
  }
  function renderMem() {
    const l = store.items('memory');
    $('memList').innerHTML = l.length ? l.slice().reverse().map(i => itemHTML(i, new Date(), {})).join('') :
      '<div class="empty">Hələ boşdur. “yadda saxla: …” yaz və ya yuxarıdakı sahəyə əlavə et.</div>';
    if (document.activeElement !== $('profName')) $('profName').value = store.profile.name || '';
  }
  function renderPrj() {
    const l = store.items('projects');
    $('prjList').innerHTML = l.length ? l.map(i => itemHTML(i, new Date(), { check: true })).join('') :
      '<div class="empty">Hələ boşdur. Yuxarıya yaz və ya söhbətdə “layihə …” de.</div>';
  }
  function renderToday() {
    const now = new Date();
    const all = store.items('reminders').filter(i => !i.done && eff(i));
    const late = all.filter(i => i.firedAt).length;
    const up = all.filter(i => !i.firedAt).sort((a, b) => eff(a) - eff(b)).slice(0, 5);
    let h = late ? '<div class="rem"><span class="dot off"></span>' + late + ' vaxtı keçmiş</div>' : '';
    h += up.length ? up.map(x => '<div class="rem"><span class="dot" style="background:var(--acc);box-shadow:none"></span><span>' + esc(x.text) + '</span><time>' + esc(N.fmtWhen(eff(x), now)) + '</time></div>').join('')
      : (late ? '' : '<div class="empty">Gözləyən xatırlatma yoxdur. Məsələn: “xatırlat 19:00 idman”.</div>');
    $('today').innerHTML = h;
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
  function ringSVG(frac, warn) {
    const f = Math.max(0, Math.min(1, frac)) * 100;
    return '<svg class="rg" viewBox="0 0 36 36" aria-hidden="true"><circle class="bg" cx="18" cy="18" r="15.9155"/><circle class="fg" cx="18" cy="18" r="15.9155" style="stroke-dasharray:' + f.toFixed(1) + ' 100"/></svg>';
  }
  function renderHero() {
    const h = $('hero'); if (!h) return;
    const now = new Date(), t0 = startOfDay(now), t1 = t0 + 864e5;
    const doneToday = store.logToday(now);
    const pend = store.items('reminders').filter(i => !i.done && eff(i) && eff(i) >= t0 && eff(i) < t1);
    const total = doneToday.length + pend.length;
    const upc = store.items('reminders').filter(i => !i.done && !i.firedAt && eff(i) && eff(i) > now.getTime()).sort((a, b) => eff(a) - eff(b))[0];
    const focus = store.items('reminders').filter(i => i.timer && i.text === 'Fokus' && !i.done && !i.firedAt && eff(i) > now.getTime())[0];
    let t3;
    if (focus) {
      const left = Math.max(0, eff(focus) - now.getTime());
      t3 = '<button class="tile" type="button" data-go="rem">' + ringSVG(1 - left / 1500000) + '<span class="tt"><small>Fokus</small><b>davam edir</b><span>' + N.pad(Math.floor(left / 60000)) + ':' + N.pad(Math.floor(left / 1000) % 60) + '</span></span></button>';
    } else t3 = '<button class="tile" type="button" data-send="fokus">' + ringSVG(0) + '<span class="tt"><small>Fokus</small><b>25 dəqiqə</b><span>başlat ▸</span></span></button>';
    h.innerHTML =
      '<button class="tile" type="button" data-go="rem">' + ringSVG(total ? doneToday.length / total : 0) + '<span class="tt"><small>Bu gün</small><b>' + doneToday.length + ' / ' + total + ' tamam</b><span>' + (pend.length ? pend.length + ' qalıb' : (total ? 'hamısı bitdi ✓' : 'plan boşdur')) + '</span></span></button>' +
      '<button class="tile' + (upc ? '' : '') + '" type="button" data-go="rem">' + ringSVG(0) + '<span class="tt"><small>Növbəti</small><b>' + (upc ? esc(upc.timer ? (upc.text === 'Taymer' ? 'Taymer' : upc.text) : upc.text) : 'Yoxdur') + '</b><span>' + (upc ? esc(N.fmtWhen(eff(upc), now)) : 'rahat ol') + '</span></span></button>' + t3;
    renderTimeline(now, t0, doneToday, store.items('reminders'));
  }
  function renderTimeline(now, t0, doneToday, rems) {
    const tl = $('tl'); if (!tl) return;
    const pos = ts => ((ts - t0) / 864e5 * 100).toFixed(2);
    let h = '<div class="now"></div>';
    [0, 6, 12, 18, 24].forEach(x => { h += '<span class="tk" style="left:' + (x / 24 * 100) + '%">' + N.pad(x % 24) + '</span>'; });
    rems.filter(i => !i.done && eff(i) && eff(i) >= t0 && eff(i) < t0 + 864e5).forEach(i => { h += '<span class="m' + (i.firedAt ? ' late' : '') + '" style="left:' + pos(eff(i)) + '%" title="' + esc(i.text) + '"></span>'; });
    doneToday.forEach(x => { h += '<span class="m done" style="left:' + pos(x.ts) + '%" title="' + esc(x.text) + '"></span>'; });
    tl.innerHTML = h; tl.style.setProperty('--nowp', pos(now.getTime()) + '%');
  }
  $('hero').addEventListener('click', e => {
    const b = e.target.closest('[data-go],[data-send]'); if (!b) return;
    if (b.dataset.go) go(b.dataset.go); else handleUser(b.dataset.send, false);
  });
  function applyTheme() {
    const th = THEMES[store.settings.theme] ? store.settings.theme : 'blue';
    document.documentElement.setAttribute('data-theme', th);
    document.querySelectorAll('.sw').forEach(b => { const on = b.dataset.theme === th; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  }
  function isQuiet(d) {
    const s = store.settings; if (!s.quietOn || !s.quietFrom || !s.quietTo) return false;
    const m = (d || new Date()).getHours() * 60 + (d || new Date()).getMinutes();
    const f = x => { const p = String(x).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };
    const a = f(s.quietFrom), b = f(s.quietTo);
    return a === b ? false : a < b ? (m >= a && m < b) : (m >= a || m < b);
  }
  function renderStatus() {
    const pend = store.items('reminders').filter(i => !i.done).length;
    const rc = $('rc'); rc.textContent = pend; rc.classList.toggle('zero', !pend);
    $('sy').textContent = store.items('memory').length + ' qeyd';
    const m = store.settings.llm.mode;
    $('sm').textContent = m === 'endpoint' ? 'LLM serveri' : m === 'device' ? 'Gemma (cihazda)' : 'Qaydalar mühərriki';
    $('lk').classList.toggle('hide', !store.settings.pin);
  }
  function renderAll() {
    renderStatus();
    renderToday();
    renderHero();
    if (S.view === 'dash') renderDashboard();
    if (S.view === 'rem') renderRem();
    if (S.view === 'mem') renderMem();
    if (S.view === 'prj') renderPrj();
    if (S.view === 'ftr') renderFileTransfer();
    if (S.view === 'clip') renderClipboard();
    if (S.view === 'conn') renderDevices();
    if (S.view === 'sys') renderSystemMonitor();
  }
  store.on(() => { renderAll(); });

  /* ---------- siyahı əməliyyatları (event delegation) ---------- */
  function bindList(elId, kind) {
    $(elId).addEventListener('click', e => {
      const t = e.target.closest('[data-act]'); if (!t) return;
      const row = t.closest('[data-id]'); const id = +row.dataset.id; const it = store.get(id); if (!it) return;
      const act = t.dataset.act;
      if (act === 'del') { firing.delete(id); store.remove(id); if (!firing.size) stopRing(); toast('Silindi'); }
      else if (act === 'edit') openEdit(it);
      else if (act === 'snz') { firing.delete(id); store.update(id, { snooze: Date.now() + 600000, firedAt: null }); closeNotif(id); if (!firing.size) stopRing(); toast('10 dəqiqə sonraya keçirildi'); }
      else if (act === 'toggle') {
        if (kind !== 'reminders') store.update(id, { done: !it.done });
        else if (!it.done) { if (firing.has(id)) { ackItem(id); if (!firing.size) stopRing(); } else completeReminder(it); }
        else store.update(id, { done: false, snooze: null, firedAt: it.due && it.due <= Date.now() ? Date.now() : null });
      }
    });
  }
  bindList('remList', 'reminders'); bindList('memList', 'memory'); bindList('prjList', 'projects');

  function addFromForm(formId, inputId, kind) {
    $(formId).addEventListener('submit', async e => {
      e.preventDefault(); const v = $(inputId).value.trim(); if (!v) return;
      $(inputId).value = '';
      if (kind === 'reminders') {
        maybeAskNotif();
        const r = await Brain.route(/xatirla|alarm|oyat/.test(N.fold(v)) ? v : 'xatırlat ' + v, env);
        toast(r.reply.split('\n')[0].slice(0, 120));
        if (S.session.pending) { go('chat'); addMsg(v, true); addMsg(r.reply, false); store.addMessage('user', v); store.addMessage('assistant', r.reply); speak(r.reply); }
      } else { store.add(kind, { text: v }); toast('Əlavə olundu'); }
    });
  }
  addFromForm('remForm', 'remText', 'reminders'); addFromForm('memForm', 'memText', 'memory'); addFromForm('prjForm', 'prjText', 'projects');

  $('profSave').addEventListener('click', () => {
    const n = $('profName').value.trim();
    if (!n) { toast('Ad boş ola bilməz'); return; }
    store.setName(N.capAz(n)); toast('Ad saxlanıldı: ' + store.profile.name);
  });

  /* ---------- düzəliş pəncərəsi ---------- */
  let editing = null;
  const dlg = $('dlg');
  function toLocalInput(ts) { const d = new Date(ts); return d.getFullYear() + '-' + N.pad(d.getMonth() + 1) + '-' + N.pad(d.getDate()) + 'T' + N.clock(d); }
  function openEdit(it) {
    editing = it || { id: null, kind: 'reminders' };
    const isRem = editing.kind === 'reminders';
    $('dTitle').textContent = it ? 'Düzəliş' : 'Yeni xatırlatma';
    $('dText').value = it ? it.text : '';
    $('dTimeRow').classList.toggle('hide', !isRem);
    const base = it ? eff(it) : (Math.ceil((Date.now() + 3600000) / 900000) * 900000);
    $('dWhen').value = base ? toLocalInput(base) : '';
    const sel = $('dRep'); [...sel.querySelectorAll('option[data-dyn]')].forEach(o => o.remove());
    if (it && it.repeat && it.repeat.type === 'interval') { const o = document.createElement('option'); o.value = 'interval'; o.dataset.dyn = '1'; o.textContent = 'Hər ' + N.fmtDuration(it.repeat.ms); sel.appendChild(o); }
    sel.value = it && it.repeat ? it.repeat.type : '';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    setTimeout(() => $('dText').focus(), 30);
  }
  $('dCancel').addEventListener('click', () => dlg.close());
  $('dForm').addEventListener('submit', e => {
    e.preventDefault();
    const text = $('dText').value.trim(); if (!text) return;
    if (editing.kind !== 'reminders') { store.update(editing.id, { text }); dlg.close(); return; }
    let due = $('dWhen').value ? new Date($('dWhen').value).getTime() : null;
    if (due !== null && isNaN(due)) due = null;
    const rv = $('dRep').value; let repeat = null;
    if (rv === 'daily') repeat = { type: 'daily' };
    else if (rv === 'weekly') repeat = { type: 'weekly', wday: due ? new Date(due).getDay() : 0 };
    else if (rv === 'interval' && editing.repeat) repeat = editing.repeat;
    if (repeat && !due) { toast('Təkrar üçün vaxt seç'); return; }
    const patch = { text, due, repeat, done: false, snooze: null, firedAt: due && due <= Date.now() ? Date.now() : null };
    if (editing.id) { firing.delete(editing.id); store.update(editing.id, patch); if (!firing.size) stopRing(); }
    else { maybeAskNotif(); store.add('reminders', patch); if (due && due <= Date.now()) toast('Vaxt keçmişdədir — gələcək vaxt seç'); }
    dlg.close(); toast('Saxlanıldı');
  });
  $('remAdv').addEventListener('click', () => openEdit(null));

  /* ================= xatırlatma mühərriki ================= */
  function completeReminder(it) {
    if (!it.timer) store.logDone(it.text);
    if (it.repeat) store.update(it.id, { due: N.nextDue(it.due, it.repeat, Date.now()), snooze: null, firedAt: null, done: false });
    else store.update(it.id, { done: true, snooze: null });
  }
  function checkReminders(nowMs) {
    const missed = [];
    for (const it of store.items('reminders')) {
      if (it.done || it.firedAt || firing.has(it.id)) continue;
      const d = eff(it); if (!d || d > nowMs) continue;
      if (nowMs - d > 120000) missed.push(it); else fire(it);
    }
    if (missed.length) reportMissed(missed, nowMs);
  }
  function reportMissed(list, nowMs) {
    list.forEach(it => {
      if (it.repeat) store.update(it.id, { due: N.nextDue(it.due, it.repeat, nowMs), snooze: null, firedAt: null });
      else store.update(it.id, { firedAt: nowMs, snooze: null });
    });
    const names = list.map(i => i.timer ? 'taymer' : i.text).join(', ');
    const msg = (store.profile.name ? store.profile.name + ', s' : 'S') + 'ən yoxkən ' + list.length + ' xatırlatmanın vaxtı keçdi: ' + names + '.';
    addMsg(msg, false); store.addMessage('assistant', msg); speak(msg);
    notifySimple('Qaçırılmış xatırlatma', names);
  }
  function fire(it) {
    store.update(it.id, { firedAt: Date.now() });
    firing.set(it.id, true); ringN = 0;
    showAlarm(); clearTimeout(ringTimer); ringCycle(); notifyItem(it); renderAll();
  }
  function ringText(items, again) {
    const nm = store.profile.name;
    const lab = i => i.text === 'Fokus' ? 'fokus vaxtı bitdi, fasilə et' : i.text === 'Fasilə' ? 'fasilə bitdi' : 'taymer bitdi';
    if (items.every(i => i.timer)) return (again ? '' : '') + items.map(lab).join('. ').replace(/^./, c => c.toUpperCase()) + '.';
    const parts = items.map(i => i.timer ? lab(i) : i.text);
    return (nm ? nm + ', ' : '') + (again ? 'xatırladıram: ' : 'xatırlatma: ') + parts.join('. ') + '.';
  }
  function ringCycle() {
    if (!firing.size) return;
    const items = [...firing.keys()].map(id => store.get(id)).filter(Boolean);
    if (!items.length) { firing.clear(); hideAlarm(); return; }
    ringN++;
    beep(3);
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) { /* */ }
    speak(ringText(items, ringN > 1), { onend: () => { if (store.settings.handsFree && firing.size) listenOnce(true); } });
    if (ringN < store.settings.repeatCount) ringTimer = setTimeout(ringCycle, Math.max(8, store.settings.repeatEvery) * 1000);
  }
  function stopRing() { clearTimeout(ringTimer); ringTimer = null; try { if ('speechSynthesis' in window) speechSynthesis.cancel(); } catch (e) { /* */ } if (!firing.size) hideAlarm(); }
  function ackItem(id) {
    const it = store.get(id); firing.delete(id); closeNotif(id);
    if (it) completeReminder(it);
  }
  function ackAll() { [...firing.keys()].forEach(ackItem); stopRing(); renderAll(); }
  function snoozeAll(ms) {
    const until = Date.now() + ms;
    [...firing.keys()].forEach(id => { firing.delete(id); closeNotif(id); store.update(id, { snooze: until, firedAt: null }); });
    stopRing(); renderAll();
  }
  function showAlarm() {
    const items = [...firing.keys()].map(id => store.get(id)).filter(Boolean);
    $('alarmList').innerHTML = items.map(i => '<div>' + (i.timer ? '⏱ ' + (i.text === 'Fokus' ? 'Fokus bitdi — fasilə et' : i.text === 'Fasilə' ? 'Fasilə bitdi' : 'Taymer bitdi') : esc(i.text)) + '</div>').join('');
    $('alarm').classList.remove('hide'); $('aAck').focus();
  }
  function hideAlarm() { $('alarm').classList.add('hide'); }
  $('aAck').addEventListener('click', () => { addMsg('✓ Xatırlatma tamamlandı.', false, 'sys'); ackAll(); });
  $('aSnooze').addEventListener('click', () => { snoozeAll(600000); toast('10 dəqiqə sonra yenidən xatırladacağam'); });
  $('aStop').addEventListener('click', () => { clearTimeout(ringTimer); try { speechSynthesis.cancel(); } catch (e) { /* */ } });

  /* ---------- bildirişlər ---------- */
  function maybeAskNotif() {
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(updateNotifNote); } catch (e) { /* */ }
  }
  async function swReg() { try { return ('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistration() : null; } catch (e) { return null; } }
  async function showNotif(title, opts) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const reg = await swReg();
      if (reg && reg.showNotification) await reg.showNotification(title, opts); else new Notification(title, opts);
    } catch (e) { /* bildiriş uğursuz — səs yenə də çalır */ }
  }
  function notifyItem(it) {
    showNotif('Cahangir', { body: it.timer ? (it.text === 'Fokus' ? 'Fokus bitdi' : it.text === 'Fasilə' ? 'Fasilə bitdi' : 'Taymer bitdi') : it.text, tag: 'rem-' + it.id, requireInteraction: true, renotify: true,
      vibrate: [300, 150, 300], icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      actions: [{ action: 'ack', title: 'Oldu' }, { action: 'snooze', title: '10 dəq.' }], data: { id: it.id } });
  }
  function notifySimple(title, body) { showNotif(title, { body, tag: 'missed', icon: 'icons/icon-192.png' }); }
  async function closeNotif(id) {
    try { const reg = await swReg(); if (reg) (await reg.getNotifications({ tag: 'rem-' + id })).forEach(n => n.close()); } catch (e) { /* */ }
  }
  function onNotifAction(action, id) {
    const it = store.get(id); if (!it) return;
    if (action === 'ack') { if (firing.has(id)) { ackItem(id); if (!firing.size) stopRing(); } else completeReminder(it); renderAll(); }
    else if (action === 'snooze') { firing.delete(id); store.update(id, { snooze: Date.now() + 600000, firedAt: null }); if (!firing.size) stopRing(); closeNotif(id); toast('10 dəqiqə sonra'); }
    else if (!it.done) { if (!it.firedAt && eff(it) <= Date.now()) fire(it); else if (!firing.has(id)) { firing.set(id, true); showAlarm(); } }
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => { const d = e.data; if (d && d.type === 'notif') onNotifAction(d.action, d.id); });
  }

  /* ================= səs: çıxış (TTS) ================= */
  let voices = [];
  function loadVoices() {
    try { voices = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : []; } catch (e) { voices = []; }
    const sel = $('sVoiceSel'); const cur = store.settings.voiceURI;
    const sorted = voices.slice().sort((a, b) => { const r = v => /^az/i.test(v.lang) ? 0 : /^tr/i.test(v.lang) ? 1 : 2; return r(a) - r(b) || a.name.localeCompare(b.name); });
    sel.innerHTML = '<option value="">Avtomatik (az → tr)</option>' + sorted.map(v => '<option value="' + esc(v.voiceURI) + '">' + esc(v.name + ' (' + v.lang + ')') + '</option>').join('');
    sel.value = cur || '';
    const v = pickVoice();
    $('ss').textContent = !('speechSynthesis' in window) ? 'dəstəklənmir' : v ? v.lang : 'standart səs';
    $('sVoiceNote').textContent = !('speechSynthesis' in window) ? 'Bu brauzer səsləndirməni dəstəkləmir.'
      : (voices.some(x => /^az/i.test(x.lang)) ? 'Azərbaycan dilində səs tapıldı.'
        : voices.some(x => /^tr/i.test(x.lang)) ? 'Azərbaycan səsi yoxdur — Türk səsi istifadə olunur (Azərbaycan mətnini yaxşı oxuyur).'
          : 'Azərbaycan/Türk səsi tapılmadı — standart səs istifadə olunur. Telefon ayarlarından “Mətndən nitqə” üçün Türk və ya Azərbaycan səsi yüklə.');
  }
  function pickVoice() {
    const uri = store.settings.voiceURI;
    return (uri && voices.find(v => v.voiceURI === uri)) || voices.find(v => /^az/i.test(v.lang)) || voices.find(v => /^tr/i.test(v.lang)) || null;
  }
  function speakable(t) {
    return String(t).replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/[•*_`#“”«»]/g, '').replace(/\s*\n+\s*/g, '. ').replace(/\.{2,}/g, '.').replace(/\s{2,}/g, ' ').trim();
  }
  function chunks(t) {
    const parts = t.split(/(?<=[.!?])\s+/); const out = []; let cur = '';
    for (const p of parts) { if ((cur + ' ' + p).length > 180 && cur) { out.push(cur); cur = p; } else cur = cur ? cur + ' ' + p : p; }
    if (cur) out.push(cur); return out;
  }
  function speak(text, opts) {
    opts = opts || {};
    const done = () => { S.speaking = false; if (S.mode === 'speaking') setMode('idle'); opts.onend && opts.onend(); };
    const clean = speakable(text);
    if (!store.settings.voice || !clean || (opts.chat && isQuiet())) { opts.onend && opts.onend(); return false; }
    const T = window.CahangirTTS;
    if (T && T.speak) { T.speak(clean, () => { S.speaking = true; setMode('speaking'); }, done); return true; }
    if (!('speechSynthesis' in window)) { opts.onend && opts.onend(); return false; }
    try {
      speechSynthesis.cancel();
      const v = pickVoice(); const list = chunks(clean); S.utts = [];
      list.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c);
        u.lang = v ? v.lang : 'az-AZ'; if (v) u.voice = v;
        u.rate = store.settings.rate; u.pitch = store.settings.pitch;
        if (i === 0) u.onstart = () => { S.speaking = true; setMode('speaking'); };
        u.onboundary = () => { S.pulse = 1; };
        if (i === list.length - 1) { u.onend = done; u.onerror = done; } else u.onerror = () => { };
        S.utts.push(u); speechSynthesis.speak(u);
      });
      return true;
    } catch (e) { opts.onend && opts.onend(); return false; }
  }
  if ('speechSynthesis' in window) { try { speechSynthesis.onvoiceschanged = loadVoices; } catch (e) { /* */ } }

  /* səsi brauzer siyasətinə görə "oyat" + bip */
  let actx = null;
  function unlockAudio() {
    if (S.audioReady) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { actx = actx || new AC(); if (actx.state === 'suspended') actx.resume(); }
      if ('speechSynthesis' in window) { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); }
      S.audioReady = true; updateHint();
    } catch (e) { /* */ }
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));
  function updateHint() { $('hint').classList.toggle('hide', S.audioReady || S.view !== 'chat'); }
  $('hint').addEventListener('click', unlockAudio);
  function beep(n, kind) {
    try {
      if (!actx) return; if (actx.state === 'suspended') actx.resume();
      kind = kind || store.settings.sound || 'bell';
      const t0 = actx.currentTime;
      for (let i = 0; i < n; i++) {
        const o = actx.createOscillator(), g = actx.createGain();
        let t = t0 + i * 0.32, dur = 0.26, f = i % 2 ? 880 : 1175, ty = 'sine', vol = 0.35;
        if (kind === 'chime') { t = t0 + i * 0.5; dur = 0.45; f = [659, 784, 988][i % 3]; ty = 'triangle'; vol = 0.3; }
        else if (kind === 'digital') { t = t0 + i * 0.18; dur = 0.1; f = i % 2 ? 1500 : 1500; ty = 'square'; vol = 0.12; }
        o.type = ty; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + dur + 0.05);
      }
    } catch (e) { /* */ }
  }

  /* ================= səs: giriş (STT) ================= */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const NATIVE = window.CahangirNative;
  window.onHeard = t => { setMode('idle'); handleUser(t, true); };
  window.onNativeReply = t => { setMode('idle'); addMsg(t, false); speak(t); };
  $('sr').textContent = NATIVE ? 'cihaz (lokal)' : SR ? 'az-AZ (brauzer)' : 'dəstəklənmir';
  function listenOnce(auto) {
    if (NATIVE && NATIVE.listen) { setMode('listening'); NATIVE.listen(); return; }
    if (!SR) { if (!auto) addMsg('Bu brauzer səs tanımanı dəstəkləmir. Chrome və ya Edge istifadə et — yazı ilə də davam edə bilərsən.', false, 'sys'); return; }
    if (rec) return;
    try { speechSynthesis.cancel(); } catch (e) { /* */ }
    rec = new SR(); rec.lang = recLang; rec.interimResults = false; rec.maxAlternatives = 1;
    let got = false;
    rec.onresult = e => { got = true; const t = e.results[0][0].transcript; handleUser(t, true); };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { addMsg('Mikrofona icazə verilmədi. Brauzerin ünvan sətrindəki kilid işarəsindən mikrofonu aç.', false, 'sys'); store.setSetting('handsFree', false); syncSettings(); }
      else if (e.error === 'language-not-supported' && recLang !== 'tr-TR') { recLang = 'tr-TR'; toast('Azərbaycan dili dəstəklənmir, Türk modeli ilə cəhd edirəm'); }
      else if (e.error === 'network') { addMsg('Brauzerin səs tanıma xidməti internet tələb edir. İnternet yoxdur — yazı ilə davam et (xatırlatma və qalan hər şey oflayn işləyir).', false, 'sys'); store.setSetting('handsFree', false); syncSettings(); }
      else if (e.error === 'audio-capture') addMsg('Mikrofon tapılmadı və ya başqa tətbiq istifadə edir.', false, 'sys');
    };
    rec.onend = () => {
      rec = null; $('mic').classList.remove('on'); if (S.mode === 'listening') setMode('idle');
      if (store.settings.handsFree && !got && document.visibilityState === 'visible' && !S.speaking) setTimeout(() => { if (store.settings.handsFree && !rec) listenOnce(true); }, 700);
    };
    try { rec.start(); setMode('listening'); $('mic').classList.add('on'); } catch (e) { rec = null; }
  }
  function stopListen() { if (NATIVE && NATIVE.stopListen) NATIVE.stopListen(); try { if (rec) { const r = rec; rec = null; r.abort(); } } catch (e) { /* */ } $('mic').classList.remove('on'); if (S.mode === 'listening') setMode('idle'); }
  $('mic').addEventListener('click', () => { unlockAudio(); if (S.mode === 'listening') stopListen(); else listenOnce(false); });

  /* ================= söhbət ================= */
  async function llmAdapter(text) {
    const cfg = store.settings.llm; if (!cfg || cfg.mode === 'off') return null;
    const now = new Date();
    const ctx = { name: store.profile.name, facts: store.items('memory').map(i => i.text), nowText: N.fmtDate(now) + ', saat ' + N.clock(now), history: store.messages().slice(-9, -1) };
    return LLM.ask(text, ctx, cfg, s => { $('stl').textContent = s; });
  }
  async function handleUser(text, viaVoice) {
    text = String(text || '').trim(); if (!text) return;
    if (S.view !== 'chat') go('chat');
    unlockAudio();
    addMsg(text, true); store.addMessage('user', text);
    if (/xatirla|alarm|oyat|taymer/.test(N.fold(text))) maybeAskNotif();
    setMode('thinking');
    const ty = document.createElement('div'); ty.className = 'msg typing'; ty.innerHTML = '<i></i><i></i><i></i>'; $('chat').appendChild(ty); $('chat').scrollTop = $('chat').scrollHeight;
    let r;
    try { r = await Brain.route(text, env); } catch (e) { r = { reply: 'Daxili xəta baş verdi: ' + (e && e.message ? e.message : e) }; }
    ty.remove(); setMode('idle');
    if (r.reply) {
      addMsg(r.reply, false, r.error ? 'sys' : ''); store.addMessage('assistant', r.reply);
      speak(r.reply, { chat: true, onend: () => { if (store.settings.handsFree && !firing.size && S.view === 'chat') setTimeout(() => listenOnce(true), 300); } });
    }
    renderAll();
  }
  $('composer').addEventListener('submit', e => { e.preventDefault(); const v = $('tx').value; $('tx').value = ''; handleUser(v, false); });
  document.querySelectorAll('[data-send]').forEach(b => b.addEventListener('click', () => handleUser(b.dataset.send, false)));
  document.querySelectorAll('[data-fill]').forEach(b => b.addEventListener('click', () => {
    const raw = b.dataset.fill; const i = raw.indexOf('  '); const tx = $('tx');
    tx.value = i >= 0 ? raw.slice(0, i) + ' ' + raw.slice(i + 2) : raw; tx.focus();
    const pos = i >= 0 ? i + 1 : tx.value.length; try { tx.setSelectionRange(pos, pos); } catch (e) { /* */ }
  }));

  /* ================= ayarlar ================= */
  function syncSettings() {
    const s = store.settings;
    $('sVoice').checked = s.voice; $('sRate').value = s.rate; $('sRateO').textContent = (+s.rate).toFixed(1);
    $('sPitch').value = s.pitch; $('sPitchO').textContent = (+s.pitch).toFixed(1);
    $('sRep').value = s.repeatCount; $('sRepO').textContent = s.repeatCount;
    $('sEvery').value = s.repeatEvery; $('sEveryO').textContent = s.repeatEvery;
    $('sAwake').checked = s.keepAwake; $('sHands').checked = s.handsFree;
    $('sSound').value = s.sound; $('sQuiet').checked = s.quietOn; $('sQFrom').value = s.quietFrom; $('sQTo').value = s.quietTo; applyTheme();
    $('lMode').value = s.llm.mode; $('lUrl').value = s.llm.url || ''; $('lModel').value = s.llm.model || ''; $('lKey').value = s.llm.key || '';
    $('lEndpoint').classList.toggle('hide', s.llm.mode !== 'endpoint'); $('lDevice').classList.toggle('hide', s.llm.mode !== 'device');
    $('pinOff').classList.toggle('hide', !s.pin);
    updateNotifNote(); updateDeviceNote(); renderStatus();
  }
  $('sVoice').addEventListener('change', e => store.setSetting('voice', e.target.checked));
  $('sVoiceSel').addEventListener('change', e => { store.setSetting('voiceURI', e.target.value); loadVoices(); });
  $('sRate').addEventListener('input', e => { store.setSetting('rate', +e.target.value); $('sRateO').textContent = (+e.target.value).toFixed(1); });
  $('sPitch').addEventListener('input', e => { store.setSetting('pitch', +e.target.value); $('sPitchO').textContent = (+e.target.value).toFixed(1); });
  $('sRep').addEventListener('input', e => { store.setSetting('repeatCount', +e.target.value); $('sRepO').textContent = e.target.value; });
  $('sEvery').addEventListener('input', e => { store.setSetting('repeatEvery', +e.target.value); $('sEveryO').textContent = e.target.value; });
  $('sTest').addEventListener('click', () => { unlockAudio(); const was = store.settings.voice; if (!was) toast('“Cavabları səslə oxu” söndürülüb'); else speak((store.profile.name ? store.profile.name + ', ' : '') + 'mən Cahangirəm. Səsim belə eşidilir.'); });
  document.querySelectorAll('.sw').forEach(b => b.addEventListener('click', () => { store.setSetting('theme', b.dataset.theme); applyTheme(); }));
  $('sSound').addEventListener('change', e => { store.setSetting('sound', e.target.value); unlockAudio(); beep(3); });
  $('sSoundTest').addEventListener('click', () => { unlockAudio(); setTimeout(() => beep(3), 50); });
  $('sQuiet').addEventListener('change', e => store.setSetting('quietOn', e.target.checked));
  $('sQFrom').addEventListener('change', e => store.setSetting('quietFrom', e.target.value));
  $('sQTo').addEventListener('change', e => store.setSetting('quietTo', e.target.value));
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const a = document.activeElement; if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    e.preventDefault(); go('chat'); $('tx').focus();
  });
  $('sAwake').addEventListener('change', e => { store.setSetting('keepAwake', e.target.checked); wakeLock(); });
  $('sHands').addEventListener('change', e => { store.setSetting('handsFree', e.target.checked); if (e.target.checked) { go('chat'); listenOnce(true); } else stopListen(); });
  function updateNotifNote() {
    const n = $('sNotifNote'); const b = $('sNotif');
    if (!('Notification' in window)) { n.textContent = 'Bu brauzer bildirişləri dəstəkləmir — xatırlatmalar səs və ekran pəncərəsi ilə işləyir.'; b.classList.add('hide'); return; }
    const p = Notification.permission; b.classList.toggle('hide', p === 'granted');
    n.textContent = p === 'granted' ? 'Bildirişlər aktivdir. Qeyd: tətbiq bağlı olduqda brauzerlər səsli oxumağa icazə vermir — səsli xatırlatma üçün tətbiq açıq qalmalıdır (ekranı oyaq saxla seçimi kömək edir).'
      : p === 'denied' ? 'Bildirişlər bloklanıb — brauzer/sayt ayarlarından icazə ver.' : 'Xatırlatma ekran bağlı/arxa planda olanda da görünsün deyə icazə ver.';
  }
  $('sNotif').addEventListener('click', () => { try { Notification.requestPermission().then(updateNotifNote); } catch (e) { /* */ } });

  /* ---- dil modeli ayarları ---- */
  $('lMode').addEventListener('change', e => { store.setLLM({ mode: e.target.value }); syncSettings(); });
  $('lUrl').addEventListener('change', e => store.setLLM({ url: e.target.value.trim() }));
  $('lModel').addEventListener('change', e => store.setLLM({ model: e.target.value.trim() }));
  $('lKey').addEventListener('change', e => store.setLLM({ key: e.target.value.trim() }));
  $('lTest').addEventListener('click', async () => {
    $('lNote').textContent = 'Yoxlanılır…';
    try { const r = await LLM.ask('Salam de.', { name: store.profile.name, facts: [], nowText: N.fmtDate(new Date()), history: [] }, store.settings.llm); $('lNote').textContent = '✓ Qoşuldu. Cavab: ' + r.slice(0, 120); }
    catch (e) { $('lNote').textContent = '✗ ' + (e.message || e); }
  });
  async function updateDeviceNote() {
    const n = $('lDevNote'); if (!n) return;
    const has = await LLM.hasModel(); const m = LLM.meta(); const gpu = 'gpu' in navigator;
    n.textContent = (gpu ? 'WebGPU var. ' : '⚠ WebGPU yoxdur — bu cihazda/brauzerdə cihaz-daxili model işləməyəcək. ') +
      (has ? 'Model saxlanılıb' + (m ? ': ' + m.name + ' (' + Math.round(m.size / 1048576) + ' MB)' : '') + '.' : 'Model faylı seçilməyib. Gemma 3n E2B/E4B və ya Gemma 3 1B (.task / .litertlm) faylını bir dəfə seç — sonra tam oflayn işləyir.');
  }
  $('lFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    $('lProgBox').classList.remove('hide'); $('lNote').textContent = 'Model cihaza köçürülür…';
    try { await LLM.storeModel(f, p => { $('lProg').style.width = Math.round(p * 100) + '%'; }); $('lNote').textContent = '✓ Model saxlanıldı. İndi “Modeli yüklə və yoxla” düyməsini bas.'; }
    catch (er) { $('lNote').textContent = '✗ ' + (er.message || er); }
    $('lProgBox').classList.add('hide'); e.target.value = ''; updateDeviceNote();
  });
  $('lLoad').addEventListener('click', async () => {
    $('lNote').textContent = 'Yüklənir…';
    try { await LLM.deviceLoad(s => { $('lNote').textContent = s; }); $('lNote').textContent = '✓ Gemma hazırdır. Söhbətdə sual ver.'; }
    catch (e) { $('lNote').textContent = '✗ ' + (e.message || e); }
  });
  $('lDel').addEventListener('click', async () => { await LLM.removeModel(); $('lNote').textContent = 'Model silindi.'; updateDeviceNote(); });

  /* ---- PIN ---- */
  async function hashPin(p) {
    try { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('cahangir:' + p)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
    catch (e) { let h = 5381; for (const c of p) h = ((h << 5) + h) ^ c.charCodeAt(0); return 'x' + (h >>> 0).toString(16); }
  }
  function showLock() { if (!store.settings.pin) return; $('pin').value = ''; $('lerr').textContent = ''; $('lock').classList.remove('hide'); setTimeout(() => $('pin').focus(), 50); }
  async function tryUnlock() {
    const p = $('pin').value;
    if (!/^\d{4,8}$/.test(p)) { $('lerr').textContent = 'PIN 4–8 rəqəm olmalıdır.'; return; }
    if ((await hashPin(p)) === store.settings.pin) $('lock').classList.add('hide');
    else { $('lerr').textContent = 'PIN səhvdir.'; $('pin').value = ''; }
  }
  $('lgo').addEventListener('click', tryUnlock);
  $('pin').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
  $('lk').addEventListener('click', showLock);
  $('pinSet').addEventListener('click', async () => {
    const p = $('pinNew').value;
    if (!/^\d{4,8}$/.test(p)) { toast('PIN 4–8 rəqəm olmalıdır'); return; }
    store.setSetting('pin', await hashPin(p)); $('pinNew').value = ''; toast('PIN təyin olundu'); syncSettings();
  });
  $('pinOff').addEventListener('click', () => { store.setSetting('pin', ''); toast('PIN silindi'); syncSettings(); });

  /* ---- məlumat ---- */
  $('dExport').addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const d = new Date(); a.download = 'cahangir-yedek-' + d.getFullYear() + '-' + N.pad(d.getMonth() + 1) + '-' + N.pad(d.getDate()) + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('Ehtiyat nüsxə yükləndi');
  });
  $('dImport').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = store.importJSON(await f.text()); toast('Bərpa olundu: ' + n + ' maddə'); syncSettings(); loadChat(); }
    catch (er) { toast('Xəta: ' + (er.message || 'fayl oxunmadı')); }
    e.target.value = '';
  });
  $('dClearChat').addEventListener('click', () => { store.clearMessages(); $('chat').innerHTML = ''; toast('Söhbət təmizləndi'); });
  $('dReset').addEventListener('click', () => {
    if (!confirm('Bütün xatırlatmalar, yaddaş və ayarlar silinəcək. Əminsən?')) return;
    firing.clear(); stopRing(); store.resetAll(); S.session.pending = null; $('chat').innerHTML = ''; syncSettings(); renderAll(); boot2(); toast('Hamısı silindi');
  });

  /* ================= P2P, Dashboard, Fayl Ötürmə, Pano, Cihazlar ================= */
  let cachedDevices = [];
  let clipHistory = [];

  function fmtBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024, dm = 2;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function renderDashboard() {
    const rems = store.items('reminders').filter(r => !r.done && !r.deleted);
    const mems = store.items('memory').filter(m => !m.deleted);
    const prjs = store.items('projects').filter(p => !p.deleted);
    if ($('dRemCount')) $('dRemCount').textContent = rems.length;
    if ($('dMemCount')) $('dMemCount').textContent = mems.length;
    if ($('dPrjCount')) $('dPrjCount').textContent = prjs.length;
    if ($('dDevCount')) $('dDevCount').textContent = cachedDevices.filter(d => !d.is_revoked).length || 1;

    if (window.cahangirGetSystemMetrics) {
      const m = window.cahangirGetSystemMetrics();
      if (m) {
        if ($('dServerStatus')) {
          $('dServerStatus').textContent = m.server_online ? '● Onlayn (Bağlı)' : '○ Oflayn';
          $('dServerStatus').className = m.server_online ? 'ok' : 'err';
        }
        if ($('dServerLatency')) $('dServerLatency').textContent = m.server_latency_ms >= 0 ? m.server_latency_ms + ' ms' : '—';
        if ($('dTailscaleIp')) $('dTailscaleIp').textContent = m.tailscale_ip || 'Aktiv deyil';
        if ($('dLocalIp')) $('dLocalIp').textContent = m.local_ip || '—';
        if ($('dBattery')) $('dBattery').textContent = m.battery_percent + '%' + (m.battery_charging ? ' ⚡' : '');
        if ($('dRam')) $('dRam').textContent = m.ram_used_mb + ' / ' + m.ram_total_mb + ' MB (' + m.ram_percent + '%)';
        if ($('dStorage')) $('dStorage').textContent = m.disk_used_gb + ' / ' + m.disk_total_gb + ' GB (' + m.disk_percent + '%)';
      }
    }

    if (window.cahangirGetTransferHistory) {
      const history = window.cahangirGetTransferHistory();
      const el = $('dRecentTransfers');
      if (el) {
        if (!history || history.length === 0) {
          el.innerHTML = '<p class="note" style="margin:0;">Heç bir fayl ötürülməyib.</p>';
        } else {
          el.innerHTML = history.slice(0, 3).map(t => `
            <div class="transfer-item">
              <div class="thdr">
                <span class="tname">${esc(t.filename)}</span>
                <span class="${t.status === 'completed' ? 'ok' : 'err'}" style="font-size:11px;">
                  ${t.status === 'completed' ? '✓ ' + (t.direction === 'send' ? 'Göndərildi' : 'Qəbul edildi') : '✗ Xəta'}
                </span>
              </div>
              <div class="tmeta">
                <span>${fmtBytes(t.file_size)} · ${t.speed_mbps ? t.speed_mbps.toFixed(2) + ' MB/s' : ''}</span>
                <span>${new Date(t.timestamp).toLocaleTimeString()}</span>
              </div>
            </div>
          `).join('');
        }
      }
    }
  }

  function renderFileTransfer() {
    if (window.cahangirGetP2pStatus) {
      const st = window.cahangirGetP2pStatus();
      if (st && st.ips && st.ips.length > 0 && $('ftrPeerIp') && !$('ftrPeerIp').value) {
        const s = window.cahangirGetServerStatus ? window.cahangirGetServerStatus() : null;
        if (s && s.serverUrl) {
          try {
            const host = new URL(s.serverUrl).hostname;
            if (host) $('ftrPeerIp').value = host;
          } catch (_) {}
        }
      }
    }

    const history = window.cahangirGetTransferHistory ? window.cahangirGetTransferHistory() : [];
    const el = $('ftrList');
    if (el) {
      if (!history || history.length === 0) {
        el.innerHTML = '<p class="note">Fayl ötürmə tarixçəsi boşdur.</p>';
      } else {
        el.innerHTML = history.map(t => `
          <div class="transfer-item">
            <div class="thdr">
              <span class="tname">${esc(t.filename)}</span>
              <span class="${t.status === 'completed' ? 'ok' : 'err'}" style="font-size:12px; font-weight:600;">
                ${t.status === 'completed' ? (t.direction === 'send' ? '📤 Göndərildi' : '📥 Qəbul edildi') : '⚠️ Uğursuz'}
              </span>
            </div>
            <div class="tmeta">
              <span>${fmtBytes(t.file_size)} · Sürət: ${t.speed_mbps ? t.speed_mbps.toFixed(2) + ' MB/s' : '—'}</span>
              <span>${new Date(t.timestamp).toLocaleDateString()} ${new Date(t.timestamp).toLocaleTimeString()}</span>
            </div>
            ${t.sha256 ? `<div style="font-size:10px; color:#64748b; font-family:monospace; overflow:hidden; text-overflow:ellipsis;">SHA-256: ${esc(t.sha256)}</div>` : ''}
          </div>
        `).join('');
      }
    }
  }

  function renderClipboard() {
    const el = $('clipList');
    if (el) {
      if (!clipHistory || clipHistory.length === 0) {
        el.innerHTML = '<p class="note">Pano tarixçəsi boşdur.</p>';
      } else {
        el.innerHTML = clipHistory.map((item, idx) => `
          <div class="clip-item">
            <div class="ctext">${esc(item.text)}</div>
            <div class="cmeta">
              <span>${esc(item.origin)} · ${new Date(item.timestamp).toLocaleTimeString()}</span>
              <button class="btn small ghost" data-copy-clip="${idx}">Kopyala</button>
            </div>
          </div>
        `).join('');

        el.querySelectorAll('[data-copy-clip]').forEach(btn => {
          btn.addEventListener('click', e => {
            const idx = +e.target.dataset.copyClip;
            const item = clipHistory[idx];
            if (item && window.cahangirCopyClipboard) {
              window.cahangirCopyClipboard(item.text);
              toast('✓ Kopyalandı');
            }
          });
        });
      }
    }
  }

  async function renderDevices() {
    const el = $('connDeviceList');
    if (!el) return;
    el.innerHTML = '<p class="note">Cihazlar yüklənir...</p>';

    const serverSt = window.cahangirGetServerStatus ? window.cahangirGetServerStatus() : null;
    const serverUrl = serverSt ? serverSt.serverUrl : '';
    const adminToken = (store.settings && store.settings.adminToken) || '';

    if (!serverUrl) {
      el.innerHTML = '<p class="note">Debian server URL təyin olunmayıb. Ayarlar bölməsindən serverə qoşulun.</p>';
      return;
    }

    const res = window.cahangirListDevices ? window.cahangirListDevices(serverUrl, adminToken) : null;
    if (res && res.success && Array.isArray(res.devices)) {
      cachedDevices = res.devices;
      if (cachedDevices.length === 0) {
        el.innerHTML = '<p class="note">Qoşulmuş cihaz tapılmadı.</p>';
      } else {
        el.innerHTML = cachedDevices.map(d => {
          const isOnline = d.is_revoked === 0;
          return `
            <div class="device-card">
              <div class="dhdr">
                <span class="dname">${esc(d.device_name || d.device_id)}</span>
                <span class="${isOnline ? 'badge-online' : 'badge-revoked'}">
                  ${isOnline ? '● Aktiv' : '○ Ləğv edilib'}
                </span>
              </div>
              <div style="font-size:12px; color:var(--mut);">
                <div>ID: ${esc(d.device_id)}</div>
                ${d.ip_address ? `<div>IP: <b>${esc(d.ip_address)}</b></div>` : ''}
                <div>Son fəaliyyət: ${d.last_seen ? new Date(d.last_seen).toLocaleString() : 'naməlum'}</div>
              </div>
              <div class="two" style="margin-top:6px;">
                <button class="btn small" data-send-file-ip="${esc(d.ip_address || '')}">📁 Fayl Göndər</button>
                <button class="btn small" data-send-clip-ip="${esc(d.ip_address || '')}">📋 Pano Göndər</button>
              </div>
              ${isOnline ? `<button class="btn danger small ghost" data-revoke-id="${esc(d.device_id)}" style="margin-top:4px;">Girişi Ləğv Et</button>` : ''}
            </div>
          `;
        }).join('');

        el.querySelectorAll('[data-send-file-ip]').forEach(btn => {
          btn.addEventListener('click', e => {
            const ip = e.target.dataset.sendFileIp;
            if (ip && $('ftrPeerIp')) $('ftrPeerIp').value = ip;
            go('ftr');
          });
        });

        el.querySelectorAll('[data-send-clip-ip]').forEach(btn => {
          btn.addEventListener('click', e => {
            const ip = e.target.dataset.sendClipIp;
            if (ip && $('clipPeerIp')) $('clipPeerIp').value = ip;
            go('clip');
          });
        });

        el.querySelectorAll('[data-revoke-id]').forEach(btn => {
          btn.addEventListener('click', e => {
            const devId = e.target.dataset.revokeId;
            if (confirm(`"${devId}" cihazının girişini ləğv etmək istəyirsiniz?`)) {
              if (window.cahangirRevokeDevice) {
                const r = window.cahangirRevokeDevice(serverUrl, adminToken, devId);
                if (r && r.success) {
                  toast('Cihaz ləğv edildi');
                  renderDevices();
                } else {
                  toast('Xəta: ' + (r ? r.error : 'Ləğv edilmədi'));
                }
              }
            }
          });
        });
      }
    } else {
      el.innerHTML = '<p class="note" style="color:var(--bad);">Cihazlar siyahısı alına bilmədi: ' + (res ? res.error : 'Serverə əlaqə yoxdur') + '</p>';
    }
  }

  function renderSystemMonitor() {
    if (!window.cahangirGetSystemMetrics) return;
    const m = window.cahangirGetSystemMetrics();
    if (!m) return;

    if ($('sysDeviceName')) $('sysDeviceName').textContent = m.device_name || 'Galaxy S25';
    if ($('sysBattery')) $('sysBattery').textContent = m.battery_percent + '%' + (m.battery_charging ? ' ⚡ (Zaryadkalanır)' : '') + (m.battery_temp ? ` (${m.battery_temp}°C)` : '');
    if ($('sysRam')) $('sysRam').textContent = `${m.ram_used_mb} MB / ${m.ram_total_mb} MB (${m.ram_percent}%)`;
    if ($('sysStorage')) $('sysStorage').textContent = `${m.disk_used_gb} GB / ${m.disk_total_gb} GB (${m.disk_percent}%)`;
    if ($('sysTailscale')) $('sysTailscale').textContent = m.tailscale_ip || 'Qoşulmayıb';
    if ($('sysLocalIp')) $('sysLocalIp').textContent = m.local_ip || '—';

    if ($('sysServerStatus')) {
      $('sysServerStatus').textContent = m.server_online ? '● Onlayn (Bağlı)' : '○ Oflayn';
      $('sysServerStatus').className = m.server_online ? 'ok' : 'err';
    }
    if ($('sysServerPing')) $('sysServerPing').textContent = m.server_latency_ms >= 0 ? m.server_latency_ms + ' ms' : '—';
    if ($('sysServerUrl')) $('sysServerUrl').textContent = m.server_url || 'Ayarlanmayıb';
  }

  /* ================= P2P Event Bindings ================= */
  window.onP2pTransferStarted = function(id, name, size, sender) {
    const box = $('ftrProgBox');
    if (box) box.classList.remove('hide');
    if ($('ftrStatusText')) $('ftrStatusText').textContent = 'Ötürülür: ' + name;
    if ($('ftrPercentText')) $('ftrPercentText').textContent = '0%';
    if ($('ftrProgressBar')) $('ftrProgressBar').style.width = '0%';
    if ($('ftrBytesText')) $('ftrBytesText').textContent = '0 / ' + fmtBytes(size);
    toast('Ötürmə başladı: ' + name);
  };

  window.onP2pTransferProgress = function(id, sent, total, percent, speed) {
    const box = $('ftrProgBox');
    if (box && box.classList.contains('hide')) box.classList.remove('hide');
    if ($('ftrPercentText')) $('ftrPercentText').textContent = Math.round(percent) + '%';
    if ($('ftrProgressBar')) $('ftrProgressBar').style.width = percent + '%';
    if ($('ftrSpeedText')) $('ftrSpeedText').textContent = speed.toFixed(2) + ' MB/s';
    if ($('ftrBytesText')) $('ftrBytesText').textContent = fmtBytes(sent) + ' / ' + fmtBytes(total);
  };

  window.onP2pTransferComplete = function(id, name, size, speed, sha, path) {
    const box = $('ftrProgBox');
    if (box) box.classList.add('hide');
    toast('✓ Fayl tamamlandı: ' + name);
    if (S.view === 'ftr') renderFileTransfer();
    if (S.view === 'dash') renderDashboard();
  };

  window.onP2pTransferFailed = function(err) {
    const box = $('ftrProgBox');
    if (box) box.classList.add('hide');
    toast('Xəta: ' + err);
    if (S.view === 'ftr') renderFileTransfer();
  };

  window.onP2pClipboardReceived = function(text, origin, hash) {
    clipHistory.unshift({
      text: text,
      origin: origin || 'Kompüter',
      timestamp: Date.now()
    });
    if (clipHistory.length > 30) clipHistory.pop();
    toast('📋 Pano mətni alındı: ' + origin);
    if (S.view === 'clip') renderClipboard();
  };

  // Button hooks
  if ($('dGoFtrBtn')) $('dGoFtrBtn').addEventListener('click', () => go('ftr'));

  if ($('ftrPickBtn')) $('ftrPickBtn').addEventListener('click', () => {
    const ip = ($('ftrPeerIp').value || '').trim();
    const port = +$('ftrPeerPort').value || 8767;
    if (!ip) {
      alert('Zəhmət olmasa qarşı tərəfin IP ünvanını daxil edin.');
      return;
    }
    if (window.cahangirPickAndSendFile) {
      window.cahangirPickAndSendFile(ip, port);
    }
  });

  if ($('ftrCancelBtn')) $('ftrCancelBtn').addEventListener('click', () => {
    if (window.cahangirCancelTransfer) window.cahangirCancelTransfer();
    toast('Ötürmə dayandırıldı');
    if ($('ftrProgBox')) $('ftrProgBox').classList.add('hide');
  });

  if ($('ftrClearBtn')) $('ftrClearBtn').addEventListener('click', () => {
    if (confirm('Fayl ötürmə tarixçəsini təmizləmək istəyirsiniz?')) {
      if (window.cahangirClearTransferHistory) window.cahangirClearTransferHistory();
      renderFileTransfer();
      toast('Tarixçə təmizləndi');
    }
  });

  if ($('clipPasteBtn')) $('clipPasteBtn').addEventListener('click', () => {
    if (window.cahangirGetClipboard) {
      const txt = window.cahangirGetClipboard();
      if (txt) {
        $('clipText').value = txt;
        toast('Panodan oxundu');
      } else {
        toast('Pano boşdur');
      }
    }
  });

  if ($('clipSendBtn')) $('clipSendBtn').addEventListener('click', () => {
    const ip = ($('clipPeerIp').value || '').trim();
    const txt = ($('clipText').value || '').trim();
    if (!ip || !txt) {
      alert('Zəhmət olmasa IP və mətni daxil edin.');
      return;
    }
    const statusTxt = $('clipSendStatus');
    if (statusTxt) statusTxt.textContent = 'Göndərilir...';
    if (window.cahangirSendClipboard) {
      const res = window.cahangirSendClipboard(ip, 8767, txt);
      if (res && res.success) {
        if (statusTxt) {
          statusTxt.textContent = '✓ Uğurla göndərildi!';
          statusTxt.style.color = '#22e07a';
        }
        clipHistory.unshift({
          text: txt,
          origin: 'Bu Telefon (Göndərilib)',
          timestamp: Date.now()
        });
        renderClipboard();
        toast('✓ Pano göndərildi');
        $('clipText').value = '';
      } else {
        if (statusTxt) {
          statusTxt.textContent = 'Xəta: ' + (res ? res.error : 'Göndərilmədi');
          statusTxt.style.color = '#ff6b81';
        }
      }
    }
  });

  if ($('connRefreshBtn')) $('connRefreshBtn').addEventListener('click', renderDevices);
  if ($('sysRefreshBtn')) $('sysRefreshBtn').addEventListener('click', renderSystemMonitor);

  /* ---- ekranı oyaq saxla ---- */
  let wl = null;
  async function wakeLock() {
    try {
      if (store.settings.keepAwake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        if (!wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); }
      } else if (wl) { await wl.release(); wl = null; }
    } catch (e) { wl = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wakeLock(); tick(); } });
  window.addEventListener('focus', tick);

  /* ---- quraşdırma / oflayn ---- */
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('installBtn').classList.remove('hide'); });
  $('installBtn').addEventListener('click', async () => { if (!deferredInstall) return; deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch (e) { /* */ } deferredInstall = null; $('installBtn').classList.add('hide'); });
  window.addEventListener('appinstalled', () => { $('installBtn').classList.add('hide'); toast('Quraşdırıldı'); });
  async function registerSW() {
    const note = $('appNote');
    const secure = window.isSecureContext;
    if (!('serviceWorker' in navigator) || !secure) {
      note.textContent = secure ? 'Bu brauzer oflayn quraşdırmanı dəstəkləmir.' : 'Hazırda təhlükəsiz olmayan ünvandasan. Oflayn quraşdırma və mikrofon üçün HTTPS (və ya localhost) lazımdır. Tətbiq yenə də işləyir; məlumat bu cihazda saxlanır.';
      return;
    }
    try {
      await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      note.textContent = '✓ Oflayn rejim hazırdır — internet olmadan da açılır və işləyir.';
    } catch (e) { note.textContent = 'Oflayn quraşdırma alınmadı: ' + (e.message || e); }
  }

  /* ================= orb animasiyası ================= */
  const cv = $('orb'), cx2 = cv.getContext('2d'); let t = 0, lv = 0;
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  function draw() {
    if (document.hidden || S.view !== 'chat') { setTimeout(() => requestAnimationFrame(draw), 300); return; }
    const dp = window.devicePixelRatio || 1, W = cv.width = Math.max(10, cv.clientWidth * dp), H = cv.height = Math.max(10, cv.clientHeight * dp);
    const cx = W / 2, cy = H / 2, m = Math.min(W, H), R = m * .2, x = cx2;
    t += reduce ? 0 : (S.mode === 'thinking' ? .05 : .015);
    const tg = S.mode === 'listening' ? .35 + .3 * Math.abs(Math.sin(t * 7) * Math.sin(t * 3.1)) : S.mode === 'speaking' ? .5 + .5 * Math.sin(t * 9) * Math.sin(t * 4.3) : S.mode === 'thinking' ? .4 : .1 * Math.sin(t * 2);
    S.pulse = Math.max(0, (S.pulse || 0) - .08); lv += (Math.min(1, tg + .25 * S.pulse) - lv) * .15;
    const C = THEMES[store.settings.theme] || THEMES.blue, rgb = C.join(',');
    x.clearRect(0, 0, W, H);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, m / 2); g.addColorStop(0, 'rgba(' + rgb + ',' + (.3 + .35 * lv) + ')'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 3; i++) { x.save(); x.translate(cx, cy); x.rotate(t * (i % 2 ? -1 : 1) * (1 + i * .4) + i); const r = m * (.3 + .05 * i) * (1 + .05 * lv); x.beginPath(); x.ellipse(0, 0, r, r * .4, 0, 0, 7); x.strokeStyle = 'rgba(' + rgb + ',' + (.55 - i * .12) + ')'; x.lineWidth = dp * 1.5; x.stroke(); x.restore(); }
    if (S.mode === 'speaking' || S.mode === 'thinking') for (let k = 0; k < 3; k++) { const p = (t * .6 + k / 3) % 1; x.beginPath(); x.arc(cx, cy, R * (1.3 + p * 1.5), 0, 7); x.strokeStyle = 'rgba(' + rgb + ',' + (1 - p) * .45 + ')'; x.lineWidth = dp * 2; x.stroke(); }
    const gr = x.createLinearGradient(cx - R, cy - R, cx + R, cy + R); gr.addColorStop(0, 'rgb(' + C.map(v => Math.min(255, v + 70)).join(',') + ')'); gr.addColorStop(1, 'rgb(' + C.map(v => Math.round(v * .45)).join(',') + ')');
    x.save(); x.shadowColor = 'rgb(' + rgb + ')'; x.shadowBlur = R * (.5 + lv); x.beginPath(); x.arc(cx, cy, R * (1 + .06 * lv), .28 * Math.PI, 1.72 * Math.PI); x.strokeStyle = gr; x.lineWidth = R * .4; x.lineCap = 'round'; x.stroke(); x.restore();
    requestAnimationFrame(draw);
  }

  /* ================= açılış ================= */
  function loadChat() {
    $('chat').innerHTML = '';
    store.messages().slice(-30).forEach(m => addMsg(m.text, m.role === 'user', '', m.ts));
  }
  function boot2() {
    /* ilk salamlama / tanışlıq */
    const had = store.messages().length > 0;
    if (!store.profile.name) {
      S.session.pending = { type: 'name' };
      const q = had ? 'Adını hələ öyrənməmişəm — adın nədir?' : Brain.welcome(env);
      addMsg(q, false); store.addMessage('assistant', q); speak(q);
    } else if (!had) {
      const w = Brain.welcome(env); addMsg(w, false); store.addMessage('assistant', w); speak(w);
    }
  }
  function handleUrlParams() {
    try {
      const p = new URLSearchParams(location.search); const id = +p.get('ring');
      if (id) { onNotifAction(p.get('act') || 'open', id); history.replaceState(null, '', location.pathname); }
    } catch (e) { /* */ }
  }
  function init() {
    applyTheme(); net(); loadVoices(); loadChat(); syncSettings(); renderAll(); updateHint();
    window.addEventListener('online', net); window.addEventListener('offline', net);
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* */ }
    showLock();
    tick(); setInterval(tick, 1000);
    handleUrlParams();
    registerSW();
    wakeLock();
    boot2();
    requestAnimationFrame(draw);
  }
  window.__cg = { store, handleUser, tick, firing, env, fire, ackAll, go, speak };
  init();
})();

// Klaviatura açılanda fokuslanan sahə həmişə görünsün (native IME padding WebView-u kiçildir)
document.addEventListener('focusin', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    setTimeout(() => { try { t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) {} }, 320);
  }
});
