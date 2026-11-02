import React, { useState, useEffect } from "react";
import { Clipboard, Send, Copy, Check, ShieldCheck, History } from "lucide-react";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";
import { listen } from "@tauri-apps/api/event";

interface ClipboardProps {
  lang: Language;
  selectedPeerIp?: string;
}

interface ClipHistoryItem {
  id: string;
  text: string;
  origin: string;
  timestamp: number;
}

export const ClipboardView: React.FC<ClipboardProps> = ({ lang, selectedPeerIp }) => {
  const t = translations[lang];

  const [text, setText] = useState("");
  const [peerIp, setPeerIp] = useState(selectedPeerIp || "100.114.91.32");
  const [peerPort, setPeerPort] = useState(8767);
  const [isSending, setIsSending] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [history, setHistory] = useState<ClipHistoryItem[]>([]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [autoSync, setAutoSync] = useState(true);

  useEffect(() => {
    if (selectedPeerIp) {
      setPeerIp(selectedPeerIp);
    }
  }, [selectedPeerIp]);

  useEffect(() => {
    const unlisten = listen<any>("p2p://clipboard-received", (event) => {
      const p = event.payload;
      const newItem: ClipHistoryItem = {
        id: `clip_${Date.now()}`,
        text: p.text,
        origin: p.origin_device,
        timestamp: Date.now(),
      };
      setHistory((prev) => [newItem, ...prev.slice(0, 19)]);
      setStatusMsg(`Yeni mətn qəbul edildi: "${p.origin_device}"`);
      // Update local clipboard
      navigator.clipboard.writeText(p.text);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleSend = async () => {
    if (!text.trim() || !peerIp.trim()) {
      alert("Zəhmət olmasa mətni və qarşı tərəfin IP ünvanını daxil edin.");
      return;
    }

    setIsSending(true);
    setStatusMsg("Göndərilir...");

    try {
      await api.sendClipboardToPeer(peerIp.trim(), peerPort, text.trim());
      setStatusMsg("✓ Pano uğurla qarşı cihaza ötürüldü!");
      setHistory((prev) => [
        {
          id: `clip_sent_${Date.now()}`,
          text: text.trim(),
          origin: "Windows (Bu kompüter)",
          timestamp: Date.now(),
        },
        ...prev.slice(0, 19),
      ]);
      setText("");
    } catch (e: any) {
      setStatusMsg(`Xəta: ${e?.message || e}`);
    } finally {
      setIsSending(false);
    }
  };

  const handleCopyItem = (clipText: string, id: string) => {
    navigator.clipboard.writeText(clipText);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="content-view">
      {/* Send Card */}
      <div className="card">
        <h3 style={{ fontSize: "1.1rem", marginBottom: "14px" }}>{t.clipTitle}</h3>

        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                Hədəf Cihaz IP
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
                Port
              </label>
              <input
                type="number"
                value={peerPort}
                onChange={(e) => setPeerPort(parseInt(e.target.value) || 8767)}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.clipInputLabel}
            </label>
            <textarea
              rows={4}
              placeholder={t.clipInputPlaceholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <button
              className="btn-primary"
              onClick={handleSend}
              disabled={isSending || !text.trim()}
            >
              <Send size={16} />
              <span>{t.clipSendBtn}</span>
            </button>
            {statusMsg && (
              <span style={{ fontSize: "0.85rem", color: "var(--accent-blue)" }}>{statusMsg}</span>
            )}
          </div>
        </div>
      </div>

      {/* Auto sync info */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: "14px" }}>
        <ShieldCheck size={28} color="#10b981" />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "0.95rem", fontWeight: 600 }}>{t.clipAutoSync}</div>
          <p style={{ fontSize: "0.82rem", color: "var(--text-muted)", marginTop: "2px" }}>
            {t.clipAutoSyncDesc}
          </p>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => setAutoSync(e.target.checked)}
            style={{ width: "18px", height: "18px" }}
          />
          <span style={{ fontSize: "0.88rem", fontWeight: 500 }}>Aktiv</span>
        </label>
      </div>

      {/* History */}
      <div className="card">
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
          <History size={18} color="#38bdf8" />
          <h3 style={{ fontSize: "1rem" }}>Pano Tarixçəsi</h3>
        </div>

        {history.length === 0 ? (
          <p style={{ color: "var(--text-muted)", fontSize: "0.88rem" }}>
            Hələlik heç bir pano mətni mübadilə edilməyib.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {history.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  background: "var(--bg-secondary)",
                  borderRadius: "8px",
                  fontSize: "0.88rem",
                }}
              >
                <div style={{ flex: 1, marginRight: "12px" }}>
                  <div style={{ wordBreak: "break-all" }}>{item.text}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "4px" }}>
                    Mənbə: {item.origin} • {new Date(item.timestamp).toLocaleTimeString()}
                  </div>
                </div>
                <button
                  className="btn-icon"
                  style={{ width: "32px", height: "32px", flexShrink: 0 }}
                  onClick={() => handleCopyItem(item.text, item.id)}
                  title="Kopyala"
                >
                  {copiedId === item.id ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
