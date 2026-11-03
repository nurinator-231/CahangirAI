import React, { useState, useEffect } from "react";
import { Folder, Upload, XCircle, CheckCircle2, History, ShieldAlert } from "lucide-react";
import { TransferItem } from "../types";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";
import { listen } from "@tauri-apps/api/event";

interface FileTransferProps {
  lang: Language;
  transfers: TransferItem[];
  onRefreshTransfers: () => void;
  selectedPeerIp?: string;
  defaultDownloadDir: string;
}

export const FileTransferView: React.FC<FileTransferProps> = ({
  lang,
  transfers,
  onRefreshTransfers,
  selectedPeerIp,
  defaultDownloadDir,
}) => {
  const t = translations[lang];

  const [filePath, setFilePath] = useState("");
  const [peerIp, setPeerIp] = useState(selectedPeerIp || localStorage.getItem("cahangir_last_peer_ip") || "");
  const [peerPort, setPeerPort] = useState(8767);
  const [isSending, setIsSending] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [bytesSent, setBytesSent] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    if (selectedPeerIp) {
      setPeerIp(selectedPeerIp);
    }
  }, [selectedPeerIp]);

  useEffect(() => {
    // Listen for incoming and outgoing transfer progress events from Rust
    const unlistenProgress = listen<any>("p2p://transfer-progress", (event) => {
      const p = event.payload;
      setProgressPercent(p.percent || 0);
      setCurrentSpeed(p.speed_mbps || 0);
      setBytesSent(p.sent || p.received || 0);
      setTotalBytes(p.total || 0);
      setStatusMsg(`Ötürülür... ${p.speed_mbps.toFixed(2)} MB/s`);
    });

    const unlistenComplete = listen<any>("p2p://transfer-complete", (event) => {
      const p = event.payload;
      setIsSending(false);
      setProgressPercent(100);
      setStatusMsg(`Tamamlandı! SHA-256: ${p.sha256.substring(0, 16)}...`);
      onRefreshTransfers();
    });

    return () => {
      unlistenProgress.then((f) => f());
      unlistenComplete.then((f) => f());
    };
  }, [onRefreshTransfers]);

  const handlePickFile = async () => {
    try {
      const picked = await api.pickFileDialog();
      if (picked) {
        setFilePath(picked);
      }
    } catch (e) {
      console.error("File pick error", e);
    }
  };

  const handleStartSend = async () => {
    if (!filePath || !peerIp) {
      alert("Zəhmət olmasa faylı və qarşı tərəfin IP ünvanını daxil edin.");
      return;
    }

    setIsSending(true);
    setProgressPercent(0);
    setCurrentSpeed(0);
    setStatusMsg("Qarşı tərəflə əlaqə qurulur...");
    localStorage.setItem("cahangir_last_peer_ip", peerIp.trim());

    try {
      const res = await api.startFileSend(peerIp.trim(), peerPort, filePath);
      if (!res.success) {
        setStatusMsg(`Xəta: ${res.error || "Ötürmə uğursuz oldu"}`);
        setIsSending(false);
      } else {
        setStatusMsg("Uğurla tamamlandı!");
        setIsSending(false);
        onRefreshTransfers();
      }
    } catch (e: any) {
      setStatusMsg(`Xəta: ${e?.message || e}`);
      setIsSending(false);
    }
  };

  const handleCancel = async () => {
    await api.cancelFileTransfer();
    setIsSending(false);
    setStatusMsg("İstifadəçi tərəfindən ləğv edildi.");
  };

  return (
    <div className="content-view">
      {/* Sender Panel */}
      <div className="card">
        <h3 style={{ fontSize: "1.1rem", marginBottom: "16px" }}>{t.ftTitle}</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {/* File Picker */}
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              Göndəriləcək Fayl
            </label>
            <div style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                placeholder="Fayl seçilməyib..."
                value={filePath}
                readOnly
              />
              <button className="btn-secondary" onClick={handlePickFile} style={{ flexShrink: 0 }}>
                <Folder size={16} />
                <span>{t.ftSelectFile}</span>
              </button>
            </div>
          </div>

          {/* Peer IP & Port */}
          <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                {t.ftPeerIp}
              </label>
              <input
                type="text"
                value={peerIp}
                onChange={(e) => setPeerIp(e.target.value)}
                placeholder="100.x.y.z"
              />
            </div>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                {t.ftPeerPort}
              </label>
              <input
                type="number"
                value={peerPort}
                onChange={(e) => setPeerPort(parseInt(e.target.value) || 8767)}
              />
            </div>
          </div>

          {/* Progress Section */}
          {isSending && (
            <div style={{ background: "var(--bg-secondary)", padding: "14px", borderRadius: "10px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px", fontSize: "0.85rem" }}>
                <span>{statusMsg}</span>
                <span style={{ fontWeight: 600 }}>{progressPercent.toFixed(1)}%</span>
              </div>
              <div className="progress-bar-bg">
                <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                <span>
                  {(bytesSent / (1024 * 1024)).toFixed(1)} MB / {(totalBytes / (1024 * 1024)).toFixed(1)} MB
                </span>
                <span>{currentSpeed.toFixed(2)} MB/s</span>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
            <button
              className="btn-primary"
              onClick={handleStartSend}
              disabled={isSending || !filePath}
            >
              <Upload size={16} />
              <span>{t.ftSendNow}</span>
            </button>
            {isSending && (
              <button className="btn-secondary" onClick={handleCancel}>
                <XCircle size={16} />
                <span>{t.ftCancel}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Receiver Info */}
      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>Qəbul Edilən Faylların Qovluğu</div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "2px" }}>
            {defaultDownloadDir}
          </div>
        </div>
        <span style={{ fontSize: "0.8rem", color: "var(--accent-blue)", fontWeight: 600 }}>
          P2P Dinləyici Aktivdir (:8767)
        </span>
      </div>

      {/* Transfer History Table */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
          <History size={18} color="#38bdf8" />
          <h3 style={{ fontSize: "1rem" }}>{t.ftTransferHistory}</h3>
        </div>

        {transfers.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>{t.noRecentTransfers}</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color)", color: "var(--text-muted)" }}>
                  <th style={{ padding: "8px 12px" }}>Fayl</th>
                  <th style={{ padding: "8px 12px" }}>Ölçü</th>
                  <th style={{ padding: "8px 12px" }}>İstiqamət</th>
                  <th style={{ padding: "8px 12px" }}>Sürət</th>
                  <th style={{ padding: "8px 12px" }}>Status</th>
                  <th style={{ padding: "8px 12px" }}>Tarix</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((tr) => (
                  <tr key={tr.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={{ padding: "10px 12px", fontWeight: 600 }}>{tr.filename}</td>
                    <td style={{ padding: "10px 12px" }}>
                      {(tr.file_size / (1024 * 1024)).toFixed(2)} MB
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      {tr.direction === "send" ? "Windows → Android" : "Android → Windows"}
                    </td>
                    <td style={{ padding: "10px 12px" }}>{tr.speed_mbps.toFixed(2)} MB/s</td>
                    <td style={{ padding: "10px 12px" }}>
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
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        {tr.status === "completed" ? (
                          <CheckCircle2 size={12} />
                        ) : (
                          <ShieldAlert size={12} />
                        )}
                        {tr.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", color: "var(--text-muted)" }}>
                      {new Date(tr.timestamp).toLocaleString("az-AZ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
