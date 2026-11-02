/* store.js — yerli (cihazda) saxlama. Server yoxdur, token yoxdur.
   localStorage-ə yazır; əlçatmazdırsa (məxfi rejim) yaddaşda işləyir. */
(function (root) {
  'use strict';
  const KEY = 'cahangir.v2';
  const DEFAULTS = () => ({
    v: 2, seq: 1,
    profile: { name: '', created: Date.now() },
    settings: {
      voice: true, rate: 1, pitch: 1, voiceURI: '', repeatCount: 4, repeatEvery: 25,
      keepAwake: false, handsFree: false, theme: 'blue', sound: 'bell', quietOn: false, quietFrom: '23:00', quietTo: '07:00',
      llm: { mode: 'off', url: '', model: '', key: '', maxTokens: 300 },
      pin: ''
    },
    items: [], messages: [], log: []
  });

  function create(storage) {
    let st = null; let mem = null; const subs = [];
    function read() {
      try { const raw = storage && storage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { /* bozuq JSON */ }
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
      s.seq = Math.max(s.seq || 1, 1 + s.items.reduce((m, i) => Math.max(m, i.id || 0), 0));
      return s;
    }
    function load() { st = normalize(read()); return st; }
    function save() {
      mem = JSON.parse(JSON.stringify(st));
      try { if (storage) storage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* dolu/bağlı */ }
      subs.forEach(f => { try { f(); } catch (e) { /* abunəçi xətası */ } });
    }
    load();
    const S = {
      get state() { return st; },
      on(fn) { subs.push(fn); },
      reload() { load(); subs.forEach(f => { try { f(); } catch (e) { /* */ } }); },
      get profile() { return st.profile; },
      get settings() { return st.settings; },
      setName(n) { st.profile.name = n; save(); },
      setSetting(k, v) { st.settings[k] = v; save(); },
      setLLM(patch) { Object.assign(st.settings.llm, patch); save(); },
      items(kind) { return st.items.filter(i => !kind || i.kind === kind); },
      get(id) { return st.items.find(i => i.id === id) || null; },
      add(kind, f) {
        const it = Object.assign({ id: st.seq++, kind, text: '', due: null, done: false, firedAt: null, repeat: null, timer: false, created: Date.now() }, f);
        st.items.push(it); save(); return it;
      },
      update(id, patch) { const it = S.get(id); if (it) { Object.assign(it, patch); save(); } return it; },
      remove(id) { const n = st.items.length; st.items = st.items.filter(i => i.id !== id); if (st.items.length !== n) save(); },
      removeMany(ids) { const set = new Set(ids); st.items = st.items.filter(i => !set.has(i.id)); save(); },
      addMessage(role, text) {
        st.messages.push({ role, text, ts: Date.now() });
        if (st.messages.length > 300) st.messages.splice(0, st.messages.length - 300);
        save();
      },
      messages() { return st.messages; },
      logDone(text, ts) { st.log.push({ text: String(text).slice(0, 120), ts: ts || Date.now() }); if (st.log.length > 500) st.log.splice(0, st.log.length - 500); save(); },
      logToday(now) { const d = new Date(now || Date.now()); const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); return st.log.filter(x => x.ts >= a && x.ts < a + 864e5); },
      clearMessages() { st.messages = []; save(); },
      exportJSON() { return JSON.stringify({ app: 'cahangir-ai', exported: new Date().toISOString(), data: st }, null, 2); },
      importJSON(text) {
        const o = JSON.parse(text);
        const data = o && o.app === 'cahangir-ai' ? o.data : o;
        if (!data || typeof data !== 'object' || !Array.isArray(data.items)) throw new Error('Fayl Cahangir ehtiyat nüsxəsi deyil.');
        const n = normalize(data);
        n.settings.pin = st.settings.pin; /* PIN idxalla dəyişmir */
        st = n; save();
        return st.items.length;
      },
      resetAll() { st = DEFAULTS(); save(); }
    };
    /* başqa pəncərədə dəyişiklik */
    if (typeof window !== 'undefined' && storage) {
      window.addEventListener('storage', e => { if (e.key === KEY) S.reload(); });
    }
    return S;
  }
  const api = { create, KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CahangirStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
