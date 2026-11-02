import React from "react";
import {
  LayoutDashboard,
  Sparkles,
  Radio,
  ArrowDownUp,
  ClipboardCheck,
  Smartphone,
  BrainCircuit,
  FolderKanban,
  Bell,
  Activity,
  Settings,
} from "lucide-react";
import { ActiveView } from "../types";
import { translations, Language } from "../services/i18n";

interface SidebarProps {
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  lang: Language;
  serverOnline: boolean;
  activeRemindersCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  setActiveView,
  lang,
  serverOnline,
  activeRemindersCount,
}) => {
  const t = translations[lang];

  const navItems = [
    { id: "dashboard" as ActiveView, label: t.navDashboard, icon: LayoutDashboard },
    { id: "ai" as ActiveView, label: t.navAi, icon: Sparkles },
    { id: "connect" as ActiveView, label: t.navConnect, icon: Radio },
    { id: "file-transfer" as ActiveView, label: t.navFileTransfer, icon: ArrowDownUp },
    { id: "clipboard" as ActiveView, label: t.navClipboard, icon: ClipboardCheck },
    { id: "devices" as ActiveView, label: t.navDevices, icon: Smartphone },
    { id: "memories" as ActiveView, label: t.navMemories, icon: BrainCircuit },
    { id: "projects" as ActiveView, label: t.navProjects, icon: FolderKanban },
    {
      id: "reminders" as ActiveView,
      label: t.navReminders,
      icon: Bell,
      badge: activeRemindersCount > 0 ? activeRemindersCount : undefined,
    },
    { id: "system-monitor" as ActiveView, label: t.navSystemMonitor, icon: Activity },
    { id: "settings" as ActiveView, label: t.navSettings, icon: Settings },
  ];

  return (
    <aside className="sidebar">
      <div className="brand-section">
        <div className="brand-logo">
          <svg viewBox="0 0 48 48" width="24" height="24">
            <path
              d="M35.5 14.5A15.5 15.5 0 1 0 35.5 33.5"
              fill="none"
              stroke="#ffffff"
              strokeWidth="6"
              strokeLinecap="round"
            />
            <circle cx="37" cy="24" r="3" fill="#ffffff" />
          </svg>
        </div>
        <div className="brand-title">
          <h2>{t.appTitle}</h2>
          <p>{t.tagline}</p>
        </div>
      </div>

      <nav className="nav-list">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeView === item.id;
          return (
            <button
              key={item.id}
              className={`nav-item ${isActive ? "active" : ""}`}
              onClick={() => setActiveView(item.id)}
            >
              <Icon size={18} />
              <span>{item.label}</span>
              {item.badge !== undefined && <span className="badge">{item.badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="status-pill">
          <span className={`status-dot ${serverOnline ? "online" : ""}`} />
          <span>{serverOnline ? t.onlineMode : t.offlineMode}</span>
        </div>
      </div>
    </aside>
  );
};
