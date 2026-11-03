import { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { DashboardView } from "./components/DashboardView";
import { AiChatView } from "./components/AiChatView";
import { ConnectView } from "./components/ConnectView";
import { FileTransferView } from "./components/FileTransferView";
import { ClipboardView } from "./components/ClipboardView";
import { DevicesView } from "./components/DevicesView";
import { MemoriesView } from "./components/MemoriesView";
import { ProjectsView } from "./components/ProjectsView";
import { RemindersView } from "./components/RemindersView";
import { SystemMonitorView } from "./components/SystemMonitorView";
import { SettingsView } from "./components/SettingsView";
import { Toast } from "./components/Toast";
import {
  ActiveView,
  AppConfig,
  DeviceItem,
  MemoryItem,
  ProjectItem,
  ReminderItem,
  SystemMetrics,
  ToastMessage,
  TransferItem,
} from "./types";
import { api } from "./services/api";
import { Language } from "./services/i18n";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("dashboard");
  const [lang, setLang] = useState<Language>("az");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const [config, setConfig] = useState<AppConfig>({
    server_url: "http://100.114.91.32:8766",
    admin_token: "",
    device_token: "",
    device_id: "win_cahangir",
    device_name: "Cahangir Windows Desktop",
    p2p_port: 8767,
    download_dir: "C:\\Users\\Public\\Downloads",
    clipboard_sync_enabled: true,
    auto_start: false,
    minimize_to_tray: true,
    theme: "dark",
    language: "az",
    last_sync_time: 0,
  });

  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);

  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [selectedPeerIp, setSelectedPeerIp] = useState<string>("");

  const addToast = (type: "info" | "success" | "warning" | "error", text: string) => {
    const id = `toast_${Date.now()}_${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  // Initial load
  useEffect(() => {
    loadInitialData();
  }, []);

  // Update HTML data-theme attribute
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const loadInitialData = async () => {
    try {
      const cfg = await api.getAppConfig();
      setConfig(cfg);
      if (cfg.language) setLang(cfg.language);
      if (cfg.theme) setTheme(cfg.theme);

      await Promise.all([
        refreshMemories(),
        refreshReminders(),
        refreshProjects(),
        refreshTransfers(),
        refreshMetrics(),
      ]);

      if (cfg.server_url && cfg.admin_token) {
        refreshDevices(cfg.server_url, cfg.admin_token);
      }
    } catch (e) {
      console.error("Failed initial load", e);
    }
  };

  const refreshMemories = async () => {
    try {
      const data = await api.getMemories(false);
      setMemories(data);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshReminders = async () => {
    try {
      const data = await api.getReminders(false);
      setReminders(data);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshProjects = async () => {
    try {
      const data = await api.getProjects(false);
      setProjects(data);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshTransfers = async () => {
    try {
      const data = await api.getTransferHistory();
      setTransfers(data);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshMetrics = async () => {
    try {
      const data = await api.getSystemMetrics();
      setMetrics(data);
    } catch (e) {
      console.error(e);
    }
  };

  const refreshDevices = async (sUrl?: string, aToken?: string) => {
    const url = sUrl || config.server_url;
    const tok = aToken || config.admin_token;
    if (!url || !tok) return;

    try {
      const data = await api.listDevicesApi(url, tok);
      setDevices(data);
    } catch (e) {
      console.warn("Could not fetch devices list", e);
    }
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);

    try {
      const res = await api.triggerDeltaSync();
      addToast(
        "success",
        `✓ Sinxronizasiya tamamlandı! Tətbiq edilən: ${res.applied_memories || 0} yaddaş, ${res.applied_reminders || 0} xatırlatma`
      );
      await Promise.all([refreshMemories(), refreshReminders(), refreshProjects()]);
      const cfg = await api.getAppConfig();
      setConfig(cfg);
    } catch (e: any) {
      addToast("warning", `Sinxronizasiya: ${e?.message || e}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSaveConfig = async (newCfg: AppConfig) => {
    try {
      await api.saveAppConfig(newCfg);
      setConfig(newCfg);
      setLang(newCfg.language);
      setTheme(newCfg.theme);
      addToast("success", "Tənzimləmələr saxlandı");
      if (newCfg.server_url && newCfg.admin_token) {
        refreshDevices(newCfg.server_url, newCfg.admin_token);
      }
    } catch (e: any) {
      addToast("error", `Xəta: ${e?.message || e}`);
    }
  };

  // Background reminder checker for Windows Notifications
  useEffect(() => {
    const checkAlarms = async () => {
      const now = Date.now();
      let hasPerm = await isPermissionGranted();
      if (!hasPerm) {
        const perm = await requestPermission();
        hasPerm = perm === "granted";
      }

      reminders.forEach((r) => {
        const target = r.snooze || r.due;
        if (target && r.done === 0 && r.deleted === 0) {
          // If due within the last 15 seconds
          if (now >= target && now - target < 20000) {
            if (hasPerm) {
              sendNotification({
                title: "🔔 Cahangir Xatırlatması",
                body: r.text,
              });
            }
            addToast("info", `🔔 Xatırlatma: ${r.text}`);
          }
        }
      });
    };

    const interval = setInterval(checkAlarms, 10000);
    return () => clearInterval(interval);
  }, [reminders]);

  // Global P2P Event Listeners
  useEffect(() => {
    const unlistenClip = listen<any>("p2p://clipboard-received", (event) => {
      addToast("info", `📋 Yeni pano mətni alındı: "${event.payload.origin_device}"`);
    });

    const unlistenComplete = listen<any>("p2p://transfer-complete", (event) => {
      addToast("success", `📥 Fayl qəbul edildi: ${event.payload.filename}`);
      refreshTransfers();
    });

    return () => {
      unlistenClip.then((f) => f());
      unlistenComplete.then((f) => f());
    };
  }, []);

  const activeRemindersCount = reminders.filter((r) => r.done === 0 && r.deleted === 0).length;

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        setActiveView={setActiveView}
        lang={lang}
        serverOnline={metrics?.backend_online || false}
        activeRemindersCount={activeRemindersCount}
      />

      <div className="main-wrapper">
        <Header
          activeView={activeView}
          lang={lang}
          setLang={setLang}
          theme={theme}
          setTheme={setTheme}
          onSync={handleSync}
          isSyncing={isSyncing}
          lastSyncTime={config.last_sync_time}
        />

        {activeView === "dashboard" && (
          <DashboardView
            lang={lang}
            setActiveView={setActiveView}
            activeRemindersCount={activeRemindersCount}
            memoriesCount={memories.filter((m) => m.deleted === 0).length}
            projectsCount={projects.filter((p) => p.deleted === 0).length}
            devicesCount={devices.filter((d) => d.is_revoked === 0).length}
            metrics={metrics}
            transfers={transfers}
          />
        )}

        {activeView === "ai" && (
          <AiChatView
            lang={lang}
            onActionTriggered={() => {
              refreshReminders();
              refreshMemories();
            }}
          />
        )}

        {activeView === "connect" && (
          <ConnectView
            lang={lang}
            devices={devices}
            onRefreshDevices={() => refreshDevices()}
            setActiveView={setActiveView}
            setSelectedPeerIp={setSelectedPeerIp}
          />
        )}

        {activeView === "file-transfer" && (
          <FileTransferView
            lang={lang}
            transfers={transfers}
            onRefreshTransfers={refreshTransfers}
            selectedPeerIp={selectedPeerIp}
            defaultDownloadDir={config.download_dir}
          />
        )}

        {activeView === "clipboard" && (
          <ClipboardView lang={lang} selectedPeerIp={selectedPeerIp} />
        )}

        {activeView === "devices" && (
          <DevicesView
            lang={lang}
            devices={devices}
            onRefreshDevices={() => refreshDevices()}
            serverUrl={config.server_url}
            adminToken={config.admin_token}
            setActiveView={setActiveView}
          />
        )}

        {activeView === "memories" && (
          <MemoriesView lang={lang} memories={memories} onRefresh={refreshMemories} />
        )}

        {activeView === "projects" && (
          <ProjectsView lang={lang} projects={projects} onRefresh={refreshProjects} />
        )}

        {activeView === "reminders" && (
          <RemindersView lang={lang} reminders={reminders} onRefresh={refreshReminders} />
        )}

        {activeView === "system-monitor" && <SystemMonitorView lang={lang} />}

        {activeView === "settings" && (
          <SettingsView
            lang={lang}
            setLang={setLang}
            theme={theme}
            setTheme={setTheme}
            config={config}
            onSaveConfig={handleSaveConfig}
          />
        )}
      </div>

      <Toast toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}
export default App;
