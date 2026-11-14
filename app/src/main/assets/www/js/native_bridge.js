/* native_bridge.js — thin JS layer over the Android CahangirBridge.
 * Data is NOT mirrored from JS anymore: store.js reads/writes native SQLite directly.
 * Long-running native calls (network) return Promises via window.nativeAsync. */
(function (root) {
  'use strict';
  const B = () => root.CahangirBridge;

  // ---- async calls (resolved by native via window._nativeResolve) ----
  const pending = new Map();
  let seq = 0;
  root._nativeResolve = function (id, res) {
    const p = pending.get(id); if (!p) return;
    pending.delete(id);
    if (res && res.ok) p.resolve(res.value); else p.reject(new Error((res && res.error) || 'native error'));
  };
  root.nativeAsync = function (method) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise((resolve, reject) => {
      const b = B();
      if (!b || typeof b[method] !== 'function') { reject(new Error('Native bridge not available')); return; }
      const id = 'r' + (++seq) + '_' + Date.now();
      pending.set(id, { resolve, reject });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 120000);
      try { b[method].apply(b, [id].concat(args)); } catch (e) { pending.delete(id); reject(e); }
    });
  };
  root.nativeCall = function (method) {
    const b = B(); if (!b || typeof b[method] !== 'function') return null;
    try { return b[method].apply(b, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.error('[bridge]', method, e); return null; }
  };
  root.nativeJson = function (method) {
    const r = root.nativeCall.apply(null, arguments);
    if (r == null) return null;
    try { return JSON.parse(r); } catch (e) { return null; }
  };

  // ---- voice ----
  root.CahangirTTS = {
    speak: function (text, onStart, onEnd) {
      root._onTtsStart = onStart; root._onTtsEnd = onEnd;
      const b = B(); if (!b || !b.speak) return false;
      try { b.speak(text); return true; } catch (e) { if (onEnd) onEnd(); return false; }
    },
    stop: function () { root.nativeCall('stopSpeak'); }
  };
  root.CahangirNative = {
    listen: function () { root.nativeCall('listen'); },
    stopListen: function () { root.nativeCall('stopListen'); }
  };
  root._ttsStarted = function () { if (typeof root._onTtsStart === 'function') try { root._onTtsStart(); } catch (e) { /* */ } };
  root._ttsEnded = function () { if (typeof root._onTtsEnd === 'function') try { root._onTtsEnd(); } catch (e) { /* */ } };
  root._nativeHeard = function (text) { if (typeof root.onHeard === 'function') try { root.onHeard(text); } catch (e) { /* */ } };
  root._nativeListenError = function () {
    if (typeof root.setMode === 'function') root.setMode('idle');
    if (typeof root.toast === 'function') root.toast('Səs tanınmadı');
  };

  // ---- helpers used by the dashboard / system monitor ----
  root.cahangirGetServerStatus = () => root.nativeJson('getServerStatus') || { isConfigured: false };
  root.cahangirGetSystemMetrics = () => root.nativeJson('getSystemMetrics');
  root.cahangirGetTransferHistory = () => root.nativeJson('getTransferHistory') || [];
  root.cahangirAddToCalendar = (title, ms) => root.nativeCall('exportToCalendar', title, ms);
  root.cahangirCopyClipboard = function (text) {
    if (B() && B().copyToClipboard) B().copyToClipboard(text);
    else if (navigator.clipboard) navigator.clipboard.writeText(text);
  };

  // ---- backup via Storage Access Framework ----
  root.cahangirExportBackup = function () {
    if (B() && B().exportBackupSaf && root.__cg && root.__cg.store) B().exportBackupSaf(root.__cg.store.exportJSON());
  };
  root.cahangirImportBackup = function (jsonStr) {
    if (!root.__cg || !root.__cg.store) return;
    try {
      const n = root.__cg.store.importJSON(jsonStr);
      if (root.__cg.env && root.__cg.env.changed) root.__cg.env.changed();
      if (typeof root.toast === 'function') root.toast('Bərpa edildi: ' + n + ' qeyd');
    } catch (e) {
      if (typeof root.toast === 'function') root.toast('Bərpa alınmadı: ' + e.message);
    }
  };

  // ---- native -> JS events ----
  root.onNativeDataChanged = function () {
    if (root.__cg && root.__cg.store && root.__cg.store.refresh) root.__cg.store.refresh();
    if (root.CgUI && root.CgUI.onDataChanged) root.CgUI.onDataChanged();
  };
  ['_p2pTransferStarted', '_p2pTransferProgress', '_p2pTransferComplete', '_p2pTransferFailed', '_p2pClipboardReceived'].forEach(function (name) {
    root[name] = function () {
      const h = root.CgUI && root.CgUI[name.slice(1)];
      if (typeof h === 'function') h.apply(null, arguments);
    };
  });

  window.addEventListener('DOMContentLoaded', function () {
    const t = setInterval(function () {
      if (!root.__cg || !root.__cg.store) return;
      clearInterval(t);
      const s = root.__cg.store.settings;
      if (s && typeof s.keepAwake === 'boolean') root.nativeCall('setKeepScreenOn', s.keepAwake);
      if (root.__cg.store.profile && root.__cg.store.profile.name) root.nativeCall('setUserName', root.__cg.store.profile.name);
      const dExport = document.getElementById('dExport');
      if (dExport && B()) dExport.addEventListener('click', function (e) { e.preventDefault(); e.stopImmediatePropagation(); root.cahangirExportBackup(); }, true);
    }, 200);
  });
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'sAwake') root.nativeCall('setKeepScreenOn', e.target.checked);
  });
})(typeof window !== 'undefined' ? window : this);
