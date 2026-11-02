import React, { useState } from "react";
import { Bell, Plus, CheckCircle2, Circle, Clock, Trash2, Cloud, CloudOff } from "lucide-react";
import { ReminderItem } from "../types";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";

interface RemindersProps {
  lang: Language;
  reminders: ReminderItem[];
  onRefresh: () => void;
}

export const RemindersView: React.FC<RemindersProps> = ({ lang, reminders, onRefresh }) => {
  const t = translations[lang];
  const [activeTab, setActiveTab] = useState<"active" | "done">("active");
  const [isAdding, setIsAdding] = useState(false);
  const [text, setText] = useState("");
  const [dueStr, setDueStr] = useState("");
  const [repeat, setRepeat] = useState("");

  const activeReminders = reminders.filter((r) => r.deleted === 0 && r.done === 0);
  const doneReminders = reminders.filter((r) => r.deleted === 0 && r.done === 1);

  const displayed = activeTab === "active" ? activeReminders : doneReminders;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    let dueTimestamp: number | null = null;
    if (dueStr) {
      dueTimestamp = new Date(dueStr).getTime();
    } else {
      dueTimestamp = Date.now() + 60 * 60 * 1000; // default 1 hour
    }

    try {
      await api.saveReminder({
        text: text.trim(),
        due: dueTimestamp,
        repeat: repeat || null,
        done: 0,
        timer: 0,
      });
      setText("");
      setDueStr("");
      setRepeat("");
      setIsAdding(false);
      onRefresh();
    } catch (e) {
      console.error("Failed to add reminder", e);
    }
  };

  const handleComplete = async (id: string) => {
    try {
      await api.completeReminder(id);
      onRefresh();
    } catch (e) {
      console.error("Failed to complete reminder", e);
    }
  };

  const handleSnooze = async (id: string) => {
    try {
      await api.snoozeReminder(id);
      onRefresh();
    } catch (e) {
      console.error("Failed to snooze reminder", e);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("Bu xatırlatmanı silmək istədiyinizdən əminsiniz?")) {
      try {
        await api.deleteReminder(id);
        onRefresh();
      } catch (e) {
        console.error("Failed to delete reminder", e);
      }
    }
  };

  return (
    <div className="content-view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.remTitle}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t.remSubtitle}</p>
        </div>
        <button className="btn-primary" onClick={() => setIsAdding(!isAdding)}>
          <Plus size={16} />
          <span>{t.remAdd}</span>
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "8px", borderBottom: "1px solid var(--border-color)", paddingBottom: "10px" }}>
        <button
          className={`btn-secondary ${activeTab === "active" ? "active" : ""}`}
          style={{
            background: activeTab === "active" ? "var(--accent-gradient)" : "transparent",
            color: activeTab === "active" ? "#fff" : "var(--text-secondary)",
          }}
          onClick={() => setActiveTab("active")}
        >
          {t.remActiveTab} ({activeReminders.length})
        </button>
        <button
          className={`btn-secondary ${activeTab === "done" ? "active" : ""}`}
          style={{
            background: activeTab === "done" ? "var(--accent-gradient)" : "transparent",
            color: activeTab === "done" ? "#fff" : "var(--text-secondary)",
          }}
          onClick={() => setActiveTab("done")}
        >
          {t.remDoneTab} ({doneReminders.length})
        </button>
      </div>

      {/* Add Form */}
      {isAdding && (
        <form onSubmit={handleAdd} className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <h3 style={{ fontSize: "1rem" }}>{t.remAdd}</h3>
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              Xatırlatma Mətni
            </label>
            <input
              type="text"
              placeholder={t.remTextPlaceholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                {t.remDueLabel}
              </label>
              <input
                type="datetime-local"
                value={dueStr}
                onChange={(e) => setDueStr(e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                Təkrar
              </label>
              <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
                <option value="">Təkrarlanmır</option>
                <option value="daily">Hər gün</option>
                <option value="weekly">Hər həftə</option>
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
            <button type="submit" className="btn-primary">
              Saxla
            </button>
            <button type="button" className="btn-secondary" onClick={() => setIsAdding(false)}>
              Ləğv et
            </button>
          </div>
        </form>
      )}

      {/* List */}
      {displayed.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <Bell size={40} color="var(--text-muted)" style={{ margin: "0 auto 12px" }} />
          <h3>
            {activeTab === "active" ? "Aktiv xatırlatma yoxdur" : "Tamamlanmış xatırlatma yoxdur"}
          </h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "4px" }}>
            {activeTab === "active"
              ? "Yeni xatırlatma əlavə edin və ya AI-yə 'sabah saat 9-da xatırlat' deyin."
              : "Görülən işlər burada arxivlənir."}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {displayed.map((rem) => {
            const timeTarget = rem.snooze || rem.due;
            const isOverdue = timeTarget ? timeTarget < Date.now() && rem.done === 0 : false;

            return (
              <div
                key={rem.id}
                className="card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 18px",
                  borderColor: isOverdue ? "rgba(239, 68, 68, 0.4)" : "var(--border-color)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1 }}>
                  <button
                    className="btn-icon"
                    style={{ width: "32px", height: "32px", border: "none", background: "transparent" }}
                    onClick={() => handleComplete(rem.id)}
                  >
                    {rem.done === 1 ? (
                      <CheckCircle2 size={20} color="#10b981" />
                    ) : (
                      <Circle size={20} color={isOverdue ? "#ef4444" : "var(--text-muted)"} />
                    )}
                  </button>

                  <div>
                    <div
                      style={{
                        fontSize: "0.98rem",
                        fontWeight: 600,
                        textDecoration: rem.done === 1 ? "line-through" : "none",
                        color: rem.done === 1 ? "var(--text-muted)" : "var(--text-primary)",
                      }}
                    >
                      {rem.text}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        fontSize: "0.78rem",
                        color: isOverdue ? "#ef4444" : "var(--text-muted)",
                        marginTop: "4px",
                      }}
                    >
                      {timeTarget && (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <Clock size={12} />
                          {new Date(timeTarget).toLocaleString("az-AZ")}
                        </span>
                      )}
                      {rem.snooze && (
                        <span style={{ color: "#f59e0b", fontWeight: 600 }}>Ertələnib (+10 dəq)</span>
                      )}
                      {rem.repeat && <span>• {rem.repeat}</span>}
                      <span title={rem.sync_status === 0 ? "Serverlə sinxron" : "Sinxron gözləyir"}>
                        {rem.sync_status === 0 ? (
                          <Cloud size={13} color="#10b981" />
                        ) : (
                          <CloudOff size={13} color="#f59e0b" />
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  {rem.done === 0 && (
                    <button
                      className="btn-secondary"
                      style={{ fontSize: "0.78rem", padding: "6px 10px" }}
                      onClick={() => handleSnooze(rem.id)}
                      title="10 dəqiqə sonraya ertələ"
                    >
                      {t.remSnooze}
                    </button>
                  )}
                  <button
                    className="btn-icon"
                    style={{ width: "32px", height: "32px", color: "var(--danger)" }}
                    onClick={() => handleDelete(rem.id)}
                    title="Sil"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
