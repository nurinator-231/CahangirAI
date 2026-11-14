import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
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
import { PlannerView } from "./components/PlannerView";
import { Toast } from "./components/Toast";
import {
  ActiveView, AppConfig, DeviceItem, EventItem, MemoryItem, PlanBlock, ProjectItem, ReminderItem,
  SyncStatus, SystemMetrics, TaskItem, ToastMessage, TransferItem,
} from "./types";
import { api, errText } from "./services/api";
import { Language } from "./services/i18n";

const EMPTY_CONFIG: AppConfig = {
  server_url: "", admin_token: "", device_token: "", device_id: "", device_name: "", p2p_port: 8767, download_dir: "",
  clipboard_sync_enabled: true, clipboard_auto_share: false, auto_start: false, minimize_to_tray: true, theme: "dark", language: "az",
  last_sync_time: 0, last_server_rev: 0, auto_sync_minutes: 5, last_sync_status: "never", last_sync_error: "", mesh_key: "",
  mesh_key_id: 0, planner_day_start: "08:00", planner_day_end: "22:00",
};

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("planner");
  const [lang, setLang] = useState<Language>("az");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [config, setConfig] = useState<AppConfig>(EMPTY_CONFIG);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [reminders, setReminders] = useState<ReminderItem[]>([]);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [blocks, setBlocks] = useState<PlanBlock[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [selectedPeerIp, setSelectedPeerIp] = useState<string>("");
  const [alarms, setAlarms] = useState<{ id: string; text: string; missed: boolean }[]>([]);

  const addToast = useCallback((type: ToastMessage["type"], text: string) => {
    const id = `toast_${Date.now()}_${Math.random()}`;
    setToasts((prev) => [...prev, { id, type, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);
  const removeToast = (id: string) => setToasts((prev) => prev.filter((t) => t.id !== id));

  const refreshPlanner = useCallback(async () => {
    const [t, e, b, r] = await Promise.all([api.getTasks(), api.getEvents(), api.getBlocks(), api.getReminders(false)]);
    setTasks(t); setEvents(e); setBlocks(b); setReminders(r);
  }, []);
  const refreshMemories = useCallback(async () => setMemories(await api.getMemories(false)), []);
  const refreshReminders = useCallback(async () => setReminders(await api.getReminders(false)), []);
  const refreshProjects = useCallback(async () => setProjects(await api.getProjects(false)), []);
  const refreshTransfers = useCallback(async () => setTransfers(await api.getTransferHistory()), []);
  const refreshSyncStatus = useCallback(async () => setSyncStatus(await api.getSyncStatus()), []);
  const refreshDevices = useCallback(async () => {
    try { setDevices(await api.listPairedDevices()); } catch { /* offline: keep last list */ }
  }, []);
  const refreshConfig = useCallback(async () => {
    const cfg = await api.getAppConfig();
    setConfig(cfg); setLang(cfg.language); setTheme(cfg.theme);
    return cfg;
  }, []);
  const refreshAll = useCallback(async () => {
    try {
      await Promise.all([refreshPlanner(), refreshMemories(), refreshProjects(), refreshTransfers(), refreshSyncStatus()]);
    } catch (e) { console.error(e); }
  }, [refreshPlanner, refreshMemories, refreshProjects, refreshTransfers, refreshSyncStatus]);

  useEffect(() => {
    (async () => {
      try {
        await refreshConfig();
        await refreshAll();
        refreshDevices();
        api.getSystemMetrics().then(setMetrics).catch(() => {});
      } catch (e) { addToast("error", errText(e)); }
    })();
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  // Events from the native side (sync loop, reminder engine, P2P server).
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  useEffect(() => {
    const subs = [
      listen<any>("sync://status", (ev) => {
        setIsSyncing(ev.payload.status === "syncing");
        if (ev.payload.status !== "syncing") {
          refreshSyncStatus();
          refreshConfig();
          if (ev.payload.conflicts) addToast("warning", lang === "en" ? `${ev.payload.conflicts} edit conflict(s) resolved — the newer version was kept.` : `${ev.payload.conflicts} ziddiyyət həll olundu — daha yeni versiya saxlanıldı.`);
        }
      }),
      listen<any>("data://changed", () => refreshAllRef.current()),
      listen<any>("reminder://fired", (ev) => {
        setAlarms((a) => (a.some((x) => x.id === ev.payload.id) ? a : [...a, { id: ev.payload.id, text: ev.payload.text, missed: ev.payload.missed }]));
      }),
      listen<any>("clipboard://received", () => addToast("info", lang === "en" ? "📋 Clipboard received from another device" : "📋 Digər cihazdan pano mətni gəldi")),
      listen<any>("p2p://clipboard-received", (ev) => addToast("info", `📋 ${ev.payload.origin_device}`)),
      listen<any>("p2p://transfer-complete", (ev) => {
        if (ev.payload.direction === "receive") addToast("success", `📥 ${ev.payload.filename} (SHA-256 ✓)`);
        refreshTransfers();
      }),
      listen<any>("p2p://transfer-failed", (ev) => { addToast("error", `${ev.payload.filename || ""} ${ev.payload.error || ""}`); refreshTransfers(); }),
      listen<any>("p2p://server-error", (ev) => addToast("error", `P2P port ${ev.payload.port}: ${ev.payload.error}`)),
    ];
    return () => { subs.forEach((p) => p.then((f) => f())); };
  }, [lang]);

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      const r = await api.triggerDeltaSync();
      addToast("success", lang === "en" ? `Synced: sent ${r.pushed}, received ${r.applied_remote}` : `Sinxron edildi: göndərildi ${r.pushed}, alındı ${r.applied_remote}`);
      await refreshAll();
      refreshDevices();
    } catch (e) {
      addToast("warning", errText(e));
    } finally {
      setIsSyncing(false);
      refreshSyncStatus();
    }
  };

  const handleSaveConfig = async (newCfg: AppConfig) => {
    try {
      const saved = await api.saveAppConfig(newCfg);
      setConfig(saved); setLang(saved.language); setTheme(saved.theme);
      addToast("success", lang === "en" ? "Settings saved" : "Tənzimləmələr saxlandı");
    } catch (e) {
      addToast("error", errText(e));
      refreshConfig();
    }
  };

  const ackAlarm = async (id: string) => { await api.completeReminder(id); setAlarms((a) => a.filter((x) => x.id !== id)); refreshReminders(); };
  const snoozeAlarm = async (id: string) => { await api.snoozeReminder(id, 10); setAlarms((a) => a.filter((x) => x.id !== id)); refreshReminders(); };

  const activeRemindersCount = reminders.filter((r) => r.done === 0 && r.deleted === 0).length;

  return (
    <div className="app-shell">
      <Sidebar activeView={activeView} setActiveView={setActiveView} lang={lang} serverOnline={syncStatus?.status === "ok"} activeRemindersCount={activeRemindersCount} />
      <div className="main-wrapper">
        <Header activeView={activeView} lang={lang} setLang={setLang} theme={theme} setTheme={setTheme} onSync={handleSync} isSyncing={isSyncing}
          lastSyncTime={config.last_sync_time} syncStatus={syncStatus ? { ...syncStatus, status: isSyncing ? "syncing" : syncStatus.status } : undefined} />

        {alarms.length > 0 && (
          <div className="card" style={{ margin: "12px 24px 0", borderColor: "var(--warning)" }}>
            {alarms.map((a) => (
              <div className="row" key={a.id} style={{ justifyContent: "space-between", padding: "4px 0" }}>
                <b>🔔 {a.missed ? (lang === "en" ? "Missed: " : "Qaçırılıb: ") : ""}{a.text}</b>
                <div className="row">
                  <button className="btn-primary btn-small" onClick={() => ackAlarm(a.id)}>{lang === "en" ? "Done" : "Oldu"}</button>
                  <button className="btn-secondary btn-small" onClick={() => snoozeAlarm(a.id)}>{lang === "en" ? "10 min" : "10 dəq"}</button>
                  <button className="btn-secondary btn-small" onClick={() => setAlarms((x) => x.filter((y) => y.id !== a.id))}>✕</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeView === "dashboard" && (
          <DashboardView lang={lang} setActiveView={setActiveView} activeRemindersCount={activeRemindersCount}
            memoriesCount={memories.length} projectsCount={projects.length}
            devicesCount={devices.filter((d) => d.is_revoked === 0).length} metrics={metrics} transfers={transfers} />
        )}
        {activeView === "planner" && (
          <PlannerView lang={lang} config={config} tasks={tasks} events={events} blocks={blocks} reminders={reminders} onChanged={refreshPlanner} toast={addToast} />
        )}
        {activeView === "ai" && <AiChatView lang={lang} onActionTriggered={refreshAll} />}
        {activeView === "connect" && (
          <ConnectView lang={lang} devices={devices} onRefreshDevices={refreshDevices} setActiveView={setActiveView} setSelectedPeerIp={setSelectedPeerIp} />
        )}
        {activeView === "file-transfer" && (
          <FileTransferView lang={lang} transfers={transfers} devices={devices} myDeviceId={config.device_id} onRefreshTransfers={refreshTransfers}
            onRefreshDevices={refreshDevices} selectedPeerIp={selectedPeerIp} p2pReady={!!syncStatus?.p2p_ready} toast={addToast} />
        )}
        {activeView === "clipboard" && <ClipboardView lang={lang} config={config} onSaveConfig={handleSaveConfig} toast={addToast} />}
        {activeView === "devices" && <DevicesView lang={lang} devices={devices} myDeviceId={config.device_id} onRefreshDevices={refreshDevices} toast={addToast} />}
        {activeView === "memories" && <MemoriesView lang={lang} memories={memories} onRefresh={refreshMemories} />}
        {activeView === "projects" && <ProjectsView lang={lang} projects={projects} onRefresh={refreshProjects} />}
        {activeView === "reminders" && <RemindersView lang={lang} reminders={reminders} onRefresh={refreshReminders} />}
        {activeView === "system-monitor" && <SystemMonitorView lang={lang} />}
        {activeView === "settings" && (
          <SettingsView lang={lang} setLang={setLang} theme={theme} setTheme={setTheme} config={config} onSaveConfig={handleSaveConfig}
            onPaired={async () => { await refreshConfig(); refreshSyncStatus(); refreshDevices(); }} toast={addToast} />
        )}
      </div>
      <Toast toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}
export default App;
