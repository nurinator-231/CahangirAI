import React, { useState, useRef, useEffect } from "react";
import { Send, Trash2, Copy, Check, Sparkles } from "lucide-react";
import { ChatMessage } from "../types";
import { AIProvider } from "../services/ai";
import { api } from "../services/api";
import { translations, Language } from "../services/i18n";

interface AiChatProps {
  lang: Language;
  onActionTriggered?: () => void;
}

export const AiChatView: React.FC<AiChatProps> = ({ lang, onActionTriggered }) => {
  const t = translations[lang];
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const sessionId = "desktop_main";

  useEffect(() => {
    loadChat();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const loadChat = async () => {
    try {
      const history = await api.getChatHistory(sessionId);
      if (history.length === 0) {
        setMessages([
          {
            id: "welcome",
            session_id: sessionId,
            role: "assistant",
            content:
              lang === "az"
                ? "Salam! Mən **Cahangir AI** şəxsi köməkçinəm. Sənə xatırlatmalar yaratmaqda, qeydlər saxlamaqda, fayllarını idarə etməkdə və suallarını cavablandırmaqda kömək edə bilərəm. Nə etmək istəyirsən?"
                : "Hello! I am **Cahangir AI**, your personal desktop assistant. How can I help you today?",
            timestamp: Date.now(),
          },
        ]);
      } else {
        setMessages(history);
      }
    } catch (e) {
      console.error("Failed to load chat history", e);
    }
  };

  const handleSend = async (overrideText?: string) => {
    const textToSend = overrideText || input;
    if (!textToSend.trim() || isLoading) return;

    const userMsg: ChatMessage = {
      id: `usr_${Date.now()}`,
      session_id: sessionId,
      role: "user",
      content: textToSend.trim(),
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      await api.saveChatMessage(userMsg);

      const aiRes = await AIProvider.processMessage(userMsg.content);

      const assistantMsg: ChatMessage = {
        id: `ast_${Date.now()}`,
        session_id: sessionId,
        role: "assistant",
        content: aiRes.text,
        timestamp: Date.now(),
      };

      setMessages((prev) => [...prev, assistantMsg]);
      await api.saveChatMessage(assistantMsg);

      if (aiRes.actionTaken && onActionTriggered) {
        onActionTriggered();
      }
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          session_id: sessionId,
          role: "assistant",
          content: `Xəta baş verdi: ${e?.message || e}`,
          timestamp: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = async () => {
    if (window.confirm("Bütün söhbət tarixçəsini silmək istəyirsiniz?")) {
      try {
        await api.deleteChatSession(sessionId);
        setMessages([]);
        loadChat();
      } catch (e) {
        console.error("Failed to clear chat", e);
      }
    }
  };

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const renderContent = (content: string, msgId: string) => {
    // Check for code blocks
    const parts = content.split(/(```[\s\S]*?```)/g);
    return parts.map((part, idx) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        const lines = part.slice(3, -3).trim().split("\n");
        const lang = lines[0].trim();
        const code = (lang ? lines.slice(1) : lines).join("\n");
        const blockId = `${msgId}_code_${idx}`;

        return (
          <div key={idx} style={{ position: "relative", margin: "10px 0" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                background: "#0f172a",
                padding: "4px 12px",
                borderTopLeftRadius: "8px",
                borderTopRightRadius: "8px",
                fontSize: "0.75rem",
                color: "var(--text-muted)",
              }}
            >
              <span>{lang || "code"}</span>
              <button
                className="btn-icon"
                style={{ width: "24px", height: "24px" }}
                onClick={() => handleCopy(code, blockId)}
                title={t.aiCopyCode}
              >
                {copiedId === blockId ? <Check size={14} color="#10b981" /> : <Copy size={14} />}
              </button>
            </div>
            <pre style={{ margin: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
              <code>{code}</code>
            </pre>
          </div>
        );
      }

      // Simple markdown bold & quote parser
      const formatted = part
        .split("\n")
        .map((line, lIdx) => {
          if (line.startsWith("> ")) {
            return (
              <blockquote
                key={lIdx}
                style={{
                  borderLeft: "3px solid var(--accent-blue)",
                  paddingLeft: "10px",
                  margin: "6px 0",
                  color: "var(--text-secondary)",
                }}
              >
                {line.slice(2)}
              </blockquote>
            );
          }
          return <span key={lIdx}>{line}<br /></span>;
        });

      return <span key={idx}>{formatted}</span>;
    });
  };

  return (
    <div className="content-view" style={{ height: "100%", paddingBottom: "12px" }}>
      <div className="chat-container">
        {/* Top actions */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Sparkles size={18} color="#38bdf8" />
            <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>Cahangir AI Engine</span>
          </div>
          <button className="btn-secondary" onClick={handleClear} title={t.aiClear}>
            <Trash2 size={15} />
            <span>{t.aiClear}</span>
          </button>
        </div>

        {/* Message history */}
        <div className="chat-history">
          {messages.map((msg) => (
            <div key={msg.id} className={`chat-msg ${msg.role}`}>
              <div className="chat-avatar">{msg.role === "assistant" ? "C" : "U"}</div>
              <div className="chat-bubble">{renderContent(msg.content, msg.id)}</div>
            </div>
          ))}
          {isLoading && (
            <div className="chat-msg assistant">
              <div className="chat-avatar">C</div>
              <div className="chat-bubble" style={{ fontStyle: "italic", color: "var(--text-muted)" }}>
                Cahangir düşünür...
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Quick Suggestion Chips */}
        <div className="chat-chips">
          <button
            className="chip-btn"
            onClick={() => handleSend("sabah saat 9-da vacib toplantı xatırlat")}
          >
            ⏰ Sabah xatırlat
          </button>
          <button
            className="chip-btn"
            onClick={() => handleSend("30 dəqiqə sonra dincəlməyi xatırlat")}
          >
            ⏳ 30 dəq. sonra
          </button>
          <button className="chip-btn" onClick={() => handleSend("fokus")}>
            🎯 25 dəq. fokus
          </button>
          <button
            className="chip-btn"
            onClick={() => handleSend("yadda saxla: layihənin son təhvil tarixi 20 noyabrdır")}
          >
            🧠 Yadda saxla
          </button>
          <button className="chip-btn" onClick={() => handleSend("kömək")}>
            ❓ Nə edə bilirsən
          </button>
        </div>

        {/* Input Bar */}
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="text"
            placeholder={t.aiPlaceholder}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={isLoading}
          />
          <button
            className="btn-primary"
            style={{ padding: "10px 18px", flexShrink: 0 }}
            onClick={() => handleSend()}
            disabled={isLoading || !input.trim()}
          >
            <Send size={16} />
            <span>{t.aiSend}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
