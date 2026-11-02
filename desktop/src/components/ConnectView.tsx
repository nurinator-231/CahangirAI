import React, { useState } from "react";
import { Smartphone, Monitor, Send, Clipboard, ShieldCheck, RefreshCw } from "lucide-react";
import { DeviceItem, ActiveView } from "../types";
import { translations, Language } from "../services/i18n";

interface ConnectProps {
  lang: Language;
  devices: DeviceItem[];
  onRefreshDevices: () => void;
  setActiveView: (view: ActiveView) => void;
  setSelectedPeerIp: (ip: string) => void;
}

export const ConnectView: React.FC<ConnectProps> = ({
  lang,
  devices,
  onRefreshDevices,
  setActiveView,
  setSelectedPeerIp,
}) => {
  const t = translations[lang];
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await onRefreshDevices();
    setIsRefreshing(false);
  };

  const handleSendFileTo = (ip: string) => {
    setSelectedPeerIp(ip);
    setActiveView("file-transfer");
  };

  const handleSendClipboardTo = (ip: string) => {
    setSelectedPeerIp(ip);
    setActiveView("clipboard");
  };

  return (
    <div className="content-view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.pairedDevices}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
            Tailscale və yerli şəbəkə üzərindən birbaşa P2P bağlantı
          </p>
        </div>
        <button className="btn-secondary" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw size={15} className={isRefreshing ? "spin-animation" : ""} />
          <span>Yenilə</span>
        </button>
      </div>

      {devices.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <Smartphone size={40} color="var(--text-muted)" style={{ margin: "0 auto 12px" }} />
          <h3>{t.noDevicesFound}</h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginTop: "6px" }}>
            Ayarlar bölməsinə keçərək Debian serverin admin tokenini daxil edin.
          </p>
          <button
            className="btn-primary"
            style={{ margin: "18px auto 0" }}
            onClick={() => setActiveView("settings")}
          >
            Ayarlara Keç
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {devices.map((dev) => {
            const isAndroid =
              dev.device_name.toLowerCase().includes("galaxy") ||
              dev.device_name.toLowerCase().includes("android") ||
              dev.device_name.toLowerCase().includes("s25");
            const isOnline = dev.is_revoked === 0;

            return (
              <div
                key={dev.device_id}
                className="card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                  <div
                    style={{
                      width: "44px",
                      height: "44px",
                      borderRadius: "10px",
                      background: isAndroid ? "rgba(56, 189, 248, 0.15)" : "rgba(168, 85, 247, 0.15)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {isAndroid ? (
                      <Smartphone size={24} color="#38bdf8" />
                    ) : (
                      <Monitor size={24} color="#a855f7" />
                    )}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontWeight: 600, fontSize: "1rem" }}>{dev.device_name}</span>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          backgroundColor: isOnline
                            ? "rgba(16, 185, 129, 0.2)"
                            : "rgba(239, 68, 68, 0.2)",
                          color: isOnline ? "#10b981" : "#ef4444",
                          fontWeight: 600,
                        }}
                      >
                        {isOnline ? "Aktiv" : "Ləğv edilib"}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "3px" }}>
                      ID: {dev.device_id} • Son aktivlik:{" "}
                      {new Date(dev.last_seen_at).toLocaleString("az-AZ")}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px" }}>
                  <button
                    className="btn-secondary"
                    onClick={() => handleSendFileTo("100.114.91.32")}
                    title="Bu cihaza fayl göndər"
                  >
                    <Send size={15} />
                    <span>{t.sendFileBtn}</span>
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => handleSendClipboardTo("100.114.91.32")}
                    title="Mətni bu cihaza göndər"
                  >
                    <Clipboard size={15} />
                    <span>{t.sendClipBtn}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Security note */}
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          backgroundColor: "rgba(56, 189, 248, 0.05)",
        }}
      >
        <ShieldCheck size={24} color="#38bdf8" />
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          Bütün cihazlararası əlaqə <b>Tailscale WireGuard</b> şifrələməsi ilə qorunur. Fayllar və
          pano birbaşa P2P vasitəsilə ötürülür və üçüncü tərəfə ötürülmür.
        </div>
      </div>
    </div>
  );
};
