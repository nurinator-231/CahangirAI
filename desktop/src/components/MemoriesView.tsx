import React, { useState } from "react";
import { BrainCircuit, Search, Plus, Trash2, Cloud, CloudOff } from "lucide-react";
import { MemoryItem } from "../types";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";

interface MemoriesProps {
  lang: Language;
  memories: MemoryItem[];
  onRefresh: () => void;
}

export const MemoriesView: React.FC<MemoriesProps> = ({ lang, memories, onRefresh }) => {
  const t = translations[lang];
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [newText, setNewText] = useState("");
  const [newCat, setNewCat] = useState("general");
  const [isAdding, setIsAdding] = useState(false);

  const filtered = memories.filter((m) => {
    if (m.deleted === 1) return false;
    const matchCat = category === "all" || m.category === category;
    const matchSearch =
      m.fact_text.toLowerCase().includes(search.toLowerCase()) ||
      m.category.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;

    try {
      await api.saveMemory({
        fact_text: newText.trim(),
        category: newCat,
        confidence: 1.0,
        source: "desktop_ui",
      });
      setNewText("");
      setIsAdding(false);
      onRefresh();
    } catch (e) {
      console.error("Failed to add memory", e);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("Bu faktı silmək istədiyinizdən əminsiniz?")) {
      try {
        await api.deleteMemory(id);
        onRefresh();
      } catch (e) {
        console.error("Failed to delete memory", e);
      }
    }
  };

  return (
    <div className="content-view">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.memTitle}</h2>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{t.memSubtitle}</p>
        </div>
        <button className="btn-primary" onClick={() => setIsAdding(!isAdding)}>
          <Plus size={16} />
          <span>{t.memAddFact}</span>
        </button>
      </div>

      {/* Add Form */}
      {isAdding && (
        <form onSubmit={handleAdd} className="card" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <h3 style={{ fontSize: "1rem" }}>{t.memAddFact}</h3>
          <div>
            <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
              {t.memFactText}
            </label>
            <input
              type="text"
              placeholder="Məs: Qəhvəni şəkərsiz sevirəm, ad günü 15 maydır..."
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              required
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
            <div>
              <label style={{ fontSize: "0.82rem", color: "var(--text-muted)", display: "block", marginBottom: "6px" }}>
                {t.memCategory}
              </label>
              <select value={newCat} onChange={(e) => setNewCat(e.target.value)}>
                <option value="general">Ümumi (General)</option>
                <option value="personal">Şəxsi (Personal)</option>
                <option value="work">İş (Work)</option>
                <option value="preferences">Tercihlər (Preferences)</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: "10px" }}>
              <button type="submit" className="btn-primary" style={{ flex: 1 }}>
                {t.memSave}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setIsAdding(false)}
              >
                Ləğv et
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Search & Filter */}
      <div style={{ display: "grid", gridTemplateColumns: "3fr 1fr", gap: "12px" }}>
        <div style={{ position: "relative" }}>
          <Search
            size={16}
            style={{
              position: "absolute",
              left: "14px",
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--text-muted)",
            }}
          />
          <input
            type="text"
            style={{ paddingLeft: "38px" }}
            placeholder={t.memSearchPlaceholder}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">Bütün Kateqoriyalar</option>
          <option value="general">Ümumi</option>
          <option value="personal">Şəxsi</option>
          <option value="work">İş</option>
          <option value="preferences">Tercihlər</option>
        </select>
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <BrainCircuit size={40} color="var(--text-muted)" style={{ margin: "0 auto 12px" }} />
          <h3>Heç bir yaddaş qeydi tapılmadı</h3>
          <p style={{ color: "var(--text-muted)", fontSize: "0.85rem", marginTop: "4px" }}>
            Yuxarıdakı düymə ilə və ya söhbət pəncərəsində "yadda saxla: ..." yazaraq yeni fakt əlavə
            edin.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filtered.map((item) => (
            <div
              key={item.id}
              className="card"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 18px",
              }}
            >
              <div style={{ flex: 1, marginRight: "16px" }}>
                <div style={{ fontSize: "0.98rem", fontWeight: 500, lineHeight: 1.4 }}>
                  {item.fact_text}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontSize: "0.75rem",
                    color: "var(--text-muted)",
                    marginTop: "6px",
                  }}
                >
                  <span
                    style={{
                      background: "rgba(56, 189, 248, 0.15)",
                      color: "var(--accent-blue)",
                      padding: "2px 6px",
                      borderRadius: "4px",
                      textTransform: "uppercase",
                      fontWeight: 600,
                    }}
                  >
                    {item.category}
                  </span>
                  <span>{new Date(item.created_at).toLocaleDateString("az-AZ")}</span>
                  <span
                    title={
                      item.sync_status === 0
                        ? "Serverlə sinxronlaşdırılıb"
                        : "Sinxronizasiya gözlənilir"
                    }
                    style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}
                  >
                    {item.sync_status === 0 ? (
                      <Cloud size={14} color="#10b981" />
                    ) : (
                      <CloudOff size={14} color="#f59e0b" />
                    )}
                  </span>
                </div>
              </div>
              <button
                className="btn-icon"
                style={{ color: "var(--danger)" }}
                onClick={() => handleDelete(item.id)}
                title="Sil"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
