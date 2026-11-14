import React, { useState } from "react";
import { RefreshCw, ShieldOff } from "lucide-react";
import { DeviceItem } from "../types";
import { api, errText } from "../services/api";
import { Language } from "../services/i18n";

interface Props {
  lang: Language;
  devices: DeviceItem[];
  myDeviceId: string;
  onRefreshDevices: () => void;
  toast: (type: "info" | "success" | "warning" | "error", text: string) => void;
}

export const DevicesView: React.FC<Props> = ({ lang, devices, myDeviceId, onRefreshDevices, toast }) => {
  const en = lang === "en";
  const [revoking, setRevoking] = useState<DeviceItem | null>(null);
  const [adminToken, setAdminToken] = useState("");

  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.revokeDeviceApi(adminToken, revoking.device_id);
      toast("success", en ? `${revoking.device_name} revoked; the P2P key was rotated.` : `${revoking.device_name} ləğv edildi; P2P açarı yeniləndi.`);
      setRevoking(null);
      setAdminToken("");
      onRefreshDevices();
    } catch (e) {
      toast("error", errText(e));
    }
  };

  return (
    <div className="content-view">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{en ? "Paired devices" : "Cütləşdirilmiş cihazlar"}</h2>
          <p className="muted">{en ? "Devices paired with your Debian server. Only these devices can sync or exchange files and clipboard." : "Debian serverinizə qoşulmuş cihazlar. Yalnız bu cihazlar sinxron edə, fayl və pano mübadiləsi apara bilər."}</p>
        </div>
        <button className="btn-secondary" onClick={onRefreshDevices}><RefreshCw size={15} /> {en ? "Refresh" : "Yenilə"}</button>
      </div>
      {devices.length === 0 && <div className="muted">{en ? "No devices (pair this PC in Settings, or the server is unreachable)." : "Cihaz yoxdur (Ayarlarda bu kompüteri qoşun və ya server əlçatmazdır)."}</div>}
      {devices.map((d) => (
        <div className="item" key={d.device_id}>
          <div className="grow">
            <div className="title">{d.device_name} {d.device_id === myDeviceId && <span className="pill ok">{en ? "this PC" : "bu kompüter"}</span>} <span className="pill">{d.platform || "?"}</span></div>
            <div className="muted">
              {en ? "Last seen" : "Son görülmə"}: {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString(en ? "en-GB" : "az-AZ") : "—"}
              {" · "}{en ? "last sync" : "son sinx"}: {d.last_sync_at ? new Date(d.last_sync_at).toLocaleString(en ? "en-GB" : "az-AZ") : "—"}
              {d.p2p_hosts?.length ? ` · P2P ${d.p2p_hosts.join(", ")}:${d.p2p_port}` : ""}
              {d.app_version ? ` · v${d.app_version}` : ""}
            </div>
          </div>
          {d.device_id !== myDeviceId && <button className="btn-secondary btn-small" onClick={() => setRevoking(d)}><ShieldOff size={13} /> {en ? "Revoke" : "Ləğv et"}</button>}
        </div>
      ))}
      {revoking && (
        <div className="card col">
          <b>{en ? `Revoke ${revoking.device_name}?` : `${revoking.device_name} ləğv edilsin?`}</b>
          <div className="muted">{en ? "Enter the admin pairing token (it is not stored)." : "Admin pairing token daxil edin (saxlanılmır)."}</div>
          <input type="password" value={adminToken} onChange={(e) => setAdminToken(e.target.value)} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-secondary" onClick={() => setRevoking(null)}>{en ? "Cancel" : "Ləğv"}</button>
            <button className="btn-primary" disabled={!adminToken} onClick={revoke}>{en ? "Revoke access" : "Girişi ləğv et"}</button>
          </div>
        </div>
      )}
    </div>
  );
};
