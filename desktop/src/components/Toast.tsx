import React from "react";
import { CheckCircle2, AlertTriangle, AlertCircle, Info } from "lucide-react";
import { ToastMessage } from "../types";

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export const Toast: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => {
        const getIcon = () => {
          switch (t.type) {
            case "success":
              return <CheckCircle2 size={18} color="#10b981" />;
            case "warning":
              return <AlertTriangle size={18} color="#f59e0b" />;
            case "error":
              return <AlertCircle size={18} color="#ef4444" />;
            default:
              return <Info size={18} color="#38bdf8" />;
          }
        };

        return (
          <div key={t.id} className="toast" onClick={() => onDismiss(t.id)} style={{ cursor: "pointer" }}>
            {getIcon()}
            <span>{t.text}</span>
          </div>
        );
      })}
    </div>
  );
};
