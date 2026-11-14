import React, { useEffect, useState } from "react";
import { FileUp, RefreshCw, Trash2, XCircle } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { DeviceItem, TransferItem } from "../types";
import { api, errText } from "../services/api";
import { Language } from "../services/i18n";

interface Props {
  lang: Language;
  transfers: TransferItem[];
  devices: DeviceItem[];
  myDeviceId: string;
  onRefreshTransfers: () => void;
  onRefreshDevices: () => void;
  selectedPeerIp: string;
  p2pReady: boolean;
  toast: (type: "info" | "success" | "warning" | "error", text: string) => void;
}

const fmtBytes = (b: number) => (b > 1 << 30 ? (b / (1 << 30)).toFixed(2) + " GB" : b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : b > 1024 ? (b / 1024).toFixed(0) + " KB" : b + " B");

export const FileTransferView: React.FC<Props> = ({ lang, transfers, devices, myDeviceId, onRefreshTransfers, onRefreshDevices, selectedPeerIp, p2pReady, toast }) => {
  const en = lang === "en";
  const peers = devices.filter((d) => d.device_id !== myDeviceId && (d.p2p_hosts?.length || 0) > 0 && (d.p2p_port || 0) > 0);
  const [peerKey, setPeerKey] = useState<string>("");
  const [manualHost, setManualHost] = useState(selectedPeerIp);
  const [manualPort, setManualPort] = useState(8767);
  const [progress, setProgress] = useState<{ dir: string; percent: number; speed: number; name: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [pingResult, setPingResult] = useState<string>("");

  useEffect(() => {
    const subs = [
      listen<any>("p2p://transfer-started", (e) => setProgress({ dir: e.payload.direction, percent: 0, speed: 0, name: e.payload.filename })),
      listen<any>("p2p://transfer-progress", (e) => setProgress((p) => ({ dir: e.payload.direction, percent: e.payload.percent, speed: e.payload.speed_mbps, name: p?.name || "" }))),
      listen<any>("p2p://transfer-complete", () => { setProgress(null); onRefreshTransfers(); }),
      listen<any>("p2p://transfer-failed", () => { setProgress(null); onRefreshTransfers(); }),
    ];
    return () => subs.forEach((p) => p.then((f) => f()));
  }, []);

  const target = (): { host: string; port: number; name: string } | null => {
    if (peerKey && peerKey !== "manual") {
      const [id, host] = peerKey.split("|");
      const d = peers.find((p) => p.device_id === id);
      return d ? { host, port: d.p2p_port || 8767, name: d.device_name } : null;
    }
    return manualHost.trim() ? { host: manualHost.trim(), port: manualPort, name: manualHost.trim() } : null;
  };

  const ping = async () => {
    const tg = target();
    if (!tg) return;
    try {
      const r = await api.pingPeer(tg.host, tg.port);
      setPingResult(`✓ ${r.device_name} (${r.platform || "?"})`);
    } catch (e) {
      setPingResult(`✗ ${errText(e)}`);
    }
  };

  const send = async () => {
    const tg = target();
    if (!tg) {
      toast("warning", en ? "Choose a device." : "Cihaz seçin.");
      return;
    }
    const path = await api.pickFileDialog();
    if (!path) return;
    setSending(true);
    try {
      const r = await api.startFileSend(tg.host, tg.port, path, tg.name);
      if (r.success) toast("success", `${r.filename}: ${en ? "sent and verified" : "göndərildi və yoxlanıldı"} (SHA-256 ${r.sha256.slice(0, 12)}…)`);
      else toast(r.canceled ? "warning" : "error", r.error || "?");
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setSending(false);
      setProgress(null);
      onRefreshTransfers();
    }
  };

  return (
    <div className="content-view">
      <div>
        <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{en ? "File transfer" : "Fayl ötürmə"}</h2>
        <p className="muted">{en ? "Direct, authenticated transfer to your paired devices (LAN or Tailscale), verified with SHA-256 on both sides." : "Cütləşdirilmiş cihazlara birbaşa, təsdiqlənmiş ötürmə (LAN və ya Tailscale); hər iki tərəfdə SHA-256 ilə yoxlanılır."}</p>
      </div>
      {!p2pReady && <div className="conflict">{en ? "This PC has no P2P key yet. Pair with the Debian server and sync once." : "Bu kompüterin hələ P2P açarı yoxdur. Debian serverlə cütləşdirib bir dəfə sinxron edin."}</div>}
      <div className="card col">
        <div className="row">
          <select value={peerKey} onChange={(e) => setPeerKey(e.target.value)} style={{ minWidth: 280 }}>
            <option value="">{en ? "— choose a paired device —" : "— cütləşdirilmiş cihaz seçin —"}</option>
            {peers.flatMap((d) => (d.p2p_hosts || []).map((h) => (
              <option key={d.device_id + h} value={`${d.device_id}|${h}`}>{d.device_name} · {h}:{d.p2p_port} {h.startsWith("100.") ? "(Tailscale)" : "(LAN)"}</option>
            )))}
            <option value="manual">{en ? "Enter address manually…" : "Ünvanı əl ilə daxil et…"}</option>
          </select>
          <button className="btn-icon" title="Refresh" onClick={onRefreshDevices}><RefreshCw size={14} /></button>
          {peerKey === "manual" && <>
            <input type="text" placeholder="192.168.1.20" value={manualHost} onChange={(e) => setManualHost(e.target.value)} />
            <input type="number" value={manualPort} onChange={(e) => setManualPort(+e.target.value || 8767)} style={{ width: 100 }} />
          </>}
          <button className="btn-secondary" onClick={ping}>{en ? "Check" : "Yoxla"}</button>
          <button className="btn-primary" disabled={sending || !p2pReady} onClick={send}><FileUp size={15} /> {en ? "Choose file & send" : "Fayl seç və göndər"}</button>
        </div>
        {pingResult && <div className="muted">{pingResult}</div>}
        {progress && (
          <div className="col">
            <div className="muted">{progress.dir === "send" ? "↑" : "↓"} {progress.name} — {progress.percent.toFixed(0)}% · {progress.speed.toFixed(1)} MB/s</div>
            <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${progress.percent}%` }} /></div>
            {progress.dir === "send" && <button className="btn-secondary btn-small" onClick={() => api.cancelFileTransfer()}><XCircle size={13} /> {en ? "Cancel" : "Ləğv et"}</button>}
          </div>
        )}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{en ? "History" : "Tarixçə"}</b>
        <button className="btn-secondary btn-small" onClick={() => api.clearTransferHistory().then(onRefreshTransfers)}><Trash2 size={13} /> {en ? "Clear" : "Təmizlə"}</button>
      </div>
      {transfers.map((tr) => (
        <div className="item" key={tr.id}>
          <div className="grow">
            <div className="title">{tr.direction === "send" ? "↑" : "↓"} {tr.filename}</div>
            <div className="muted">
              {fmtBytes(tr.file_size)} · {tr.peer_device} · {new Date(tr.timestamp).toLocaleString(en ? "en-GB" : "az-AZ")} · {tr.speed_mbps.toFixed(1)} MB/s
              {tr.sha256 ? ` · SHA-256 ${tr.sha256.slice(0, 16)}…` : ""}
            </div>
          </div>
          <span className={`pill ${tr.status === "completed" ? "ok" : tr.status === "failed" ? "urgent" : ""}`}>{tr.status}</span>
        </div>
      ))}
    </div>
  );
};
