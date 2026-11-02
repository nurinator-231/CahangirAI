import React, { useState } from "react";
import { FolderKanban, Plus, Trash2, CheckCircle2, Clock, PauseCircle, Cloud, CloudOff } from "lucide-react";
import { ProjectItem } from "../types";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";

interface ProjectsProps {
  lang: Language;
  projects: ProjectItem[];
  onRefresh: () => void;
}

export const ProjectsView: React.FC<ProjectsProps> = ({ lang, projects, onRefresh }) => {
  const t = translations[lang];
  const [isAdding, setIsAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("active");
  const [notes, setNotes] = useState("");

  const activeProjects = projects.filter((p) => p.deleted === 0);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    try {
      await api.saveProject({
        title: title.trim(),
        status,
        notes: notes.trim(),
      });
      setTitle("");
      setNotes("");
      setIsAdding(false);
      onRefresh();
    } catch (e) {
      console.error("Failed to add project", e);
    }
  };

  const handleToggleStatus = async (p: ProjectItem) => {
    const nextStatus =
      p.status === "active" ? "completed" : p.status === "completed" ? "on_hold" : "active";
    try {
      await api.saveProject({
        ...p,
        status: nextStatus,
        updated_at: Date.now(),
        sync_status: 1,
      });
      onRefresh();
    } catch (e) {
      console.error("Failed to update project status", e);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("Bu layihəni silmək istədiyinizdən əminsiniz?")) {
      try {
        await api.deleteProject(id);
        onRefresh();
      } catch (e) {
        console.error("Failed to delete project", e);
      }
    }
  };

  const getStatusBadge = (s: string) => {
    switch (s) {
      case "completed":
        return (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "4px",
              background: "rgba(16, 185, 129, 0.2)",
              color: "#10b981",
              fontSize: "0.75rem",
              fontWeight: 600,
            }}
          >
            <CheckCircle2 size={12} /> Tamamlandı
          </span>
        );
      case "on_hold":
        return (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "4px",
              background: "rgba(245, 158, 11, 0.2)",
              color: "#f59e0b",
              fontSize: "0.75rem",
              fontWeight: 600,
            }}
          >
            <PauseCircle size={12} /> Gözləmədə
          </span>
        );
      default:
        return (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "3px 8px",
              borderRadius: "4px",
              background: "rgba(56, 189, 248, 0.2)",
              color: "#38bdf8",
              fontSize: "0.75rem",
              fontWeight: 600,
            }}
          >
            <Clock size={12} /> Aktiv
          </span>
        );
    }
  };

  return (
    <div className="content-view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.prjTitle}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t.prjSubtitle}</p>
        </div>
        <button className="btn-primary" onClick={() => setIsAdding(!isAdding)}>
          <Plus size={16} />
          <span>{t.prjAdd}</span>
        </button>
      </div>

      {isAdding && (
        <form onSubmit={handleAdd} className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <h3 style={{ fontSize: "1rem" }}>{t.prjAdd}</h3>
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.prjName}
            </label>
            <input
              type="text"
              placeholder="Məs: Cahangir Windows versiyasını tamamlamaq..."
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                {t.prjStatus}
              </label>
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Aktiv</option>
                <option value="on_hold">Gözləmədə</option>
                <option value="completed">Tamamlandı</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                {t.prjNotes}
              </label>
              <input
                type="text"
                placeholder="Qeydlər və tapşırıq təfərrüatları..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
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

      {activeProjects.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <FolderKanban size={40} color="var(--text-muted)" style={{ margin: "0 auto 12px" }} />
          <h3>Hələlik heç bir layihə yoxdur</h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "4px" }}>
            Yeni layihə və ya tapşırıq əlavə edərək irəliləyişinizi izləyin.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "14px" }}>
          {activeProjects.map((p) => (
            <div
              key={p.id}
              className="card"
              style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                  <h4 style={{ fontSize: "1.05rem", fontWeight: 600 }}>{p.title}</h4>
                  <div style={{ cursor: "pointer" }} onClick={() => handleToggleStatus(p)}>
                    {getStatusBadge(p.status)}
                  </div>
                </div>
                {p.notes && (
                  <p style={{ fontSize: "0.88rem", color: "var(--text-secondary)", marginBottom: "12px", lineHeight: 1.4 }}>
                    {p.notes}
                  </p>
                )}
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  fontSize: "0.75rem",
                  color: "var(--text-muted)",
                  borderTop: "1px solid rgba(255,255,255,0.06)",
                  paddingTop: "10px",
                  marginTop: "10px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>{new Date(p.created_at).toLocaleDateString("az-AZ")}</span>
                  {p.sync_status === 0 ? (
                    <span title="Serverlə sinxronlaşdırılıb"><Cloud size={14} color="#10b981" /></span>
                  ) : (
                    <span title="Sinxronizasiya gözlənilir"><CloudOff size={14} color="#f59e0b" /></span>
                  )}
                </div>
                <button
                  className="btn-icon"
                  style={{ width: "28px", height: "28px", color: "var(--danger)" }}
                  onClick={() => handleDelete(p.id)}
                  title="Sil"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
