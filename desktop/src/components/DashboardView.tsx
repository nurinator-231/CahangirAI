import React from "react";
import {
  Bell,
  BrainCircuit,
  FolderKanban,
  Smartphone,
  ArrowDownUp,
  Server,
  Zap,
} from "lucide-react";
import { ActiveView, SystemMetrics, TransferItem } from "../types";
import { translations, Language } from "../services/i18n";

interface DashboardProps {
  lang: Language;
  setActiveView: (view: ActiveView) => void;
  activeRemindersCount: number;
  memoriesCount: number;
  projectsCount: number;
  devicesCount: number;
  metrics: SystemMetrics | null;
  transfers: TransferItem[];
}

export const DashboardView: React.FC<DashboardProps> = ({
  lang,
  setActiveView,
  activeRemindersCount,
  memoriesCount,
  projectsCount,
  devicesCount,
  metrics,
  transfers,
}) => {
  const t = translations[lang];

  return (
    <div className="content-view">
      {/* 4 Stat Cards */}
      <div className="grid-cards">
        <div
          className="card"
          style={{ cursor: "pointer" }}
          onClick={() => setActiveView("reminders")}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title">{t.statActiveReminders}</div>
            <Bell size={20} color="#38bdf8" />
          </div>
          <div className="card-value">{activeRemindersCount}</div>
        </div>

        <div
          className="card"
          style={{ cursor: "pointer" }}
          onClick={() => setActiveView("memories")}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title">{t.statMemories}</div>
            <BrainCircuit size={20} color="#06b6d4" />
          </div>
          <div className="card-value">{memoriesCount}</div>
        </div>

        <div
          className="card"
          style={{ cursor: "pointer" }}
          onClick={() => setActiveView("projects")}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title">{t.statActiveProjects}</div>
            <FolderKanban size={20} color="#a855f7" />
          </div>
          <div className="card-value">{projectsCount}</div>
        </div>

        <div
          className="card"
          style={{ cursor: "pointer" }}
          onClick={() => setActiveView("devices")}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title">{t.statDevices}</div>
            <Smartphone size={20} color="#10b981" />
          </div>
          <div className="card-value">{devicesCount}</div>
        </div>
      </div>

      {/* Debian Server & Tailscale Card */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
          <Server size={22} color="#38bdf8" />
          <h3 style={{ fontSize: "1.05rem" }}>Debian Ev Serveri (Intel Atom D525)</h3>
          <span
            style={{
              marginLeft: "auto",
              fontSize: "0.8rem",
              padding: "3px 8px",
              borderRadius: "6px",
              backgroundColor: metrics?.backend_online
                ? "rgba(16, 185, 129, 0.2)"
                : "rgba(239, 68, 68, 0.2)",
              color: metrics?.backend_online ? "#10b981" : "#ef4444",
              fontWeight: 600,
            }}
          >
            {metrics?.backend_online ? "Onlayn" : "Oflayn"}
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "14px",
            fontSize: "0.88rem",
          }}
        >
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>Tailscale IP</div>
            <div style={{ fontWeight: 600, marginTop: "2px" }}>100.114.91.32:8766</div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>Gecikmə (Ping)</div>
            <div style={{ fontWeight: 600, marginTop: "2px" }}>
              {metrics?.backend_latency_ms ? `${metrics.backend_latency_ms} ms` : "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>Debian CPU</div>
            <div style={{ fontWeight: 600, marginTop: "2px" }}>
              {metrics?.backend_details?.cpu_percent !== undefined
                ? `${metrics.backend_details.cpu_percent}%`
                : "0.4%"}
            </div>
          </div>
          <div>
            <div style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>Debian RAM</div>
            <div style={{ fontWeight: 600, marginTop: "2px" }}>
              {metrics?.backend_details?.ram_used_mb !== undefined
                ? `${metrics.backend_details.ram_used_mb} MB / 3921 MB`
                : "570 MB / 3921 MB"}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Action Chips */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <Zap size={18} color="#f59e0b" />
          <h3 style={{ fontSize: "1rem" }}>{t.quickActions}</h3>
        </div>
        <div className="chat-chips">
          <button className="chip-btn" onClick={() => setActiveView("ai")}>
            💬 Cahangir AI ilə söhbət
          </button>
          <button className="chip-btn" onClick={() => setActiveView("file-transfer")}>
            📤 Telefona Fayl Göndər
          </button>
          <button className="chip-btn" onClick={() => setActiveView("clipboard")}>
            📋 Mətni Panoya Göndər
          </button>
          <button className="chip-btn" onClick={() => setActiveView("reminders")}>
            ⏰ Yeni Xatırlatma Əlavə Et
          </button>
          <button className="chip-btn" onClick={() => setActiveView("system-monitor")}>
            📊 Kompüterin Resurslarını Gör
          </button>
        </div>
      </div>

      {/* Recent Transfers */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <ArrowDownUp size={18} color="#38bdf8" />
          <h3 style={{ fontSize: "1rem" }}>{t.recentTransfers}</h3>
        </div>

        {transfers.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>
            {t.noRecentTransfers}
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {transfers.slice(0, 5).map((tr) => (
              <div
                key={tr.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "8px 12px",
                  background: "var(--bg-secondary)",
                  borderRadius: "8px",
                  fontSize: "0.85rem",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{tr.filename}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                    {(tr.file_size / (1024 * 1024)).toFixed(2)} MB • {tr.direction === "send" ? "Göndərilib" : "Qəbul edilib"}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    backgroundColor:
                      tr.status === "completed"
                        ? "rgba(16, 185, 129, 0.2)"
                        : "rgba(239, 68, 68, 0.2)",
                    color: tr.status === "completed" ? "#10b981" : "#ef4444",
                  }}
                >
                  {tr.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
