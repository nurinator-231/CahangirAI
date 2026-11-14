/* store.js — data access for the UI.
 *
 * Source of truth:
 *  - In the Android app, all domain data (reminders, memories, projects, tasks, events,
 *    plan blocks, clipboard) lives in native SQLite and is read/written through
 *    CahangirBridge (listEntities/saveEntity/deleteEntity). This module keeps an
 *    in-memory cache of it for synchronous rendering.
 *  - UI-only state (settings, profile, chat messages, completion log) stays in
 *    localStorage.
 *  - Without the native bridge (browser/PWA mode) everything is kept in localStorage.
 *
 * Legacy (v1) items stored in localStorage are migrated once into native SQLite,
 * keeping their original ids so rows that v1 already mirrored natively are merged,
 * not duplicated. */
(function (root) {
  'use strict';
  const KEY = 'cahangir.v2';
  const MIGRATED_KEY = 'cahangir.nativeMigrated';
  const KIND_TO_ENTITY = { reminders: 'reminders', memory: 'memories', projects: 'projects' };
  const DEFAULTS = () => ({
    v: 3, seq: 1,
    profile: { name: '', created: Date.now() },
    settings: {
      voice: true, rate: 1, pitch: 1, voiceURI: '', repeatCount: 4, repeatEvery: 25,
      keepAwake: false, handsFree: false, theme: 'blue', sound: 'bell', quietOn: false, quietFrom: '23:00', quietTo: '07:00',
      llm: { mode: 'router', url: '', model: '', key: '', maxTokens: 300 },
      pin: '', plannerDayStart: '08:00', plannerDayEnd: '22:00', useAi: true
    },
    items: [], messages: [], log: []
  });

  function parseJson(s) { if (s == null || s === '') return null; if (typeof s === 'object') return s; try { return JSON.parse(s); } catch (e) { return null; } }

  /* native row -> UI item */
  function fromNative(kind, r) {
    if (kind === 'reminders') {
      return { id: r.id, kind, text: r.text, due: r.due, snooze: r.snooze, done: r.done === 1, timer: r.timer === 1,
        repeat: parseJson(r.repeat), firedAt: r.fired_at || null, created: r.created_at, taskId: r.task_id, rkind: r.kind, pending: r.sync_status === 1 };
    }
    if (kind === 'memory') return { id: r.id, kind, text: r.fact_text, category: r.category, created: r.created_at, pending: r.sync_status === 1 };
    return { id: r.id, kind, text: r.title, done: r.status === 'completed', notes: r.notes, created: r.created_at, pending: r.sync_status === 1 };
  }
  /* UI patch -> native patch */
  function toNative(kind, f) {
    const o = {};
    if (f.id != null) o.id = String(f.id);
    if (kind === 'reminders') {
      if ('text' in f) o.text = f.text;
      if ('due' in f) o.due = f.due;
      if ('snooze' in f) o.snooze = f.snooze;
      if ('done' in f) o.done = f.done ? 1 : 0;
      if ('timer' in f) o.timer = f.timer ? 1 : 0;
      if ('repeat' in f) o.repeat = f.repeat ? JSON.stringify(f.repeat) : null;
      if ('created' in f) o.created_at = f.created;
      if (!o.kind && f.timer) o.kind = 'timer';
    } else if (kind === 'memory') {
      if ('text' in f) o.fact_text = f.text;
      if ('category' in f) o.category = f.category;
      if ('created' in f) o.created_at = f.created;
    } else {
      if ('text' in f) o.title = f.text;
      if ('done' in f) o.status = f.done ? 'completed' : 'active';
      if ('notes' in f) o.notes = f.notes;
      if ('created' in f) o.created_at = f.created;
    }
    return o;
  }

  function create(storage, bridge) {
    let st = null; let mem = null; const subs = [];
    const native = !!(bridge && bridge.listEntities);
    function read() {
      try { const raw = storage && storage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { /* corrupt */ }
      return mem;
    }
    function normalize(o) {
      const d = DEFAULTS();
      if (!o || typeof o !== 'object') return d;
      const s = Object.assign(d, o);
      s.profile = Object.assign(DEFAULTS().profile, o.profile || {});
      s.settings = Object.assign(DEFAULTS().settings, o.settings || {});
      s.settings.llm = Object.assign(DEFAULTS().settings.llm, (o.settings && o.settings.llm) || {});
      s.items = Array.isArray(o.items) ? o.items.filter(i => i && typeof i.text === 'string') : [];
      s.messages = Array.isArray(o.messages) ? o.messages : [];
      s.log = Array.isArray(o.log) ? o.log.filter(x => x && typeof x.text === 'string' && x.ts > 0).slice(-500) : [];
      return s;
    }
    function persistLocal() {
      const copy = Object.assign({}, st);
      if (native) copy.items = []; // domain data is not duplicated in localStorage
      mem = JSON.parse(JSON.stringify(copy));
      try { if (storage) storage.setItem(KEY, JSON.stringify(copy)); } catch (e) { /* full/blocked */ }
    }
    function emit() { subs.forEach(f => { try { f(); } catch (e) { /* subscriber error */ } }); }
    function save() { persistLocal(); emit(); }

    function loadNativeItems() {
      const items = [];
      Object.keys(KIND_TO_ENTITY).forEach(kind => {
        try { JSON.parse(bridge.listEntities(KIND_TO_ENTITY[kind], false)).forEach(r => items.push(fromNative(kind, r))); }
        catch (e) { console.error('[store] listEntities failed', kind, e); }
      });
      return items;
    }
    function migrateLegacy(legacyItems) {
      let done = false;
      try { done = storage && storage.getItem(MIGRATED_KEY) === '1'; } catch (e) { /* */ }
      if (done || !legacyItems.length) { try { storage && storage.setItem(MIGRATED_KEY, '1'); } catch (e) { /* */ } return; }
      Object.keys(KIND_TO_ENTITY).forEach(kind => {
        const rows = legacyItems.filter(i => i.kind === kind).map(i => toNative(kind, Object.assign({}, i, { id: String(i.id) })));
        if (rows.length) bridge.saveEntities(KIND_TO_ENTITY[kind], JSON.stringify(rows));
      });
      try { storage && storage.setItem(MIGRATED_KEY, '1'); } catch (e) { /* */ }
    }

    function load() {
      st = normalize(read());
      if (native) {
        migrateLegacy(st.items);
        st.items = loadNativeItems();
        persistLocal();
      }
      return st;
    }
    load();

    function newId(kind) { return (kind === 'reminders' ? 'rem' : kind === 'memory' ? 'mem' : 'prj') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    const S = {
      native,
      get state() { return st; },
      on(fn) { subs.push(fn); },
      reload() { load(); emit(); },
      /** Re-read native data (after sync / alarm) without touching UI settings. */
      refresh() { if (native) { st.items = loadNativeItems(); } emit(); },
      get profile() { return st.profile; },
      get settings() { return st.settings; },
      setName(n) { st.profile.name = n; if (bridge && bridge.setUserName) bridge.setUserName(n); save(); },
      setSetting(k, v) { st.settings[k] = v; save(); },
      setLLM(patch) { Object.assign(st.settings.llm, patch); save(); },
      items(kind) { return st.items.filter(i => !kind || i.kind === kind); },
      get(id) { id = String(id); return st.items.find(i => String(i.id) === id) || null; },
      add(kind, f) {
        const it = Object.assign({ id: newId(kind), kind, text: '', due: null, done: false, firedAt: null, repeat: null, timer: false, created: Date.now() }, f);
        if (native && KIND_TO_ENTITY[kind]) {
          const saved = JSON.parse(bridge.saveEntity(KIND_TO_ENTITY[kind], JSON.stringify(toNative(kind, it))));
          if (saved && saved.ok === false) throw new Error(saved.error);
          const item = fromNative(kind, saved);
          st.items.push(item); emit(); return item;
        }
        st.items.push(it); save(); return it;
      },
      update(id, patch) {
        const it = S.get(id); if (!it) return null;
        if (native && KIND_TO_ENTITY[it.kind]) {
          const p = toNative(it.kind, Object.assign({ id: it.id }, patch));
          const saved = JSON.parse(bridge.saveEntity(KIND_TO_ENTITY[it.kind], JSON.stringify(p)));
          if (saved && saved.ok === false) throw new Error(saved.error);
          Object.assign(it, fromNative(it.kind, saved));
          if ('firedAt' in patch) it.firedAt = patch.firedAt; // UI-only notion for the in-app view
          emit(); return it;
        }
        Object.assign(it, patch); save(); return it;
      },
      remove(id) {
        const it = S.get(id); if (!it) return;
        if (native && KIND_TO_ENTITY[it.kind]) bridge.deleteEntity(KIND_TO_ENTITY[it.kind], String(it.id));
        st.items = st.items.filter(i => i !== it);
        if (native) emit(); else save();
      },
      removeMany(ids) { ids.forEach(id => S.remove(id)); },
      addMessage(role, text) {
        st.messages.push({ role, text, ts: Date.now() });
        if (st.messages.length > 300) st.messages.splice(0, st.messages.length - 300);
        save();
      },
      messages() { return st.messages; },
      logDone(text, ts) { st.log.push({ text: String(text).slice(0, 120), ts: ts || Date.now() }); if (st.log.length > 500) st.log.splice(0, st.log.length - 500); save(); },
      logToday(now) { const d = new Date(now || Date.now()); const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); return st.log.filter(x => x.ts >= a && x.ts < a + 864e5); },
      clearMessages() { st.messages = []; save(); },
      /** Backup: UI state + every native entity (tasks, events, plan, reminders, …). */
      exportJSON() {
        const data = JSON.parse(JSON.stringify(st));
        const out = { app: 'cahangir-ai', version: 3, exported: new Date().toISOString(), data };
        if (native) {
          data.items = [];
          out.entities = {};
          ['reminders', 'memories', 'projects', 'tasks', 'events', 'plan_blocks', 'clipboard_items'].forEach(e => {
            try { out.entities[e] = JSON.parse(bridge.listEntities(e, false)); } catch (err) { /* */ }
          });
        }
        return JSON.stringify(out, null, 2);
      },
      /** Restore merges into existing data (never deletes); returns number of records. */
      importJSON(text) {
        const o = JSON.parse(text);
        const data = o && o.app === 'cahangir-ai' ? o.data : o;
        if (!data || typeof data !== 'object' || (!Array.isArray(data.items) && !o.entities)) throw new Error('Fayl Cahangir ehtiyat nüsxəsi deyil.');
        const n = normalize(data);
        n.settings.pin = st.settings.pin;
        let count = 0;
        if (native) {
          if (o.entities) {
            Object.keys(o.entities).forEach(e => {
              const rows = (o.entities[e] || []).map(r => { const c = Object.assign({}, r); delete c.sync_status; delete c.server_rev; delete c.fired_at; delete c.updated_at; return c; });
              if (rows.length) { bridge.saveEntities(e, JSON.stringify(rows)); count += rows.length; }
            });
          }
          Object.keys(KIND_TO_ENTITY).forEach(kind => {
            const rows = n.items.filter(i => i.kind === kind).map(i => toNative(kind, Object.assign({}, i, { id: String(i.id) })));
            if (rows.length) { bridge.saveEntities(KIND_TO_ENTITY[kind], JSON.stringify(rows)); count += rows.length; }
          });
          n.items = [];
          st = Object.assign(n, { items: loadNativeItems() });
        } else {
          st = n; count = st.items.length;
        }
        save();
        return count;
      },
      resetAll() { const keepItems = st.items; st = DEFAULTS(); if (native) st.items = keepItems; save(); }
    };
    if (typeof window !== 'undefined' && storage) {
      window.addEventListener('storage', e => { if (e.key === KEY) S.reload(); });
    }
    return S;
  }
  const api = { create, KEY, fromNative, toNative };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CahangirStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
