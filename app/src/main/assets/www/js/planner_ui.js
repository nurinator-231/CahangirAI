/* planner_ui.js — Planner, clipboard, file transfer, devices and server pairing views
 * for the Android WebView. Data comes from native SQLite through the bridge; planning
 * uses the shared engine (planner.js), identical to the Windows app. */
(function (root) {
  'use strict';
  const P = root.CahangirPlanner;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NATIVE = !!(root.CahangirBridge && root.CahangirBridge.listEntities);
  const toast = m => (root.toast ? root.toast(m) : console.log(m));
  const L = 'az';

  /* ---------------- data ---------------- */
  const mem = {}; // used only without native bridge (browser preview)
  function list(e) {
    if (NATIVE) { try { return JSON.parse(root.CahangirBridge.listEntities(e, false)); } catch (err) { return []; } }
    return (mem[e] || []).filter(r => !r.deleted);
  }
  function save(e, item) {
    if (NATIVE) {
      const r = JSON.parse(root.CahangirBridge.saveEntity(e, JSON.stringify(item)));
      if (r && r.ok === false) throw new Error(r.error);
      return r;
    }
    mem[e] = mem[e] || [];
    let row = item.id && mem[e].find(x => x.id === item.id);
    if (!row) { row = { id: item.id || e.slice(0, 3) + '_' + Date.now() + Math.random().toString(36).slice(2, 6), created_at: Date.now(), deleted: 0 }; mem[e].push(row); }
    Object.assign(row, item, { updated_at: Date.now() });
    return row;
  }
  function saveMany(e, items) {
    if (!items.length) return [];
    if (NATIVE) return JSON.parse(root.CahangirBridge.saveEntities(e, JSON.stringify(items)));
    return items.map(i => save(e, i));
  }
  function del(e, id) { if (NATIVE) return root.CahangirBridge.deleteEntity(e, id); const r = (mem[e] || []).find(x => x.id === id); if (r) r.deleted = 1; return !!r; }
  const settings = () => (root.__cg && root.__cg.store ? root.__cg.store.settings : {});
  const prefs = () => ({ dayStart: settings().plannerDayStart || '08:00', dayEnd: settings().plannerDayEnd || '22:00' });
  const data = () => ({ tasks: list('tasks'), events: list('events'), blocks: list('plan_blocks'), reminders: list('reminders') });

  function toInput(ms) {
    if (!ms) return '';
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  const fromInput = s => (s ? new Date(s).getTime() : null);
  const prioLabel = { urgent: 'təcili', high: 'yüksək', medium: 'orta', low: 'aşağı' };

  /* ---------------- planner state ---------------- */
  const UI = { tab: 'today', parsed: null, plan: null, opts: { allowLate: [], extendMinutes: 0, release: [], boost: [] }, aiAvailable: null, weekOffset: 0 };

  async function understand(text) {
    const rules = Object.assign(P.parse(text, Date.now(), { lang: L }), { source: 'rules' });
    if (!settings().useAi || !NATIVE) return rules;
    try {
      const now = new Date();
      const res = await root.nativeAsync('aiPost', '/api/ai/parse', JSON.stringify({
        text, now_local: toInput(now.getTime()), tz_offset_minutes: -now.getTimezoneOffset(), weekday: now.toLocaleDateString('en-US', { weekday: 'long' })
      }));
      if (res.status !== 200) {
        const d = res.body && res.body.detail;
        return Object.assign(rules, { aiError: (d && (d.message || d)) || ('HTTP ' + res.status) });
      }
      const b = res.body;
      return { tasks: b.tasks || [], events: b.events || [], notes: [], source: 'ai:' + b.provider,
        questions: (b.questions || []).map((q, i) => ({ kind: 'ai', index: i, text: q })) };
    } catch (e) {
      return Object.assign(rules, { aiError: e.message });
    }
  }

  function renderParsed() {
    const box = $('plParsed'); const p = UI.parsed;
    if (!p) { box.innerHTML = ''; box.classList.add('hide'); return; }
    box.classList.remove('hide');
    let h = '<p class="note">' + esc(p.source === 'rules' ? (p.aiError ? 'AI əlçatmazdır (' + p.aiError + '), daxili qaydalar istifadə olundu.' : 'Daxili qaydalarla anlaşıldı (oflayn).') : 'AI ilə anlaşıldı: ' + p.source.slice(3)) + '</p>';
    if (!p.tasks.length && !p.events.length) h += '<div class="empty">Heç nə tapılmadı. Daha ətraflı yazın.</div>';
    p.tasks.forEach((t, i) => {
      h += '<div class="plan-item" data-k="t" data-i="' + i + '"><input class="pi-title" value="' + esc(t.title) + '">' +
        '<div class="two"><label class="col">Son tarix<input type="datetime-local" class="pi-deadline" value="' + toInput(t.deadline) + '"></label>' +
        '<label class="col">Müddət (dəq)<input type="number" min="5" step="5" class="pi-est" value="' + (t.estimated_minutes == null ? '' : t.estimated_minutes) + '"></label></div>' +
        '<div class="two"><label class="col">Prioritet<select class="pi-prio">' + ['urgent', 'high', 'medium', 'low'].map(x => '<option value="' + x + '"' + (x === t.priority ? ' selected' : '') + '>' + prioLabel[x] + '</option>').join('') + '</select></label>' +
        '<button class="btn ghost small pi-del" type="button">✕ Sil</button></div></div>';
    });
    p.events.forEach((e, i) => {
      h += '<div class="plan-item" data-k="e" data-i="' + i + '"><span class="badge">öhdəlik</span><input class="pi-title" value="' + esc(e.title) + '">' +
        '<div class="two"><label class="col">Başlama<input type="datetime-local" class="pi-start" value="' + toInput(e.start_at) + '"></label>' +
        '<label class="col">Müddət (dəq)<input type="number" min="5" step="5" class="pi-dur" value="' + (e.duration_minutes == null ? '' : e.duration_minutes) + '"></label></div>' +
        '<button class="btn ghost small pi-del" type="button">✕ Sil</button></div>';
    });
    if (p.questions.length) h += '<div class="conflict"><b>Dəqiqləşdirmə</b>' + p.questions.map(q => '<div>• ' + esc(q.text) + '</div>').join('') + '</div>';
    (p.notes || []).forEach(n => { h += '<p class="note">ℹ ' + esc(n) + '</p>'; });
    h += '<div class="two"><button class="btn ghost" id="plDiscard" type="button">İmtina</button><button class="btn primary" id="plSave" type="button">✓ Saxla</button></div>';
    box.innerHTML = h;
  }

  function readParsedEdits() {
    const p = UI.parsed; if (!p) return;
    document.querySelectorAll('#plParsed .plan-item').forEach(el => {
      const i = +el.dataset.i;
      if (el.dataset.k === 't') {
        const t = p.tasks[i]; t.title = el.querySelector('.pi-title').value.trim();
        t.deadline = fromInput(el.querySelector('.pi-deadline').value);
        const est = el.querySelector('.pi-est').value; t.estimated_minutes = est ? +est : null;
        t.priority = el.querySelector('.pi-prio').value;
      } else {
        const e = p.events[i]; e.title = el.querySelector('.pi-title').value.trim();
        e.start_at = fromInput(el.querySelector('.pi-start').value) || e.start_at;
        const d = el.querySelector('.pi-dur').value; e.duration_minutes = d ? +d : null; e.end_at = d ? e.start_at + d * 60000 : null;
      }
    });
  }

  function saveParsed() {
    readParsedEdits();
    const p = UI.parsed;
    const tasks = saveMany('tasks', p.tasks.filter(t => t.title).map(t => ({ title: t.title, description: t.description || '', category: t.category || P.categorize(t.title), priority: t.priority || 'medium', deadline: t.deadline, estimated_minutes: t.estimated_minutes, status: 'todo', source: p.source })));
    const events = saveMany('events', p.events.filter(e => e.title && e.start_at).map(e => ({ title: e.title, start_at: e.start_at, end_at: e.end_at, recurrence: e.recurrence ? JSON.stringify(e.recurrence) : null, confirmed: 1, source: p.source })));
    const rems = [];
    tasks.forEach(t => rems.push.apply(rems, P.deadlineReminders(t, Date.now(), prefs(), L)));
    events.forEach(e => { if (e.start_at > Date.now() || e.recurrence) rems.push(P.eventReminder(e, prefs(), L)); });
    saveMany('reminders', rems);
    toast('Saxlanıldı: ' + tasks.length + ' tapşırıq, ' + events.length + ' öhdəlik');
    UI.parsed = null; $('plText').value = '';
    renderPlanner();
  }

  function makePlan() {
    const d = data();
    UI.plan = P.schedule({ tasks: d.tasks, events: d.events, blocks: d.blocks, now: Date.now(), prefs: prefs(), lang: L, allowLate: UI.opts.allowLate, extendMinutes: UI.opts.extendMinutes, release: UI.opts.release, boost: UI.opts.boost });
    renderPlan();
  }

  function renderPlan() {
    const box = $('plPlan'); const pl = UI.plan;
    if (!pl) { box.innerHTML = ''; box.classList.add('hide'); return; }
    box.classList.remove('hide');
    const tasks = Object.fromEntries(list('tasks').map(t => [t.id, t]));
    let h = '<h3>Təklif olunan plan</h3>';
    if (!pl.add.length && !pl.remove.length) h += '<div class="empty">Planlaşdırılacaq yeni iş yoxdur.</div>';
    pl.add.forEach(b => {
      h += '<div class="it"><div class="tx"><b>' + esc(P.fmtWhen(b.start_at, L)) + '–' + P.fmtClock(b.end_at) + '</b> ' + esc((tasks[b.task_id] || {}).title) +
        '<span class="meta">Niyə: ' + esc(b.reason) + '</span></div></div>';
    });
    if (pl.remove.length) h += '<p class="note">' + pl.remove.length + ' sessiya köçürüləcək.</p>';
    pl.conflicts.forEach((c, i) => {
      h += '<div class="conflict' + (c.type === 'deadline_at_risk' || c.type === 'overdue' ? ' bad' : '') + '">' + esc(c.message) +
        c.alternatives.map((a, j) => '<button class="btn small alt" type="button" data-c="' + i + '" data-a="' + j + '">' + esc(a.message) + '</button>').join('') + '</div>';
    });
    pl.unscheduled.forEach(u => { h += '<div class="conflict">' + esc(u.message) + '</div>'; });
    h += '<div class="two"><button class="btn ghost" id="plPlanDiscard" type="button">İmtina</button><button class="btn primary" id="plAccept" type="button"' + (!pl.add.length && !pl.remove.length ? ' disabled' : '') + '>✓ Planı qəbul et</button></div>';
    box.innerHTML = h;
  }

  function chooseAlt(ci, ai) {
    const c = UI.plan.conflicts[ci], a = c.alternatives[ai];
    if (a.type === 'allow_late') UI.opts.allowLate.push(c.task_id);
    else if (a.type === 'extend_day') UI.opts.extendMinutes = a.extend_minutes || 120;
    else if (a.type === 'move_lower_priority') { UI.opts.release = UI.opts.release.concat(a.block_ids || []); UI.opts.boost.push(c.task_id); }
    else if (a.type === 'reduce_estimate') { UI.tab = 'tasks'; UI.editTask = c.task_id; UI.plan = null; renderPlanner(); return; }
    makePlan();
  }

  function acceptPlan() {
    const pl = UI.plan; const tasks = list('tasks'); const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    pl.remove.forEach(id => { del('plan_blocks', id); del('reminders', 'rem_blk_' + id.replace(/[^A-Za-z0-9_-]/g, '')); });
    saveMany('plan_blocks', pl.add);
    const rems = pl.add.map(b => P.blockReminder(b, byId[b.task_id], prefs(), L));
    Array.from(new Set(pl.add.map(b => b.task_id))).forEach(id => { if (byId[id]) rems.push.apply(rems, P.deadlineReminders(byId[id], Date.now(), prefs(), L)); });
    saveMany('reminders', rems);
    UI.plan = null; UI.opts = { allowLate: [], extendMinutes: 0, release: [], boost: [] };
    toast('Plan saxlanıldı, xatırlatmalar quruldu');
    renderPlanner();
  }

  function agendaHTML(items, blocks) {
    if (!items.length) return '<div class="empty">Bu gün üçün heç nə yoxdur.</div>';
    return items.map(it => {
      const b = it.type === 'block' ? blocks.find(x => x.id === it.id) : null;
      const time = P.fmtClock(it.start) + (it.end > it.start ? '–' + P.fmtClock(it.end) : '');
      const tag = it.type === 'event' ? '<span class="badge">öhdəlik</span>' : it.type === 'deadline' ? '<span class="badge late">son tarix</span>' : it.type === 'reminder' ? '🔔 ' : '';
      let acts = '';
      if (b && b.status !== 'done') acts = '<button type="button" data-blk="done" data-id="' + esc(b.id) + '" title="Tamamlandı">✓</button>' +
        '<button type="button" data-blk="skip" data-id="' + esc(b.id) + '" title="Ötür">⤼</button>' +
        '<button type="button" data-blk="lock" data-id="' + esc(b.id) + '" title="' + (b.locked ? 'Sabitləməni götür' : 'Sabitlə') + '">' + (b.locked ? '🔓' : '📌') + '</button>';
      return '<div class="it' + (b && b.status === 'done' ? ' d' : '') + '"><div class="tx"><b>' + time + '</b> ' + tag + esc(it.title) + (it.locked ? ' 📌' : '') +
        (it.reason ? '<span class="meta">Niyə: ' + esc(it.reason) + '</span>' : '') +
        (it.unknown_length ? '<span class="meta">müddət bilinmir — 60 dəq götürülür</span>' : '') + '</div>' + acts + '</div>';
    }).join('');
  }

  function taskRow(t) {
    const planned = list('plan_blocks').filter(b => b.task_id === t.id && b.status !== 'skipped').reduce((s, b) => s + (b.end_at - b.start_at) / 60000, 0);
    const meta = [prioLabel[t.priority] || t.priority, t.category, t.deadline ? 'son: ' + P.fmtWhen(t.deadline, L) : null,
      t.estimated_minutes ? P.fmtMinutes(t.estimated_minutes, L) : 'müddət?', planned ? 'planlanıb ' + Math.round(planned) + ' dəq' : null].filter(Boolean).join(' · ');
    return '<div class="it' + (t.status === 'done' ? ' d' : '') + '"><input type="checkbox" data-task="toggle" data-id="' + esc(t.id) + '"' + (t.status === 'done' ? ' checked' : '') + '>' +
      '<div class="tx">' + esc(t.title) + '<span class="meta' + (t.deadline && t.deadline < Date.now() && t.status !== 'done' ? ' late' : '') + '">' + esc(meta) + '</span></div>' +
      '<button type="button" data-task="edit" data-id="' + esc(t.id) + '">✎</button><button type="button" data-task="del" data-id="' + esc(t.id) + '">✕</button></div>';
  }

  function taskEditor(t) {
    t = t || { title: '', priority: 'medium', category: 'general', deadline: null, estimated_minutes: null, status: 'todo' };
    return '<div class="card sec" id="plTaskEd" data-id="' + esc(t.id || '') + '"><h3>' + (t.id ? 'Tapşırığa düzəliş' : 'Yeni tapşırıq') + '</h3>' +
      '<input id="teTitle" value="' + esc(t.title) + '" placeholder="Ad">' +
      '<div class="two"><label class="col">Son tarix<input type="datetime-local" id="teDeadline" value="' + toInput(t.deadline) + '"></label>' +
      '<label class="col">Müddət (dəq)<input type="number" id="teEst" min="5" step="5" value="' + (t.estimated_minutes == null ? '' : t.estimated_minutes) + '"></label></div>' +
      '<div class="two"><label class="col">Prioritet<select id="tePrio">' + ['urgent', 'high', 'medium', 'low'].map(x => '<option value="' + x + '"' + (x === t.priority ? ' selected' : '') + '>' + prioLabel[x] + '</option>').join('') + '</select></label>' +
      '<label class="col">Status<select id="teStatus">' + [['todo', 'gözləyir'], ['in_progress', 'davam edir'], ['done', 'bitib'], ['cancelled', 'ləğv']].map(x => '<option value="' + x[0] + '"' + (x[0] === t.status ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select></label></div>' +
      '<div class="two"><button class="btn ghost" type="button" id="teCancel">Ləğv et</button><button class="btn primary" type="button" id="teSave">Saxla</button></div></div>';
  }

  function eventEditor(e) {
    e = e || { title: '', start_at: Math.ceil((Date.now() + 3600000) / 900000) * 900000, end_at: null, recurrence: null };
    const rec = e.recurrence ? (JSON.parse(e.recurrence).type) : '';
    return '<div class="card sec" id="plEvEd" data-id="' + esc(e.id || '') + '"><h3>' + (e.id ? 'Öhdəliyə düzəliş' : 'Yeni öhdəlik') + '</h3>' +
      '<input id="eeTitle" value="' + esc(e.title) + '" placeholder="Ad (məs: İngilis dili dərsi)">' +
      '<div class="two"><label class="col">Başlama<input type="datetime-local" id="eeStart" value="' + toInput(e.start_at) + '"></label>' +
      '<label class="col">Müddət (dəq)<input type="number" id="eeDur" min="5" step="5" value="' + (e.end_at ? Math.round((e.end_at - e.start_at) / 60000) : '') + '"></label></div>' +
      '<label class="col">Təkrar<select id="eeRep"><option value="">yoxdur</option><option value="daily"' + (rec === 'daily' ? ' selected' : '') + '>hər gün</option><option value="weekly"' + (rec === 'weekly' ? ' selected' : '') + '>hər həftə</option></select></label>' +
      '<div class="two"><button class="btn ghost" type="button" id="eeCancel">Ləğv et</button><button class="btn primary" type="button" id="eeSave">Saxla</button></div></div>';
  }

  function renderPlanner() {
    if (!$('v-plan')) return;
    renderParsed(); renderPlan();
    document.querySelectorAll('#plTabs button').forEach(b => b.classList.toggle('primary', b.dataset.tab === UI.tab));
    const d = data(); const now = Date.now(); const body = $('plBody'); let h = '';
    if (UI.tab === 'today') {
      const a = P.dayAgenda(d, now, prefs());
      h += '<p class="note">Boş vaxt: ' + P.fmtMinutes(a.free_minutes, L) + (a.free.length ? ' · ' + a.free.map(f => P.fmtClock(f.start) + '–' + P.fmtClock(f.end)).join(', ') : '') + '</p>';
      h += agendaHTML(a.items, d.blocks);
      const od = P.overdueTasks(d.tasks, now);
      if (od.length) h += '<div class="sect">Gecikmiş</div>' + od.map(taskRow).join('');
    } else if (UI.tab === 'week') {
      h += '<div class="two"><button class="btn small" type="button" data-wk="-1">‹ Əvvəlki</button><button class="btn small" type="button" data-wk="1">Sonrakı ›</button></div>';
      P.weekOverview(d, P.addDays(P.startOfWeek(now), UI.weekOffset * 7), prefs()).forEach(day => {
        const lab = new Date(day.day).toLocaleDateString('az-AZ', { weekday: 'long', day: 'numeric', month: 'short' });
        h += '<div class="sect">' + esc(lab) + (P.sod(now) === day.day ? ' (bu gün)' : '') + ' · boş ' + P.fmtMinutes(day.free_minutes, L) + ' · plan ' + P.fmtMinutes(day.planned_minutes, L) + '</div>';
        const items = day.items.filter(i => i.type !== 'reminder');
        h += items.length ? items.map(i => '<div class="it"><div class="tx">' + (i.type === 'deadline' ? '⚑ ' : '<b>' + P.fmtClock(i.start) + '</b> ') + esc(i.title) + '</div></div>').join('') : '<div class="empty">—</div>';
      });
    } else if (UI.tab === 'tasks') {
      h += '<button class="btn primary" type="button" id="plNewTask">＋ Yeni tapşırıq</button>';
      if (UI.editTask !== undefined) h += taskEditor(UI.editTask ? d.tasks.find(t => t.id === UI.editTask) : null);
      const od = P.overdueTasks(d.tasks, now), up = P.upcomingDeadlines(d.tasks, now, 7), g = P.byPriority(d.tasks), done = P.completedTasks(d.tasks);
      if (od.length) h += '<div class="sect">Gecikmiş</div>' + od.map(taskRow).join('');
      h += '<div class="sect">Yaxın 7 gündə son tarix</div>' + (up.length ? up.map(taskRow).join('') : '<div class="empty">Yoxdur.</div>');
      h += '<div class="sect">Prioritetə görə</div>';
      const open = ['urgent', 'high', 'medium', 'low'].flatMap(p => g[p]);
      h += open.length ? open.map(taskRow).join('') : '<div class="empty">Açıq tapşırıq yoxdur. Yuxarıda yazın: “cüməyə qədər tapşırıq, 2 saat”.</div>';
      if (done.length) h += '<div class="sect">Tamamlanmış</div>' + done.slice(0, 15).map(taskRow).join('');
    } else {
      h += '<button class="btn primary" type="button" id="plNewEvent">＋ Yeni öhdəlik</button>';
      if (UI.editEvent !== undefined) h += eventEditor(UI.editEvent ? d.events.find(e => e.id === UI.editEvent) : null);
      const evs = d.events.slice().sort((a, b) => a.start_at - b.start_at);
      h += evs.length ? evs.map(e => '<div class="it"><div class="tx">' + esc(e.title) + '<span class="meta">' + esc(P.fmtWhen(e.start_at, L)) + (e.end_at ? '–' + P.fmtClock(e.end_at) : ' (müddət?)') +
        (e.recurrence ? ' · 🔁 ' + (JSON.parse(e.recurrence).type === 'daily' ? 'hər gün' : 'hər həftə') : '') + '</span></div>' +
        '<button type="button" data-ev="edit" data-id="' + esc(e.id) + '">✎</button><button type="button" data-ev="del" data-id="' + esc(e.id) + '">✕</button></div>').join('') : '<div class="empty">Öhdəlik yoxdur.</div>';
    }
    body.innerHTML = h;
  }

  function bindPlanner() {
    const v = $('v-plan'); if (!v) return;
    $('plUnderstand').addEventListener('click', async () => {
      const text = $('plText').value.trim(); if (!text) return;
      $('plUnderstand').disabled = true;
      try { UI.parsed = await understand(text); } finally { $('plUnderstand').disabled = false; }
      renderParsed();
    });
    $('plMake').addEventListener('click', makePlan);
    $('plUseAi').addEventListener('change', e => root.__cg.store.setSetting('useAi', e.target.checked));
    v.addEventListener('click', e => {
      const t = e.target;
      if (t.id === 'plSave') return saveParsed();
      if (t.id === 'plDiscard') { UI.parsed = null; return renderParsed(); }
      if (t.classList.contains('pi-del')) { readParsedEdits(); const it = t.closest('.plan-item'); UI.parsed[it.dataset.k === 't' ? 'tasks' : 'events'].splice(+it.dataset.i, 1); return renderParsed(); }
      if (t.id === 'plAccept') return acceptPlan();
      if (t.id === 'plPlanDiscard') { UI.plan = null; UI.opts = { allowLate: [], extendMinutes: 0, release: [], boost: [] }; return renderPlan(); }
      if (t.classList.contains('alt')) return chooseAlt(+t.dataset.c, +t.dataset.a);
      if (t.dataset.tab) { UI.tab = t.dataset.tab; return renderPlanner(); }
      if (t.dataset.wk) { UI.weekOffset += +t.dataset.wk; return renderPlanner(); }
      if (t.dataset.blk) {
        const id = t.dataset.id; const b = list('plan_blocks').find(x => x.id === id); if (!b) return;
        if (t.dataset.blk === 'done') save('plan_blocks', { id, status: 'done' });
        else if (t.dataset.blk === 'skip') save('plan_blocks', { id, status: 'skipped' });
        else save('plan_blocks', { id, locked: b.locked ? 0 : 1 });
        return renderPlanner();
      }
      if (t.dataset.task) {
        const id = t.dataset.id; const task = list('tasks').find(x => x.id === id); if (!task) return;
        if (t.dataset.task === 'toggle') {
          const done = task.status !== 'done';
          save('tasks', { id, status: done ? 'done' : 'todo', completed_at: done ? Date.now() : null });
          if (done) list('reminders').filter(r => r.task_id === id && !r.done).forEach(r => save('reminders', { id: r.id, done: 1 }));
        } else if (t.dataset.task === 'edit') { UI.editTask = id; }
        else if (confirm('"' + task.title + '" silinsin?')) {
          del('tasks', id);
          list('plan_blocks').filter(b => b.task_id === id && b.end_at > Date.now()).forEach(b => del('plan_blocks', b.id));
          list('reminders').filter(r => r.task_id === id).forEach(r => del('reminders', r.id));
        }
        return renderPlanner();
      }
      if (t.id === 'plNewTask') { UI.editTask = null; return renderPlanner(); }
      if (t.id === 'teCancel') { UI.editTask = undefined; return renderPlanner(); }
      if (t.id === 'teSave') {
        const ed = $('plTaskEd'); const title = $('teTitle').value.trim(); if (!title) return;
        const status = $('teStatus').value;
        const item = { title, deadline: fromInput($('teDeadline').value), estimated_minutes: $('teEst').value ? +$('teEst').value : null, priority: $('tePrio').value, status, completed_at: status === 'done' ? Date.now() : null };
        if (ed.dataset.id) item.id = ed.dataset.id; else item.category = P.categorize(title);
        const saved = save('tasks', item);
        saveMany('reminders', P.deadlineReminders(saved, Date.now(), prefs(), L));
        UI.editTask = undefined; return renderPlanner();
      }
      if (t.id === 'plNewEvent') { UI.editEvent = null; return renderPlanner(); }
      if (t.id === 'eeCancel') { UI.editEvent = undefined; return renderPlanner(); }
      if (t.id === 'eeSave') {
        const ed = $('plEvEd'); const title = $('eeTitle').value.trim(); const start = fromInput($('eeStart').value); if (!title || !start) return;
        const dur = $('eeDur').value ? +$('eeDur').value : null; const rep = $('eeRep').value;
        const item = { title, start_at: start, end_at: dur ? start + dur * 60000 : null, confirmed: 1,
          recurrence: rep === 'daily' ? '{"type":"daily"}' : rep === 'weekly' ? JSON.stringify({ type: 'weekly', wday: new Date(start).getDay() }) : null };
        if (ed.dataset.id) item.id = ed.dataset.id;
        const saved = save('events', item);
        save('reminders', P.eventReminder(saved, prefs(), L));
        UI.editEvent = undefined; return renderPlanner();
      }
      if (t.dataset.ev) {
        const id = t.dataset.id;
        if (t.dataset.ev === 'edit') UI.editEvent = id;
        else if (confirm('Öhdəlik silinsin?')) { del('events', id); del('reminders', 'rem_evt_' + id.replace(/[^A-Za-z0-9_-]/g, '')); }
        return renderPlanner();
      }
    });
  }

  /* ---------------- connectivity: clipboard, files, devices, server ---------------- */
  let peers = [];
  async function refreshPeers() {
    if (!NATIVE) return [];
    try { peers = (await root.nativeAsync('listPairedDevices')) || []; } catch (e) { peers = []; }
    return peers;
  }
  const myId = () => (root.cahangirGetServerStatus() || {}).deviceId;
  function peerOptions(sel) {
    const me = myId();
    const opts = [];
    peers.filter(d => d.device_id !== me && d.p2p_port).forEach(d => (d.p2p_hosts || []).forEach(h => opts.push({ v: d.device_id + '|' + h + '|' + d.p2p_port, t: d.device_name + ' · ' + h + (h.indexOf('100.') === 0 ? ' (Tailscale)' : ' (LAN)') })));
    sel.innerHTML = '<option value="">— cütləşdirilmiş cihaz seçin —</option>' + opts.map(o => '<option value="' + esc(o.v) + '">' + esc(o.t) + '</option>').join('') + '<option value="manual">Ünvanı əl ilə daxil et…</option>';
  }

  function renderClipboard() {
    if (!$('clipList')) return;
    const st = root.cahangirGetServerStatus();
    $('clipAccept').checked = st.clipboardAccept !== false;
    const items = list('clipboard_items').sort((a, b) => b.created_at - a.created_at).slice(0, 60);
    $('clipList').innerHTML = items.length ? items.map(i => '<div class="it"><div class="tx" style="white-space:pre-wrap">' + esc(i.text.slice(0, 600)) +
      '<span class="meta">' + esc(i.origin_name || '?') + ' · ' + new Date(i.created_at).toLocaleString('az-AZ') + (i.sync_status ? ' · sinx gözləyir' : '') + '</span></div>' +
      '<button type="button" data-clip="copy" data-id="' + esc(i.id) + '">📋</button><button type="button" data-clip="del" data-id="' + esc(i.id) + '">✕</button></div>').join('')
      : '<div class="empty">Hələ heç nə paylaşılmayıb.</div>';
  }
  async function shareClip(text) {
    $('clipSendStatus').textContent = 'Göndərilir…';
    try {
      const r = await root.nativeAsync('shareClipboard', text || '');
      $('clipSendStatus').textContent = r.delivered_direct.length ? '✓ Birbaşa çatdırıldı: ' + r.delivered_direct.join(', ') + '. Digərləri sinxronda alacaq.' : '✓ Saxlanıldı — cihazlar növbəti sinxronda alacaq.';
      $('clipText').value = '';
    } catch (e) { $('clipSendStatus').textContent = 'Xəta: ' + e.message; }
    renderClipboard();
  }

  function renderFiles() {
    if (!$('ftrList')) return;
    const st = root.nativeJson('getP2pServerStatus') || {};
    $('ftrMyAddr').textContent = st.isRunning ? 'Bu telefon qəbul edir: ' + (st.ips || []).join(', ') + ' : ' + st.port + (st.p2pReady ? '' : ' — P2P açarı yoxdur (serverlə sinxron edin)') : 'Qəbuledici işləmir';
    const hist = root.cahangirGetTransferHistory();
    $('ftrList').innerHTML = hist.length ? hist.map(t => '<div class="it"><div class="tx">' + (t.direction === 'send' ? '↑ ' : '↓ ') + esc(t.filename) +
      '<span class="meta">' + esc(t.peerDevice || t.peer_device || '') + ' · ' + (((t.fileSize || t.file_size || 0) / 1048576).toFixed(2)) + ' MB · ' + esc(t.status) +
      (t.sha256 ? ' · SHA-256 ' + esc(t.sha256.slice(0, 12)) + '…' : '') + '</span></div></div>').join('') : '<div class="empty">Tarixçə boşdur.</div>';
  }
  function selectedPeer() {
    const v = $('ftrPeer').value;
    if (v === 'manual') return { host: $('ftrPeerIp').value.trim(), port: +$('ftrPeerPort').value || 8767, name: $('ftrPeerIp').value.trim() };
    if (!v) return null;
    const [id, host, port] = v.split('|');
    const d = peers.find(p => p.device_id === id);
    return { host, port: +port, name: d ? d.device_name : host };
  }

  async function renderDevices() {
    const el = $('connDeviceList'); if (!el) return;
    const st = root.cahangirGetServerStatus();
    if (!st.isConfigured) { el.innerHTML = '<div class="empty">Server qoşulmayıb. Ayarlar → Mərkəzi server bölməsində bu telefonu qoşun.</div>'; return; }
    el.innerHTML = '<p class="note">Yüklənir…</p>';
    const list2 = await refreshPeers();
    if (!list2.length) { el.innerHTML = '<div class="empty">Cihaz siyahısı alınmadı (server əlçatmaz ola bilər).</div>'; return; }
    el.innerHTML = list2.map(d => '<div class="it"><div class="tx">' + esc(d.device_name) + (d.device_id === st.deviceId ? ' <span class="badge">bu telefon</span>' : '') +
      '<span class="meta">' + esc(d.platform || '?') + ' · son sinx: ' + (d.last_sync_at ? new Date(d.last_sync_at).toLocaleString('az-AZ') : '—') +
      (d.p2p_hosts && d.p2p_hosts.length ? ' · P2P ' + esc(d.p2p_hosts.join(', ')) + ':' + d.p2p_port : '') + '</span></div>' +
      (d.device_id !== st.deviceId ? '<button type="button" data-revoke="' + esc(d.device_id) + '" title="Girişi ləğv et">⛔</button>' : '') + '</div>').join('');
  }

  function renderServer() {
    if (!$('sSyncStatus')) return;
    const st = root.cahangirGetServerStatus();
    if ($('sSyncUrl') && !$('sSyncUrl').value) $('sSyncUrl').value = st.serverUrl || '';
    $('sSyncTokenRow').classList.toggle('hide', !!st.isConfigured);
    $('sSyncSave').classList.toggle('hide', !!st.isConfigured);
    $('sUnpair').classList.toggle('hide', !st.isConfigured);
    $('sAutoSync').value = String(st.autoSyncMinutes || 0);
    const s = $('sSyncStatus');
    if (!st.isConfigured) { s.textContent = 'Oflayn / lokal rejim — server qoşulmayıb. Bütün funksiyalar telefonda işləyir.'; s.style.color = ''; }
    else {
      s.textContent = (st.status === 'error' ? '⚠ ' + st.error : '✓ Qoşulub: ' + st.serverUrl) + ' · son sinx: ' + (st.lastSync ? new Date(st.lastSync).toLocaleString('az-AZ') : 'heç vaxt') +
        ' · gözləyən: ' + st.pending + (st.p2pReady ? ' · P2P ✓' : '');
      s.style.color = st.status === 'error' ? 'var(--bad)' : 'var(--ok)';
    }
    const perm = root.nativeJson('getPermissionStatus');
    if (perm && $('sPermNote')) {
      const miss = [];
      if (!perm.notifications) miss.push('<button class="btn small" type="button" data-perm="notif">Bildirişlərə icazə ver</button>');
      if (!perm.exactAlarms) miss.push('<button class="btn small" type="button" data-perm="exact">Dəqiq zəngə icazə ver</button>');
      if (!perm.fullScreen) miss.push('<button class="btn small" type="button" data-perm="fullscreen">Tam ekran xəbərdarlığa icazə ver</button>');
      $('sPermNote').innerHTML = miss.length ? 'Xatırlatmaların vaxtında çalması üçün: ' + miss.join(' ') : '✓ Bildiriş, dəqiq zəng və tam ekran icazələri verilib.';
    }
  }

  function bindConnectivity() {
    if ($('clipShareBtn')) $('clipShareBtn').addEventListener('click', () => shareClip(''));
    if ($('clipSendBtn')) $('clipSendBtn').addEventListener('click', () => { const t = $('clipText').value; if (t.trim()) shareClip(t); });
    if ($('clipAccept')) $('clipAccept').addEventListener('change', e => root.nativeCall('setClipboardAccept', e.target.checked));
    if ($('clipList')) $('clipList').addEventListener('click', e => {
      const b = e.target.closest('[data-clip]'); if (!b) return;
      const it = list('clipboard_items').find(x => x.id === b.dataset.id); if (!it) return;
      if (b.dataset.clip === 'copy') root.cahangirCopyClipboard(it.text); else { del('clipboard_items', it.id); renderClipboard(); }
    });
    if ($('ftrPeer')) $('ftrPeer').addEventListener('change', e => $('ftrManual').classList.toggle('hide', e.target.value !== 'manual'));
    if ($('ftrPing')) $('ftrPing').addEventListener('click', async () => {
      const p = selectedPeer(); if (!p) return;
      $('ftrStatusLine').textContent = 'Yoxlanılır…';
      try { const r = await root.nativeAsync('pingPeer', p.host, p.port); $('ftrStatusLine').textContent = '✓ ' + r.device_name + ' (' + (r.platform || '?') + ')'; }
      catch (e) { $('ftrStatusLine').textContent = '✗ ' + e.message; }
    });
    if ($('ftrPickBtn')) $('ftrPickBtn').addEventListener('click', () => {
      const p = selectedPeer(); if (!p || !p.host) { toast('Cihaz seçin'); return; }
      root.nativeCall('pickAndSendFile', p.host, p.port, p.name);
    });
    if ($('ftrCancelBtn')) $('ftrCancelBtn').addEventListener('click', () => root.nativeCall('cancelFileTransfer'));
    if ($('ftrClearBtn')) $('ftrClearBtn').addEventListener('click', () => { root.nativeCall('clearTransferHistory'); renderFiles(); });
    if ($('connRefreshBtn')) $('connRefreshBtn').addEventListener('click', renderDevices);
    if ($('connDeviceList')) $('connDeviceList').addEventListener('click', async e => {
      const b = e.target.closest('[data-revoke]'); if (!b) return;
      const tok = prompt('Bu cihazın girişini ləğv etmək üçün admin pairing token daxil edin (saxlanılmır):');
      if (!tok) return;
      try { await root.nativeAsync('revokeDevice', tok, b.dataset.revoke); toast('Ləğv edildi; P2P açarı yeniləndi'); } catch (err) { toast('Xəta: ' + err.message); }
      renderDevices();
    });
    if ($('sSyncSave')) $('sSyncSave').addEventListener('click', async () => {
      const url = $('sSyncUrl').value.trim(), tok = $('sSyncToken').value.trim();
      if (!url || !tok) { toast('Server URL və admin token daxil edin'); return; }
      $('sSyncStatus').textContent = 'Qoşulur…';
      try { await root.nativeAsync('pair', url, tok, $('sDeviceName').value.trim()); $('sSyncToken').value = ''; toast('✓ Qoşuldu. Admin token telefonda saxlanılmadı.'); }
      catch (e) { toast('Qoşulmaq olmadı: ' + e.message); }
      renderServer();
    });
    if ($('sSyncTest')) $('sSyncTest').addEventListener('click', async () => {
      try { const h = await root.nativeAsync('testServer', $('sSyncUrl').value.trim()); toast('✓ Server əlçatandır (v' + h.version + ')'); }
      catch (e) { toast('✗ ' + e.message); }
    });
    if ($('sSyncNow')) $('sSyncNow').addEventListener('click', async () => {
      $('sSyncStatus').textContent = 'Sinxron edilir…';
      try { const r = await root.nativeAsync('syncNow'); toast('Sinxron: göndərildi ' + r.pushed + ', alındı ' + r.received + (r.conflicts ? ', ziddiyyət ' + r.conflicts : '')); }
      catch (e) { toast('Sinxron alınmadı: ' + e.message); }
      root.onNativeDataChanged(); renderServer();
    });
    if ($('sUnpair')) $('sUnpair').addEventListener('click', () => { if (confirm('Telefon serverdən ayrılsın? Lokal məlumat qalır.')) { root.nativeCall('unpair'); renderServer(); } });
    if ($('sAutoSync')) $('sAutoSync').addEventListener('change', e => root.nativeCall('setAutoSyncMinutes', +e.target.value));
    if ($('sPlanStart')) {
      const st = settings();
      $('sPlanStart').value = st.plannerDayStart || '08:00'; $('sPlanEnd').value = st.plannerDayEnd || '22:00';
      $('sPlanStart').addEventListener('change', e => root.__cg.store.setSetting('plannerDayStart', e.target.value));
      $('sPlanEnd').addEventListener('change', e => root.__cg.store.setSetting('plannerDayEnd', e.target.value));
    }
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-perm]'); if (!b) return;
      if (b.dataset.perm === 'notif') root.nativeCall('requestNotificationPermission'); else root.nativeCall('openPermissionSettings', b.dataset.perm);
    });
    if ($('sDeviceName')) { const st = root.cahangirGetServerStatus(); $('sDeviceName').value = st.deviceName || ''; }
  }

  /* ---------------- P2P progress (called from native) ---------------- */
  function showProg(name, pct, speed, dir) {
    const box = $('ftrProgBox'); if (!box) return;
    box.classList.remove('hide');
    $('ftrStatusText').textContent = (dir === 'out' ? '↑ ' : '↓ ') + name;
    $('ftrPercentText').textContent = Math.round(pct) + '%';
    $('ftrProgressBar').style.width = pct + '%';
    $('ftrSpeedText').textContent = (speed || 0).toFixed(2) + ' MB/s';
    $('ftrCancelBtn').classList.toggle('hide', dir !== 'out');
  }
  let curName = '', curDir = '';

  const CgUI = {
    render(view) {
      if (view === 'plan') renderPlanner();
      else if (view === 'clip') renderClipboard();
      else if (view === 'ftr') { renderFiles(); refreshPeers().then(() => { if ($('ftrPeer')) peerOptions($('ftrPeer')); }); }
      else if (view === 'conn') renderDevices();
      else if (view === 'set') renderServer();
    },
    onDataChanged() {
      const v = root.__cg && root.__cg.view ? root.__cg.view() : '';
      if (v === 'plan') renderPlanner(); else if (v === 'clip') renderClipboard(); else if (v === 'set') renderServer();
    },
    p2pTransferStarted(id, name, size, sender) { curName = name; curDir = id === 'outgoing' ? 'out' : 'in'; showProg(name, 0, 0, curDir); },
    p2pTransferProgress(id, sent, total, pct, speed) { showProg(curName, pct, speed, id === 'outgoing' ? 'out' : 'in'); },
    p2pTransferComplete(id, name, size, speed, sha) { $('ftrProgBox') && $('ftrProgBox').classList.add('hide'); toast((id === 'outgoing' ? '✓ Göndərildi: ' : '📥 Qəbul edildi: ') + name + ' (SHA-256 ✓)'); renderFiles(); },
    p2pTransferFailed(err) { $('ftrProgBox') && $('ftrProgBox').classList.add('hide'); toast('Ötürmə xətası: ' + err); renderFiles(); },
    p2pClipboardReceived(text, origin) { toast('📋 ' + origin + ' cihazından pano mətni gəldi'); renderClipboard(); }
  };
  root.CgUI = CgUI;

  function init() {
    bindPlanner(); bindConnectivity();
    if ($('plUseAi')) $('plUseAi').checked = settings().useAi !== false;
    if (NATIVE) {
      root.nativeAsync('aiProviders').then(r => { UI.aiAvailable = !!(r && r.any_available); if (!UI.aiAvailable && $('plAiNote')) $('plAiNote').textContent = '(pulsuz AI provayderi hazırda yoxdur — daxili qaydalar işləyir)'; })
        .catch(() => { if ($('plAiNote')) $('plAiNote').textContent = '(server qoşulmayıb — daxili qaydalar işləyir)'; });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300)); else setTimeout(init, 300);
})(typeof window !== 'undefined' ? window : globalThis);
