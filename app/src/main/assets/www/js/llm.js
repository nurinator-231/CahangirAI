/* llm.js — isteğe bağlı dil modeli bağlantıları.
   1) "endpoint": OpenAI-uyğun server (llama.cpp, Ollama, LM Studio…) — token TƏLƏB OLUNMUR (açar sahəsi boş qala bilər)
   2) "device": cihazda Gemma — MediaPipe LLM Inference (WebGPU), model faylı bir dəfə seçilir və cihazda saxlanır.
   Heç biri qoşulmayıbsa tətbiq yenə də tam işləyir (qaydalar mühərriki). */
(function (root) {
  'use strict';
  const MODEL_FILE = 'gemma-model.bin';
  const META_KEY = 'cahangir.model';
  const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-genai';
  let inst = null, loading = null;

  function systemPrompt(ctx) {
    const facts = (ctx.facts || []).slice(-12).join('; ') || 'məlumat yoxdur';
    return 'Sən Cahangirsən — ' + (ctx.name ? ctx.name + 'in' : 'istifadəçinin') + ' şəxsi səsli köməkçisi. ' +
      'Həmişə Azərbaycan dilində, qısa (1–3 cümlə), aydın və səmimi cavab ver. Bilmirsənsə “bilmirəm” de, uydurma. ' +
      'Xatırlatma qurmaq, yaddaş və hesablamanı sən etmə — bunları proqram özü edir. ' +
      'İndi: ' + ctx.nowText + '. İstifadəçi haqqında: ' + facts + '.';
  }

  /* ---------- endpoint (OpenAI-uyğun) ---------- */
  async function askEndpoint(text, ctx, cfg) {
    if (!cfg.url) throw new Error('Server ünvanı yazılmayıb');
    let u; try { u = new URL(cfg.url); } catch (e) { throw new Error('Ünvan düzgün deyil'); }
    const local = /^(localhost|127\.|\[::1\])/.test(u.hostname);
    if (typeof location !== 'undefined' && location.protocol === 'https:' && u.protocol === 'http:' && !local)
      throw new Error('HTTPS səhifədən http:// ünvana sorğu brauzer tərəfindən bloklanır — HTTPS ünvan və ya localhost istifadə et');
    const msgs = [{ role: 'system', content: systemPrompt(ctx) }];
    (ctx.history || []).slice(-6).forEach(m => msgs.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
    msgs.push({ role: 'user', content: text });
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 90000);
    let r;
    try {
      r = await fetch(cfg.url, { method: 'POST', headers, signal: ac.signal,
        body: JSON.stringify({ model: cfg.model || 'local', messages: msgs, max_tokens: cfg.maxTokens || 300, stream: false }) });
    } catch (e) { throw new Error(e.name === 'AbortError' ? 'cavab vaxtı bitdi' : 'serverə qoşulmaq olmur'); }
    finally { clearTimeout(to); }
    if (!r.ok) throw new Error('server HTTP ' + r.status);
    const j = await r.json();
    const out = (j.choices && j.choices[0] && ((j.choices[0].message && j.choices[0].message.content) || j.choices[0].text)) ||
      (j.message && j.message.content) || j.response || '';
    return String(out).trim();
  }

  /* ---------- cihazda Gemma (MediaPipe, WebGPU) ---------- */
  async function dir() { return navigator.storage.getDirectory(); }
  async function hasModel() {
    try { if (!navigator.storage || !navigator.storage.getDirectory) return false; const d = await dir(); await d.getFileHandle(MODEL_FILE); return true; }
    catch (e) { return false; }
  }
  function meta() { try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch (e) { return null; } }
  async function storeModel(file, onProgress) {
    if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('Bu brauzer cihazda böyük fayl saxlamağı dəstəkləmir');
    try { navigator.storage.persist && navigator.storage.persist(); } catch (e) { /* */ }
    const d = await dir(); const fh = await d.getFileHandle(MODEL_FILE, { create: true });
    const w = await fh.createWritable(); const rd = file.stream().getReader(); let n = 0;
    try {
      for (;;) { const { value, done } = await rd.read(); if (done) break; await w.write(value); n += value.length; onProgress && onProgress(n / file.size); }
      await w.close();
    } catch (e) { try { await w.abort(); } catch (e2) { /* */ } throw e; }
    inst = null;
    try { localStorage.setItem(META_KEY, JSON.stringify({ name: file.name, size: file.size })); } catch (e) { /* */ }
  }
  async function removeModel() {
    inst = null;
    try { const d = await dir(); await d.removeEntry(MODEL_FILE); } catch (e) { /* yoxdur */ }
    try { localStorage.removeItem(META_KEY); } catch (e) { /* */ }
  }
  async function importGenai() {
    let base = CDN;
    try { const h = await fetch('./vendor/genai_bundle.mjs', { method: 'HEAD' }); if (h.ok) base = './vendor'; } catch (e) { /* CDN */ }
    const url = base === CDN ? CDN + '/genai_bundle.mjs' : './vendor/genai_bundle.mjs';
    const wasm = base === CDN ? CDN + '/wasm' : './vendor/wasm';
    return { mod: await import(/* webpackIgnore: true */ new URL(url, location.href).href), wasm: new URL(wasm, location.href).href };
  }
  async function deviceLoad(onStatus) {
    if (inst) return inst;
    if (loading) return loading;
    loading = (async () => {
      if (!('gpu' in navigator)) throw new Error('bu cihazda/brauzerdə WebGPU yoxdur (Chrome 121+ və güclü telefon lazımdır)');
      if (!(await hasModel())) throw new Error('model faylı seçilməyib');
      onStatus && onStatus('Kitabxana yüklənir…');
      const { mod, wasm } = await importGenai();
      const fileset = await mod.FilesetResolver.forGenAiTasks(wasm);
      const d = await dir(); const file = await (await d.getFileHandle(MODEL_FILE)).getFile();
      onStatus && onStatus('Model yaddaşa yüklənir… (bir neçə dəqiqə çəkə bilər)');
      inst = await mod.LlmInference.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: file.stream().getReader() },
        maxTokens: 1024, topK: 40, temperature: 0.7, randomSeed: 1
      });
      onStatus && onStatus('Hazırdır');
      return inst;
    })();
    try { return await loading; } finally { loading = null; }
  }
  async function askDevice(text, ctx, cfg, onStatus) {
    const llm = await deviceLoad(onStatus);
    let p = '<start_of_turn>user\n' + systemPrompt(ctx) + '\n\n';
    (ctx.history || []).slice(-4).forEach(m => { p += (m.role === 'user' ? 'İstifadəçi: ' : 'Cahangir: ') + m.text + '\n'; });
    p += text + '<end_of_turn>\n<start_of_turn>model\n';
    const out = await llm.generateResponse(p);
    return String(out).replace(/<end_of_turn>[\s\S]*$/, '').trim();
  }

  async function ask(text, ctx, cfg, onStatus) {
    if (!cfg || cfg.mode === 'off') return null;
    if (cfg.mode === 'endpoint') return askEndpoint(text, ctx, cfg);
    if (cfg.mode === 'device') return askDevice(text, ctx, cfg, onStatus);
    return null;
  }

  const api = { ask, hasModel, meta, storeModel, removeModel, deviceLoad, systemPrompt, loaded: () => !!inst };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CahangirLLM = api;
})(typeof window !== 'undefined' ? window : globalThis);
