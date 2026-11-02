import React, { useState } from "react";
import { Smartphone, Monitor, ShieldAlert, CheckCircle2, UserX, RefreshCw } from "lucide-react";
import { DeviceItem, ActiveView } from "../types";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";

interface DevicesProps {
  lang: Language;
  devices: DeviceItem[];
  onRefreshDevices: () => void;
  serverUrl: string;
  adminToken: string;
  setActiveView: (view: ActiveView) => void;
}

export const DevicesView: React.FC<DevicesProps> = ({
  lang,
  devices,
  onRefreshDevices,
  serverUrl,
  adminToken,
  setActiveView,
}) => {
  const t = translations[lang];
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionMsg, setActionMsg] = useState("");

  const handleRevoke = async (deviceId: string, deviceName: string) => {
    if (!adminToken) {
      alert("Cihazı ləğv etmək üçün Ayarlar bölməsində Admin Pairing Token daxil edilməlidir.");
      setActiveView("settings");
      return;
    }

    if (window.confirm(`"${deviceName}" cihazının icazəsini ləğv etmək istədiyinizdən əminsiniz?`)) {
      try {
        await api.revokeDeviceApi(serverUrl, adminToken, deviceId);
        setActionMsg(`✓ "${deviceName}" cihazı uğurla ləğv edildi.`);
        onRefreshDevices();
      } catch (e: any) {
        setActionMsg(`Xəta: ${e?.message || e}`);
      }
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await onRefreshDevices();
    setIsRefreshing(false);
  };

  return (
    <div className="content-view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.devTitle}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t.devSubtitle}</p>
        </div>
        <button className="btn-secondary" onClick={handleRefresh} disabled={isRefreshing}>
          <RefreshCw size={15} className={isRefreshing ? "spin-animation" : ""} />
          <span>Yenilə</span>
        </button>
      </div>

      {actionMsg && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            background: "rgba(56, 189, 248, 0.1)",
            border: "1px solid var(--accent-blue)",
            fontSize: "0.88rem",
            color: "var(--accent-blue)",
          }}
        >
          {actionMsg}
        </div>
      )}

      {devices.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <Smartphone size={40} color="var(--text-muted)" style={{ margin: "0 auto 12px" }} />
          <h3>Cihazlar yüklənməyib</h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem", marginTop: "6px" }}>
            Ayarlar bölməsində Admin Token təyin edildikdən sonra bütün cihazların siyahısı burada
            görünəcək.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {devices.map((dev) => {
            const isAndroid =
              dev.device_name.toLowerCase().includes("galaxy") ||
              dev.device_name.toLowerCase().includes("android") ||
              dev.device_name.toLowerCase().includes("s25");
            const isRevoked = dev.is_revoked === 1;

            return (
              <div
                key={dev.device_id}
                className="card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "16px 20px",
                  opacity: isRevoked ? 0.6 : 1,
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
                    {isAndroid ? <Smartphone size={24} color="#38bdf8" /> : <Monitor size={24} color="#a855f7" />}
                  </div>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span style={{ fontWeight: 600, fontSize: "1rem" }}>{dev.device_name}</span>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          backgroundColor: isRevoked
                            ? "rgba(239, 68, 68, 0.2)"
                            : "rgba(16, 185, 129, 0.2)",
                          color: isRevoked ? "#ef4444" : "#10b981",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        {isRevoked ? <ShieldAlert size={11} /> : <CheckCircle2 size={11} />}
                        {isRevoked ? "Ləğv edilib" : "Etibarlı"}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "4px" }}>
                      ID: <code style={{ color: "var(--accent-blue)" }}>{dev.device_id}</code> • Qeydiyyat:{" "}
                      {new Date(dev.created_at).toLocaleDateString("az-AZ")} • Son görünmə:{" "}
                      {new Date(dev.last_seen_at).toLocaleString("az-AZ")}
                    </div>
                  </div>
                </div>

                {!isRevoked && (
                  <button
                    className="btn-secondary"
                    style={{ color: "var(--danger)", borderColor: "rgba(239, 68, 68, 0.3)" }}
                    onClick={() => handleRevoke(dev.device_id, dev.device_name)}
                  >
                    <UserX size={15} />
                    <span>{t.devRevoke}</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
