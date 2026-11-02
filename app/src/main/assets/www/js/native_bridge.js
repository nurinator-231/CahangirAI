/* native_bridge.js — Cahangir Android Native Bridge.
   Provides native TTS, Speech Recognition, Exact Alarm Sync, Room/SQLite Local DB,
   SAF File Access, Calendar Export, and Debian Central Synchronization. */
(function (root) {
  'use strict';

  console.log('[Cahangir] Initializing enhanced native bridge...');

  // 1. Native TTS bridge
  root.CahangirTTS = {
    speak: function (text, onStart, onEnd) {
      root._onTtsStart = onStart;
      root._onTtsEnd = onEnd;
      if (root.CahangirBridge && root.CahangirBridge.speak) {
        try {
          root.CahangirBridge.speak(text);
          return true;
        } catch (e) {
          console.error('[Cahangir] Native TTS speak error:', e);
          if (onEnd) onEnd();
          return false;
        }
      }
      return false;
    },
    stop: function () {
      if (root.CahangirBridge && root.CahangirBridge.stopSpeak) {
        try { root.CahangirBridge.stopSpeak(); } catch (e) {}
      }
    }
  };

  // 2. Native Speech Recognition bridge (STT)
  root.CahangirNative = {
    listen: function () {
      if (root.CahangirBridge && root.CahangirBridge.listen) {
        try {
          root.CahangirBridge.listen();
        } catch (e) {
          console.error('[Cahangir] Native listen error:', e);
        }
      }
    },
    stopListen: function () {
      if (root.CahangirBridge && root.CahangirBridge.stopListen) {
        try {
          root.CahangirBridge.stopListen();
        } catch (e) {
          console.error('[Cahangir] Native stopListen error:', e);
        }
      }
    }
  };

  // 3. Callback handlers from Android
  root._ttsStarted = function () {
    if (typeof root._onTtsStart === 'function') {
      try { root._onTtsStart(); } catch (e) {}
    }
  };

  root._ttsEnded = function () {
    if (typeof root._onTtsEnd === 'function') {
      try { root._onTtsEnd(); } catch (e) {}
    }
  };

  root._nativeHeard = function (text) {
    if (typeof root.onHeard === 'function') {
      try { root.onHeard(text); } catch (e) {}
    }
  };

  // 4. Store synchronization with Android Local DB and AlarmManager
  function syncStoreToAndroid() {
    if (!root.CahangirBridge || !root.CahangirBridge.syncFullStore) return;
    try {
      if (root.__cg && root.__cg.store) {
        const store = root.__cg.store;
        const payload = JSON.stringify(store.state);
        root.CahangirBridge.syncFullStore(payload);
      }
    } catch (err) {
      console.error('[Cahangir] Error syncing full store to Android:', err);
    }
  }

  // 5. Debian Server Sync integration API
  root.cahangirConfigureServer = function (url, token) {
    if (root.CahangirBridge && root.CahangirBridge.configureServer) {
      try {
        const res = root.CahangirBridge.configureServer(url, token);
        return JSON.parse(res);
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Bridge not ready' };
  };

  root.cahangirGetServerStatus = function () {
    if (root.CahangirBridge && root.CahangirBridge.getServerStatus) {
      try {
        return JSON.parse(root.CahangirBridge.getServerStatus());
      } catch (e) {
        return { isConfigured: false };
      }
    }
    return { isConfigured: false };
  };

  root.cahangirTriggerSync = function () {
    if (root.CahangirBridge && root.CahangirBridge.triggerSyncNow) {
      root.CahangirBridge.triggerSyncNow();
    }
  };

  // 6. SAF Backup Export & Import
  root.cahangirExportBackup = function () {
    if (root.CahangirBridge && root.CahangirBridge.exportBackupSaf && root.__cg && root.__cg.store) {
      const jsonStr = root.__cg.store.exportJSON();
      root.CahangirBridge.exportBackupSaf(jsonStr);
    }
  };

  root.cahangirImportBackup = function (jsonStr) {
    if (root.__cg && root.__cg.store) {
      try {
        const count = root.__cg.store.importJSON(jsonStr);
        if (root.__cg.env && root.__cg.env.changed) root.__cg.env.changed();
        console.log('[Cahangir] Restored ' + count + ' items from backup.');
      } catch (e) {
        console.error('[Cahangir] Backup import failed:', e);
      }
    }
  };

  // 7. Calendar Export
  root.cahangirAddToCalendar = function (title, timeMillis) {
    if (root.CahangirBridge && root.CahangirBridge.exportToCalendar) {
      root.CahangirBridge.exportToCalendar(title, timeMillis);
    }
  };

  // 8. Notification from background sync
  root.onServerSyncComplete = function () {
    console.log('[Cahangir] Server sync complete event received.');
    if (root.__cg && root.__cg.env && root.__cg.env.changed) {
      try { root.__cg.env.changed(); } catch (e) {}
    }
  };

  // Setup listeners once DOM and store are ready
  window.addEventListener('DOMContentLoaded', function () {
    const checkInterval = setInterval(function () {
      if (root.__cg && root.__cg.store) {
        clearInterval(checkInterval);
        const store = root.__cg.store;

        // Sync keepAwake setting on start
        if (store.settings && typeof store.settings.keepAwake === 'boolean' && root.CahangirBridge) {
          try {
            root.CahangirBridge.setKeepScreenOn(store.settings.keepAwake);
          } catch (e) {}
        }

        // Register store listener for any changes (add, update, delete)
        if (store.on) {
          store.on(syncStoreToAndroid);
        }
        syncStoreToAndroid();

        // Ensure input field is visible when focused (keyboard open)
        const txInput = document.getElementById('tx');
        if (txInput) {
          txInput.addEventListener('focus', function() {
            setTimeout(function() {
              txInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              const chat = document.getElementById('chat');
              if (chat) chat.scrollTop = chat.scrollHeight;
            }, 300);
          });
        }

        // Hook Backup Buttons to SAF
        const dExportBtn = document.getElementById('dExport');
        if (dExportBtn && root.CahangirBridge) {
          dExportBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            root.cahangirExportBackup();
          });
        }

        // Debian Sync Settings UI bindings
        const syncUrlInp = document.getElementById('sSyncUrl');
        const syncTokenInp = document.getElementById('sSyncToken');
        const syncSaveBtn = document.getElementById('sSyncSave');
        const syncNowBtn = document.getElementById('sSyncNow');
        const syncStatusTxt = document.getElementById('sSyncStatus');

        function updateSyncStatusUI() {
          const st = root.cahangirGetServerStatus();
          if (st && st.isConfigured) {
            if (syncUrlInp && !syncUrlInp.value) syncUrlInp.value = st.serverUrl;
            if (syncStatusTxt) {
              const dt = st.lastSync > 0 ? new Date(st.lastSync).toLocaleTimeString() : 'heç vaxt';
              syncStatusTxt.textContent = '✓ Qoşulub: ' + st.serverUrl + ' (Son sinx: ' + dt + ')';
              syncStatusTxt.style.color = '#2fe0a0';
            }
          } else {
            if (syncStatusTxt) {
              syncStatusTxt.textContent = 'Status: Oflayn / Lokal rejim (Server ayarlanmayıb)';
              syncStatusTxt.style.color = '#8899bb';
            }
          }
        }

        updateSyncStatusUI();

        if (syncSaveBtn) {
          syncSaveBtn.addEventListener('click', function () {
            const url = (syncUrlInp && syncUrlInp.value) || '';
            const tok = (syncTokenInp && syncTokenInp.value) || '';
            if (!url || !tok) {
              alert('Zəhmət olmasa Server URL və Admin Token daxil edin.');
              return;
            }
            if (syncStatusTxt) syncStatusTxt.textContent = 'Qoşulur...';
            const res = root.cahangirConfigureServer(url, tok);
            if (res.success) {
              if (syncTokenInp) syncTokenInp.value = '';
              updateSyncStatusUI();
              alert(res.message);
            } else {
              if (syncStatusTxt) {
                syncStatusTxt.textContent = 'Xəta: ' + (res.error || 'Qoşulma uğursuz oldu');
                syncStatusTxt.style.color = '#ff6b6b';
              }
              alert('Serverə qoşulmaq mümkün olmadı: ' + (res.error || 'Naməlum xəta'));
            }
          });
        }

        if (syncNowBtn) {
          syncNowBtn.addEventListener('click', function () {
            root.cahangirTriggerSync();
            setTimeout(updateSyncStatusUI, 1200);
          });
        }
      }
    }, 250);
  });

  // Watch for UI setting changes
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'sAwake' && root.CahangirBridge) {
      try {
        root.CahangirBridge.setKeepScreenOn(e.target.checked);
      } catch (err) {}
    }
  });

})(typeof window !== 'undefined' ? window : this);
