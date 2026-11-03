/* native_bridge.js — Cahangir Android Native Bridge.
   Provides native TTS, Speech Recognition, Exact Alarm Sync, Room/SQLite Local DB,
   SAF File Access, Calendar Export, P2P File Transfer, Universal Clipboard,
   Paired Devices Management, System Metrics and Debian Central Synchronization. */
(function (root) {
  'use strict';

  console.log('[Cahangir] Initializing enhanced native bridge with P2P support...');

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

  // 8. P2P Server & File Transfer API
  root.cahangirGetP2pStatus = function () {
    if (root.CahangirBridge && root.CahangirBridge.getP2pServerStatus) {
      try {
        return JSON.parse(root.CahangirBridge.getP2pServerStatus());
      } catch (e) {
        return { isRunning: false, port: 8767, ips: [] };
      }
    }
    return { isRunning: false, port: 8767, ips: [] };
  };

  root.cahangirPickAndSendFile = function (peerIp, peerPort) {
    if (root.CahangirBridge && root.CahangirBridge.pickAndSendFile) {
      root.CahangirBridge.pickAndSendFile(peerIp, peerPort || 8767);
    }
  };

  root.cahangirCancelTransfer = function () {
    if (root.CahangirBridge && root.CahangirBridge.cancelFileTransfer) {
      root.CahangirBridge.cancelFileTransfer();
    }
  };

  root.cahangirGetTransferHistory = function () {
    if (root.CahangirBridge && root.CahangirBridge.getTransferHistory) {
      try {
        return JSON.parse(root.CahangirBridge.getTransferHistory());
      } catch (e) {
        return [];
      }
    }
    return [];
  };

  root.cahangirClearTransferHistory = function () {
    if (root.CahangirBridge && root.CahangirBridge.clearTransferHistory) {
      root.CahangirBridge.clearTransferHistory();
    }
  };

  // 9. P2P Clipboard API
  root.cahangirSendClipboard = function (peerIp, peerPort, text) {
    if (root.CahangirBridge && root.CahangirBridge.sendClipboardToPeer) {
      try {
        return JSON.parse(root.CahangirBridge.sendClipboardToPeer(peerIp, peerPort || 8767, text));
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Bridge not ready' };
  };

  root.cahangirGetClipboard = function () {
    if (root.CahangirBridge && root.CahangirBridge.getSystemClipboard) {
      return root.CahangirBridge.getSystemClipboard();
    }
    return '';
  };

  root.cahangirCopyClipboard = function (text) {
    if (root.CahangirBridge && root.CahangirBridge.copyToClipboard) {
      root.CahangirBridge.copyToClipboard(text);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  // 10. Devices & Paired List API
  root.cahangirListDevices = function (serverUrl, adminToken) {
    if (root.CahangirBridge && root.CahangirBridge.listPairedDevices) {
      try {
        return JSON.parse(root.CahangirBridge.listPairedDevices(serverUrl || '', adminToken || ''));
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Bridge not ready' };
  };

  root.cahangirRevokeDevice = function (serverUrl, adminToken, deviceId) {
    if (root.CahangirBridge && root.CahangirBridge.revokePairedDevice) {
      try {
        return JSON.parse(root.CahangirBridge.revokePairedDevice(serverUrl || '', adminToken || '', deviceId));
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'Bridge not ready' };
  };

  // 11. System Metrics API
  root.cahangirGetSystemMetrics = function () {
    if (root.CahangirBridge && root.CahangirBridge.getSystemMetrics) {
      try {
        return JSON.parse(root.CahangirBridge.getSystemMetrics());
      } catch (e) {
        return null;
      }
    }
    return null;
  };

  // 12. P2P Event handlers called from Android
  root._p2pTransferStarted = function (id, name, size, sender) {
    console.log('[P2P] Transfer started:', id, name, size, sender);
    if (typeof root.onP2pTransferStarted === 'function') {
      root.onP2pTransferStarted(id, name, size, sender);
    }
  };

  root._p2pTransferProgress = function (id, sent, total, percent, speed) {
    if (typeof root.onP2pTransferProgress === 'function') {
      root.onP2pTransferProgress(id, sent, total, percent, speed);
    }
  };

  root._p2pTransferComplete = function (id, name, size, speed, sha, path) {
    console.log('[P2P] Transfer complete:', name, speed, sha);
    if (typeof root.onP2pTransferComplete === 'function') {
      root.onP2pTransferComplete(id, name, size, speed, sha, path);
    }
  };

  root._p2pTransferFailed = function (err) {
    console.error('[P2P] Transfer failed:', err);
    if (typeof root.onP2pTransferFailed === 'function') {
      root.onP2pTransferFailed(err);
    }
  };

  root._p2pClipboardReceived = function (text, origin, hash) {
    console.log('[P2P] Clipboard received from', origin);
    if (typeof root.onP2pClipboardReceived === 'function') {
      root.onP2pClipboardReceived(text, origin, hash);
    }
  };

  // 13. Notification from background sync
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

        if (store.settings && typeof store.settings.keepAwake === 'boolean' && root.CahangirBridge) {
          try {
            root.CahangirBridge.setKeepScreenOn(store.settings.keepAwake);
          } catch (e) {}
        }

        if (store.on) {
          store.on(syncStoreToAndroid);
        }
        syncStoreToAndroid();

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
            if (syncTokenInp && !syncTokenInp.value && st.adminToken) syncTokenInp.value = st.adminToken;
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

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'sAwake' && root.CahangirBridge) {
      try {
        root.CahangirBridge.setKeepScreenOn(e.target.checked);
      } catch (err) {}
    }
  });

})(typeof window !== 'undefined' ? window : this);
