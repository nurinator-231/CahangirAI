import React, { useState, useEffect } from "react";
import { RefreshCw, Sun, Moon, Globe } from "lucide-react";
import { ActiveView } from "../types";
import { translations, Language } from "../services/i18n";

interface HeaderProps {
  activeView: ActiveView;
  lang: Language;
  setLang: (lang: Language) => void;
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  onSync: () => void;
  isSyncing: boolean;
  lastSyncTime: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeView,
  lang,
  setLang,
  theme,
  setTheme,
  onSync,
  isSyncing,
  lastSyncTime,
}) => {
  const t = translations[lang];
  const [timeStr, setTimeStr] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setTimeStr(
        now.toLocaleTimeString(lang === "az" ? "az-AZ" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
        })
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, [lang]);

  const viewTitles: Record<ActiveView, { title: string; subtitle: string }> = {
    dashboard: { title: t.dashTitle, subtitle: t.dashSubtitle },
    ai: { title: t.aiTitle, subtitle: t.aiSubtitle },
    connect: { title: t.connectTitle, subtitle: t.connectSubtitle },
    "file-transfer": { title: t.ftTitle, subtitle: t.ftSubtitle },
    clipboard: { title: t.clipTitle, subtitle: t.clipSubtitle },
    devices: { title: t.devTitle, subtitle: t.devSubtitle },
    memories: { title: t.memTitle, subtitle: t.memSubtitle },
    projects: { title: t.prjTitle, subtitle: t.prjSubtitle },
    reminders: { title: t.remTitle, subtitle: t.remSubtitle },
    "system-monitor": { title: t.sysTitle, subtitle: t.sysSubtitle },
    settings: { title: t.settTitle, subtitle: t.settSubtitle },
  };

  const { title, subtitle } = viewTitles[activeView];

  return (
    <header className="header-bar">
      <div className="header-left">
        <h1>{title}</h1>
        <span>{subtitle}</span>
      </div>

      <div className="header-right">
        {/* Clock */}
        <span style={{ fontSize: "0.95rem", fontWeight: 600, marginRight: "8px" }}>
          {timeStr}
        </span>

        {/* Sync Button */}
        <button
          className="btn-primary"
          onClick={onSync}
          disabled={isSyncing}
          title={
            lastSyncTime > 0
              ? `Son sinx: ${new Date(lastSyncTime).toLocaleTimeString()}`
              : t.syncNow
          }
        >
          <RefreshCw size={15} className={isSyncing ? "spin-animation" : ""} />
          <span>{isSyncing ? t.syncing : t.syncNow}</span>
        </button>

        {/* Language switch */}
        <button
          className="btn-icon"
          onClick={() => setLang(lang === "az" ? "en" : "az")}
          title="Dili dəyiş / Change language"
        >
          <Globe size={18} />
        </button>

        {/* Theme toggle */}
        <button
          className="btn-icon"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Temanı dəyiş"
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
};
