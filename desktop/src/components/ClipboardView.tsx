import React, { useEffect, useState } from "react";
import { ClipboardCopy, Send, Trash2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { AppConfig, ClipboardItem } from "../types";
import { api, errText } from "../services/api";
import { Language } from "../services/i18n";

interface Props {
  lang: Language;
  config: AppConfig;
  onSaveConfig: (cfg: AppConfig) => Promise<void> | void;
  toast: (type: "info" | "success" | "warning" | "error", text: string) => void;
}

export const ClipboardView: React.FC<Props> = ({ lang, config, onSaveConfig, toast }) => {
  const en = lang === "en";
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const l = await api.getClipboardItems();
    setItems(l.sort((a, b) => b.created_at - a.created_at).slice(0, 100));
  };
  useEffect(() => {
    load();
    const subs = [listen("data://changed", load), listen("clipboard://shared", load), listen("p2p://clipboard-received", load)];
    return () => subs.forEach((p) => p.then((f) => f()));
  }, []);

  const share = async (t?: string) => {
    setBusy(true);
    try {
      const r = await api.shareClipboard(t);
      const direct = r.delivered_direct?.length ? (en ? ` Delivered directly to: ${r.delivered_direct.join(", ")}.` : ` Birbaşa çatdırıldı: ${r.delivered_direct.join(", ")}.`) : "";
      toast("success", (en ? "Shared. Offline devices receive it on their next sync." : "Paylaşıldı. Oflayn cihazlar növbəti sinxronda alacaq.") + direct);
      setText("");
      load();
    } catch (e) {
      toast("error", errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content-view">
      <div>
        <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{en ? "Universal clipboard" : "Universal pano"}</h2>
        <p className="muted">{en ? "Text shared here reaches your phone directly when reachable, or through the Debian server when it comes online." : "Burada paylaşılan mətn telefon əlçatandırsa birbaşa, deyilsə Debian server vasitəsilə çatır."}</p>
      </div>
      <div className="card col">
        <div className="row">
          <button className="btn-primary" disabled={busy} onClick={() => share()}><Send size={15} /> {en ? "Share what I copied" : "Kopyaladığımı paylaş"}</button>
          <label className="row muted">
            <input type="checkbox" checked={config.clipboard_auto_share} onChange={(e) => onSaveConfig({ ...config, clipboard_auto_share: e.target.checked })} />
            {en ? "Share automatically whenever I copy text" : "Mətn kopyalayanda avtomatik paylaş"}
          </label>
          <label className="row muted">
            <input type="checkbox" checked={config.clipboard_sync_enabled} onChange={(e) => onSaveConfig({ ...config, clipboard_sync_enabled: e.target.checked })} />
            {en ? "Accept text from my devices" : "Cihazlarımdan gələn mətni qəbul et"}
          </label>
        </div>
        <textarea className="nl" placeholder={en ? "…or type text to send" : "…və ya göndərmək üçün mətn yazın"} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn-secondary" disabled={busy || !text.trim()} onClick={() => share(text)}><Send size={15} /> {en ? "Send text" : "Mətni göndər"}</button>
        </div>
      </div>
      <b>{en ? "History" : "Tarixçə"}</b>
      {items.length === 0 && <div className="muted">{en ? "Nothing shared yet." : "Hələ heç nə paylaşılmayıb."}</div>}
      {items.map((it) => (
        <div className="item" key={it.id}>
          <div className="grow">
            <div style={{ whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>{it.text}</div>
            <div className="muted">{it.origin_name || "?"} · {new Date(it.created_at).toLocaleString(en ? "en-GB" : "az-AZ")} · {it.sync_status ? (en ? "waiting to sync" : "sinx gözləyir") : (en ? "synced" : "sinxron")}</div>
          </div>
          <button className="btn-icon" title={en ? "Copy" : "Kopyala"} onClick={() => api.copyToClipboard(it.text).then(() => toast("success", "✓"))}><ClipboardCopy size={14} /></button>
          <button className="btn-icon" title={en ? "Delete" : "Sil"} onClick={() => api.remove("clipboard_items", it.id).then(load)}><Trash2 size={14} /></button>
        </div>
      ))}
    </div>
  );
};
