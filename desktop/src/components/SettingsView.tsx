import React, { useState, useEffect } from "react";
import { Settings, Save, CheckCircle2, ShieldCheck, Folder, Globe, Palette } from "lucide-react";
import { AppConfig } from "../types";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";

interface SettingsProps {
  lang: Language;
  setLang: (lang: Language) => void;
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  config: AppConfig;
  onSaveConfig: (cfg: AppConfig) => void;
}

export const SettingsView: React.FC<SettingsProps> = ({
  lang,
  setLang,
  theme,
  setTheme,
  config,
  onSaveConfig,
}) => {
  const t = translations[lang];

  const [serverUrl, setServerUrl] = useState(config.server_url);
  const [adminToken, setAdminToken] = useState(config.admin_token);
  const [downloadDir, setDownloadDir] = useState(config.download_dir);
  const [p2pPort, setP2pPort] = useState(config.p2p_port);
  const [autoStart, setAutoStart] = useState(config.auto_start);
  const [minimizeToTray, setMinimizeToTray] = useState(config.minimize_to_tray);
  const [clipboardSync, setClipboardSync] = useState(config.clipboard_sync_enabled);

  const [testResult, setTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isPairing, setIsPairing] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setServerUrl(config.server_url);
    setAdminToken(config.admin_token);
    setDownloadDir(config.download_dir);
    setP2pPort(config.p2p_port);
    setAutoStart(config.auto_start);
    setMinimizeToTray(config.minimize_to_tray);
    setClipboardSync(config.clipboard_sync_enabled);
  }, [config]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await api.testServerConnection(serverUrl);
      setTestResult(`✓ Bağlantı uğurludur: Status ${res.status || "online"}`);
    } catch (e: any) {
      setTestResult(`✗ Xəta: ${e?.message || e}`);
    } finally {
      setIsTesting(false);
    }
  };

  const handlePairDevice = async () => {
    if (!adminToken.trim()) {
      alert("Admin Pairing Token daxil edilməlidir.");
      return;
    }
    setIsPairing(true);
    setTestResult(null);
    try {
      const res = await api.registerDeviceApi(
        serverUrl,
        adminToken,
        config.device_id,
        config.device_name
      );
      setTestResult(`✓ Cihaz serverdə qeydiyyatdan keçdi! Açarı: ${res.api_token?.substring(0, 10)}...`);
      onSaveConfig({
        ...config,
        server_url: serverUrl,
        admin_token: adminToken,
        device_token: res.api_token || config.device_token,
      });
    } catch (e: any) {
      setTestResult(`✗ Qeydiyyat xətası: ${e?.message || e}`);
    } finally {
      setIsPairing(false);
    }
  };

  const handlePickFolder = async () => {
    try {
      const picked = await api.pickFolderDialog();
      if (picked) {
        setDownloadDir(picked);
      }
    } catch (e) {
      console.error("Folder picker error", e);
    }
  };

  const handleSaveAll = () => {
    const updated: AppConfig = {
      ...config,
      server_url: serverUrl.trim(),
      admin_token: adminToken.trim(),
      download_dir: downloadDir,
      p2p_port: p2pPort,
      auto_start: autoStart,
      minimize_to_tray: minimizeToTray,
      clipboard_sync_enabled: clipboardSync,
      theme,
      language: lang,
    };
    onSaveConfig(updated);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 3000);
  };

  return (
    <div className="content-view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.settTitle}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t.settSubtitle}</p>
        </div>
        <button className="btn-primary" onClick={handleSaveAll}>
          <Save size={16} />
          <span>{t.settSaveBtn}</span>
        </button>
      </div>

      {saveSuccess && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            background: "rgba(16, 185, 129, 0.15)",
            border: "1px solid #10b981",
            color: "#10b981",
            fontSize: "0.88rem",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <CheckCircle2 size={16} />
          <span>Bütün tənzimləmələr uğurla yaddaşa yazıldı!</span>
        </div>
      )}

      {/* Debian Server Card */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
          <ShieldCheck size={20} color="#38bdf8" />
          <h3 style={{ fontSize: "1rem" }}>Debian Ev Serveri (Tailscale Mesh)</h3>
          {config.device_token && (
            <span
              style={{
                marginLeft: "auto",
                fontSize: "0.75rem",
                padding: "2px 8px",
                borderRadius: "4px",
                backgroundColor: "rgba(16, 185, 129, 0.2)",
                color: "#10b981",
                fontWeight: 600,
              }}
            >
              Cihaz Açarı Aktivdir
            </span>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.settServerUrl}
            </label>
            <input
              type="url"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://100.114.91.32:8766"
            />
          </div>

          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.settAdminToken}
            </label>
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              placeholder="Debian serverin quraşdırılma açarı..."
            />
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleTestConnection}
              disabled={isTesting}
            >
              {t.settTestConn}
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={handlePairDevice}
              disabled={isPairing || !adminToken.trim()}
            >
              {t.settPairDevice}
            </button>
          </div>

          {testResult && (
            <div
              style={{
                fontSize: "0.85rem",
                marginTop: "4px",
                color: testResult.startsWith("✓") ? "#10b981" : "#ef4444",
              }}
            >
              {testResult}
            </div>
          )}
        </div>
      </div>

      {/* P2P and Storage */}
      <div className="card">
        <h3 style={{ fontSize: "1rem", marginBottom: "14px" }}>P2P Fayl və Saxlanc</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.settDownloadDir}
            </label>
            <div style={{ display: "flex", gap: "10px" }}>
              <input type="text" value={downloadDir} readOnly />
              <button type="button" className="btn-secondary" onClick={handlePickFolder}>
                <Folder size={16} />
                <span>Seç</span>
              </button>
            </div>
          </div>

          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.settP2pPort}
            </label>
            <input
              type="number"
              value={p2pPort}
              onChange={(e) => setP2pPort(parseInt(e.target.value) || 8767)}
            />
          </div>
        </div>
      </div>

      {/* Windows Desktop Features */}
      <div className="card">
        <h3 style={{ fontSize: "1rem", marginBottom: "14px" }}>Windows İnteqrasiyası</h3>
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              style={{ width: "18px", height: "18px" }}
            />
            <span style={{ fontSize: "0.9rem" }}>{t.settAutoStart}</span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={minimizeToTray}
              onChange={(e) => setMinimizeToTray(e.target.checked)}
              style={{ width: "18px", height: "18px" }}
            />
            <span style={{ fontSize: "0.9rem" }}>{t.settMinimizeTray}</span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: "10px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={clipboardSync}
              onChange={(e) => setClipboardSync(e.target.checked)}
              style={{ width: "18px", height: "18px" }}
            />
            <span style={{ fontSize: "0.9rem" }}>Avtomatik Pano (Clipboard) Sinxronizasiyası</span>
          </label>
        </div>
      </div>

      {/* Language & Theme */}
      <div className="card">
        <h3 style={{ fontSize: "1rem", marginBottom: "14px" }}>Görünüş və Dil</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              <Palette size={14} style={{ display: "inline", marginRight: "4px" }} />
              {t.settTheme}
            </label>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as "dark" | "light")}
            >
              <option value="dark">{t.settThemeDark}</option>
              <option value="light">{t.settThemeLight}</option>
            </select>
          </div>

          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              <Globe size={14} style={{ display: "inline", marginRight: "4px" }} />
              {t.settLang}
            </label>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Language)}
            >
              <option value="az">Azərbaycan dili</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
