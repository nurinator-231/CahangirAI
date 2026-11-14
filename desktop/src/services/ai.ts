import { api } from "./api";
import { Planner } from "./planner";

export interface AIResponse {
  text: string;
  actionTaken?: string;
  isStructuredAction?: boolean;
}

/**
 * Chat assistant. Deterministic commands (reminders, memory, focus timer, math, help)
 * run locally and offline. Everything else goes to the Debian server's AI router, which
 * only uses explicitly enabled free-tier providers. If no provider is available the
 * user is told so plainly — no paid fallback, no invented answer.
 */
export class AIProvider {
  public static async processMessage(userInput: string, history: { role: string; content: string }[] = []): Promise<AIResponse> {
    const raw = userInput.trim();
    const lower = raw.toLocaleLowerCase("az");
    const lang: "az" | "en" = /[əıöüşçğ]|xatırlat|yadda|hesabla|fokus|kömək/.test(lower) ? "az" : "en";

    // 1. Arithmetic (safe parser, no eval)
    const mathMatch = lower.match(/^(?:hesabla|calc|calculate)[:\s]+([0-9+\-*/().,\s^]+)$/);
    if (mathMatch) {
      const v = safeMath(mathMatch[1].replace(/,/g, "."));
      return { text: v === null ? (lang === "en" ? "That expression is not valid." : "Riyazi ifadə düzgün deyil.") : `= **${v}**`, isStructuredAction: true };
    }

    // 2. Reminder: only created when the user states a time; otherwise ask.
    if (/xatırlat|remind me|reminder|alarm|oyat/.test(lower)) {
      const now = Date.now();
      const date = Planner.findDate(raw, now);
      const time = Planner.findTime(raw);
      const dur = /(?:in|sonra|after)/.test(lower) ? Planner.findDuration(raw) : null;
      let due: number | null = null;
      if (dur && /\b(in|after)\b|sonra/.test(lower)) due = now + dur.minutes * 60000;
      else if (time) {
        const base = date ? date.day : Planner.sod(now);
        const d = new Date(base);
        d.setHours(time.h, time.m, 0, 0);
        due = d.getTime();
        if (!date && due <= now) due += 86400000;
      } else if (date) {
        return { text: lang === "en" ? "At what time should I remind you?" : "Saat neçədə xatırladım?" };
      }
      if (due === null) return { text: lang === "en" ? "When should I remind you? (e.g. “remind me tomorrow at 9 to call the bank”)" : "Nə vaxt xatırladım? (məs: “sabah saat 9-da banka zəng etməyi xatırlat”)" };
      const spans = [date?.text, time?.text, dur?.text].filter(Boolean) as string[];
      let title = raw;
      for (const s of spans) title = title.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
      title = title.replace(/xatırlat(?:ma)?(?:ğı)?|remind me (?:to )?|reminder:?|\bto\b(?=\s*$)/gi, " ").replace(/\s+/g, " ").replace(/^[\s,:-]+|[\s,:-]+$/g, "") || (lang === "en" ? "Reminder" : "Xatırlatma");
      await api.saveReminder({ text: title, due, done: 0, timer: 0, kind: "custom" });
      return { text: `🔔 ${title} — ${Planner.fmtWhen(due, lang)}`, actionTaken: "reminder_created", isStructuredAction: true };
    }

    // 3. Memory
    const mem = raw.match(/^(?:yadda saxla|qeyd et|remember)\s*:?\s*(.+)$/i);
    if (mem) {
      await api.saveMemory({ fact_text: mem[1].trim(), category: "general", confidence: 1.0, source: "chat" });
      return { text: lang === "en" ? `🧠 Saved: “${mem[1].trim()}”` : `🧠 Yadda saxladım: “${mem[1].trim()}”`, actionTaken: "memory_saved", isStructuredAction: true };
    }

    // 4. Focus timer
    if (/^(fokus|focus|pomodoro)\b/.test(lower)) {
      const due = Date.now() + 25 * 60 * 1000;
      await api.saveReminder({ text: lang === "en" ? "Focus session finished — take a break" : "Fokus bitdi — fasilə et", due, done: 0, timer: 1, kind: "timer" });
      return { text: lang === "en" ? "🎯 Focus started (25 min)." : "🎯 Fokus başladı (25 dəqiqə).", actionTaken: "focus_timer", isStructuredAction: true };
    }

    // 5. Help
    if (/^(kömək|help)$|nə edə bilirsən|what can you do/.test(lower)) {
      return {
        text: lang === "en"
          ? "I can: plan tasks (Planner tab: “assignment due Friday, 2 hours”), set reminders (“remind me tomorrow at 9 to call the bank”), remember facts (“remember: door code 4821”), start a focus timer (“focus”), calculate (“calc 12*7”). Other questions go to the free AI providers on your Debian server when available."
          : "Bacardıqlarım: tapşırıqları planlamaq (Planlayıcı: “cüməyə qədər tapşırıq, 2 saat”), xatırlatma (“sabah saat 9-da banka zəng etməyi xatırlat”), yadda saxlamaq (“yadda saxla: qapı kodu 4821”), fokus taymeri (“fokus”), hesablamaq (“hesabla 12*7”). Digər suallar Debian serverdəki pulsuz AI provayderlərinə göndərilir.",
      };
    }

    // 6. Free-tier AI via the Debian router
    try {
      const msgs = history.filter((m) => m.role === "user" || m.role === "assistant").slice(-8).map((m) => ({ role: m.role, content: m.content }));
      msgs.push({ role: "user", content: raw });
      const res = await api.aiChat(msgs);
      if (res.status === 200) return { text: res.body.text + `\n\n_— ${res.body.provider} (${res.body.model})_` };
      const detail = res.body?.detail;
      const why = typeof detail === "string" ? detail : detail?.message || `HTTP ${res.status}`;
      return { text: lang === "en" ? `AI is not available right now (${why}). Built-in commands still work — type “help”.` : `AI hazırda əlçatmazdır (${why}). Daxili əmrlər işləyir — “kömək” yazın.` };
    } catch (e: any) {
      return { text: lang === "en" ? `AI is unavailable offline (${e}). Built-in commands still work — type “help”.` : `Oflayn rejimdə AI əlçatmazdır (${e}). Daxili əmrlər işləyir — “kömək” yazın.` };
    }
  }
}

function safeMath(s: string): number | null {
  const tok = s.match(/\d+(?:\.\d+)?|[-+*/^()]/g);
  if (!tok || tok.join("").length !== s.replace(/\s/g, "").length) return null;
  let p = 0;
  const peek = () => tok[p];
  const prim = (): number => {
    const x = tok[p++];
    if (x === "(") { const v = add(); if (tok[p++] !== ")") throw 0; return v; }
    if (x === "-") return -prim();
    if (x === undefined || isNaN(+x)) throw 0;
    return +x;
  };
  const pow = (): number => { const b = prim(); if (peek() === "^") { p++; return Math.pow(b, pow()); } return b; };
  const mul = (): number => { let v = pow(); while (peek() === "*" || peek() === "/") { const o = tok[p++]; const r = pow(); v = o === "*" ? v * r : v / r; } return v; };
  const add = (): number => { let v = mul(); while (peek() === "+" || peek() === "-") { const o = tok[p++]; const r = mul(); v = o === "+" ? v + r : v - r; } return v; };
  try { const v = add(); if (p !== tok.length || !isFinite(v)) return null; return +v.toFixed(10); } catch { return null; }
}
