import React, { useEffect, useState } from "react";
import { Bell, Folder, Globe, Link2, Palette, RotateCcw, Save, ShieldCheck, Unlink } from "lucide-react";
import { AppConfig } from "../types";
import { api, errText } from "../services/api";
import { translations, Language } from "../services/i18n";

interface SettingsProps {
  lang: Language;
  setLang: (lang: Language) => void;
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  config: AppConfig;
  onSaveConfig: (cfg: AppConfig) => Promise<void> | void;
  onPaired: () => void;
  toast: (type: "info" | "success" | "warning" | "error", text: string) => void;
}

export const SettingsView: React.FC<SettingsProps> = ({ lang, setLang, theme, setTheme, config, onSaveConfig, onPaired, toast }) => {
  const t = translations[lang];
  const en = lang === "en";
  const [form, setForm] = useState<AppConfig>(config);
  const [adminToken, setAdminToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notifPerm, setNotifPerm] = useState<string>("");
  const [aiInfo, setAiInfo] = useState<any>(null);
  const paired = config.device_token === "(paired)";
  const portChanged = form.p2p_port !== config.p2p_port;

  useEffect(() => setForm(config), [config]);
  useEffect(() => {
    api.getNotificationPermission().then(setNotifPerm).catch(() => setNotifPerm("unknown"));
    if (paired) api.aiProviders().then(setAiInfo).catch(() => setAiInfo(null));
  }, [paired]);

  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]) => setForm((f) => ({ ...f, [k]: v }));

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await api.testServerConnection(form.server_url);
      setStatus(`✓ ${en ? "Server reachable" : "Server əlçatandır"}: v${r.version || "?"}, schema ${r.schema_version ?? "?"}`);
    } catch (e) {
      setStatus(`✗ ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const pair = async () => {
    if (!form.server_url.trim() || !adminToken.trim()) {
      setStatus(en ? "Enter the server URL and the admin pairing token." : "Server URL və admin pairing token daxil edin.");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.registerDeviceApi(form.server_url, adminToken, form.device_name);
      setAdminToken("");
      setStatus(en ? "✓ Paired. The admin token was not stored on this PC. First sync is running…" : "✓ Cütləşdirildi. Admin token bu kompüterdə saxlanılmadı. İlk sinxronizasiya başlayır…");
      onPaired();
      try {
        await api.triggerDeltaSync();
      } catch (e) {
        toast("warning", errText(e));
      }
      onPaired();
    } catch (e) {
      setStatus(`✗ ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    if (!window.confirm(en ? "Disconnect this PC from the server? Local data stays on this PC." : "Bu kompüter serverdən ayrılsın? Lokal məlumat qalır.")) return;
    await api.unpairDevice();
    onPaired();
  };

  const pickFolder = async () => {
    const p = await api.pickFolderDialog();
    if (p) set("download_dir", p);
  };

  const save = async () => {
    await onSaveConfig({ ...form, theme, language: lang });
  };

  return (
    <div className="content-view">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.settTitle}</h2>
          <p className="muted">{t.settSubtitle}</p>
        </div>
        <button className="btn-primary" onClick={save}><Save size={16} /> {en ? "Save settings" : "Ayarları saxla"}</button>
      </div>

      <div className="card col">
        <div className="card-title"><ShieldCheck size={16} /> {en ? "Debian server & pairing" : "Debian server və cütləşdirmə"}</div>
        <div className="form-grid">
          <label>Server URL<input type="url" placeholder="http://100.x.y.z:8000" value={form.server_url} onChange={(e) => set("server_url", e.target.value)} /></label>
          <label>{en ? "This device's name" : "Bu cihazın adı"}<input type="text" value={form.device_name} onChange={(e) => set("device_name", e.target.value)} /></label>
          {!paired && <label>{en ? "Admin pairing token (used once, not stored)" : "Admin pairing token (bir dəfə istifadə olunur, saxlanmır)"}<input type="password" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} /></label>}
        </div>
        <div className="muted">{en ? "Device ID" : "Cihaz ID"}: {config.device_id} · {paired ? (en ? "paired" : "cütləşdirilib") : (en ? "not paired" : "cütləşdirilməyib")}
          {config.mesh_key ? ` · P2P ${en ? "key" : "açarı"} ✓` : ""}</div>
        <div className="row">
          <button className="btn-secondary" disabled={busy} onClick={test}>{en ? "Test connection" : "Bağlantını yoxla"}</button>
          {!paired && <button className="btn-primary" disabled={busy} onClick={pair}><Link2 size={15} /> {en ? "Pair this PC" : "Bu kompüteri qoş"}</button>}
          {paired && <button className="btn-secondary" onClick={unpair}><Unlink size={15} /> {en ? "Disconnect" : "Ayır"}</button>}
        </div>
        {status && <div className="muted" style={{ color: status.startsWith("✓") ? "var(--success)" : status.startsWith("✗") ? "var(--danger)" : undefined }}>{status}</div>}
        <label className="row">
          {en ? "Automatic sync every" : "Avtomatik sinxronizasiya hər"}
          <select value={form.auto_sync_minutes} onChange={(e) => set("auto_sync_minutes", +e.target.value)}>
            {[0, 1, 5, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 0 ? (en ? "off (manual only)" : "söndürülüb (yalnız əl ilə)") : `${m} ${en ? "min" : "dəq"}`}</option>)}
          </select>
          <span className="muted">{en ? "Local changes are also synced a few seconds after you make them." : "Lokal dəyişikliklər bir neçə saniyə sonra da göndərilir."}</span>
        </label>
        {config.last_sync_error && <div className="danger-box">{config.last_sync_error}</div>}
      </div>

      <div className="card col">
        <div className="card-title"><Bell size={16} /> {en ? "Reminders & startup" : "Xatırlatmalar və başlanğıc"}</div>
        <label className="row"><input type="checkbox" checked={form.auto_start} onChange={(e) => set("auto_start", e.target.checked)} />
          {en ? "Start with Windows (minimized to tray) so reminders work after reboot" : "Windows ilə başla (tray-də gizli) — yenidən yükləmədən sonra da xatırlatmalar işləsin"}</label>
        <label className="row"><input type="checkbox" checked={form.minimize_to_tray} onChange={(e) => set("minimize_to_tray", e.target.checked)} />
          {en ? "Closing the window keeps Cahangir running in the tray (reminders and sync continue)" : "Pəncərəni bağlayanda tray-də işləməyə davam etsin (xatırlatma və sinx davam edir)"}</label>
        <div className="row">
          <span className="muted">{en ? "Notification permission" : "Bildiriş icazəsi"}: {notifPerm}</span>
          <button className="btn-secondary btn-small" onClick={() => api.testNotification().then(() => toast("success", "✓")).catch((e) => toast("error", errText(e)))}>{en ? "Send test notification" : "Test bildirişi"}</button>
        </div>
        <div className="form-grid">
          <label>{en ? "Planner: earliest work time" : "Planlayıcı: işin başlanğıcı"}<input type="time" value={form.planner_day_start} onChange={(e) => set("planner_day_start", e.target.value)} /></label>
          <label>{en ? "Planner: latest work time" : "Planlayıcı: işin sonu"}<input type="time" value={form.planner_day_end} onChange={(e) => set("planner_day_end", e.target.value)} /></label>
        </div>
      </div>

      <div className="card col">
        <div className="card-title"><Folder size={16} /> {en ? "File transfer & clipboard" : "Fayl ötürmə və pano"}</div>
        <div className="row">
          <input type="text" value={form.download_dir} readOnly style={{ flex: 1 }} />
          <button className="btn-secondary" onClick={pickFolder}>{en ? "Choose folder" : "Qovluq seç"}</button>
        </div>
        <label className="row">P2P port
          <input type="number" min={1024} max={65535} value={form.p2p_port} onChange={(e) => set("p2p_port", parseInt(e.target.value) || 8767)} style={{ width: 120 }} />
          {portChanged && <><span className="muted">{en ? "Takes effect after restart" : "Yenidən başladıqdan sonra qüvvəyə minir"}</span>
            <button className="btn-secondary btn-small" onClick={async () => { await save(); api.restartApp(); }}><RotateCcw size={13} /> {en ? "Save & restart" : "Saxla və yenidən başlat"}</button></>}
        </label>
        <label className="row"><input type="checkbox" checked={form.clipboard_sync_enabled} onChange={(e) => set("clipboard_sync_enabled", e.target.checked)} />
          {en ? "Put text received from my paired devices on this PC's clipboard" : "Cütləşdirilmiş cihazlardan gələn mətni bu kompüterin panosuna qoy"}</label>
        <label className="row"><input type="checkbox" checked={form.clipboard_auto_share} onChange={(e) => set("clipboard_auto_share", e.target.checked)} />
          {en ? "Automatically share text I copy on this PC with my devices (off by default)" : "Bu kompüterdə kopyaladığım mətni cihazlarımla avtomatik paylaş (standart: söndürülüb)"}</label>
      </div>

      <div className="card col">
        <div className="card-title"><Globe size={16} /> AI</div>
        {!paired && <div className="muted">{en ? "AI runs through the Debian server's free-tier router. Pair first." : "AI Debian serverdəki pulsuz router vasitəsilə işləyir. Əvvəlcə cütləşdirin."}</div>}
        {aiInfo && aiInfo.providers.map((p: any) => (
          <div key={p.name} className="row muted">
            <span className={`pill ${p.available ? "ok" : ""}`}>{p.available ? "✓" : "–"}</span>
            {p.label} · {p.model} · {p.enabled ? (en ? "enabled" : "aktiv") : (en ? "disabled" : "deaktiv")} · {p.key_configured ? "key ✓" : "key ✗"} · {p.usage_today.requests}/{p.limits.rpd} {en ? "today" : "bu gün"}
            {p.status !== "ok" ? ` · ${p.status}` : ""}
          </div>
        ))}
        {aiInfo && !aiInfo.any_available && <div className="muted">{en ? "No free AI provider available — the planner uses its built-in rules." : "Pulsuz AI provayderi yoxdur — planlayıcı daxili qaydalarla işləyir."}</div>}
      </div>

      <div className="card col">
        <div className="card-title"><Palette size={16} /> {en ? "Appearance" : "Görünüş"}</div>
        <div className="row">
          <select value={theme} onChange={(e) => setTheme(e.target.value as "dark" | "light")}>
            <option value="dark">{t.settThemeDark}</option>
            <option value="light">{t.settThemeLight}</option>
          </select>
          <select value={lang} onChange={(e) => setLang(e.target.value as Language)}>
            <option value="az">Azərbaycan dili</option>
            <option value="en">English</option>
          </select>
          <span className="muted">{en ? "Saved with 'Save settings'" : "'Ayarları saxla' ilə yadda saxlanılır"}</span>
        </div>
      </div>
    </div>
  );
};
