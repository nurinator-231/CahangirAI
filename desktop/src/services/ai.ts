import { api } from "./api";

export interface AIResponse {
  text: string;
  actionTaken?: string;
  isStructuredAction?: boolean;
}

export class AIProvider {
  /**
   * Processes natural language input in Azerbaijani and English.
   * If an action like reminder, memory, or timer is detected, it executes it directly into local SQLite!
   */
  public static async processMessage(
    userInput: string,
    endpointUrl?: string,
    apiKey?: string
  ): Promise<AIResponse> {
    const raw = userInput.trim();
    const lower = raw.toLowerCase();

    // 1. Check for quick math
    const mathMatch = lower.match(/^hesabla:\s*([0-9\+\-\*\/\(\)\.\s]+)$/);
    if (mathMatch) {
      try {
        // Safe evaluation of simple math
        const expr = mathMatch[1].replace(/[^0-9\+\-\*\/\(\)\.]/g, "");
        const res = Function(`'use strict'; return (${expr})`)();
        return {
          text: `Hesablamanın nəticəsi: **${res}**`,
          isStructuredAction: true,
        };
      } catch {
        return { text: "Riyazi ifadə düzgün deyil." };
      }
    }

    // 2. Reminder patterns (məs: "sabah saat 9-da zəng xatırlat", "30 dəqiqə sonra iclas xatırlat")
    if (lower.includes("xatırlat") || lower.includes("remind")) {
      let dueTime: number = Date.now() + 60 * 60 * 1000; // default 1 hour
      let reminderText = raw;

      if (lower.includes("30 dəqiqə") || lower.includes("30 dəq")) {
        dueTime = Date.now() + 30 * 60 * 1000;
        reminderText = raw.replace(/30\s*dəqiqə.*xatırlat/i, "").trim() || "Xatırlatma";
      } else if (lower.includes("10 dəqiqə") || lower.includes("10 dəq")) {
        dueTime = Date.now() + 10 * 60 * 1000;
        reminderText = raw.replace(/10\s*dəqiqə.*xatırlat/i, "").trim() || "Xatırlatma";
      } else if (lower.includes("sabah")) {
        dueTime = Date.now() + 24 * 60 * 60 * 1000;
        reminderText = raw.replace(/sabah.*xatırlat/i, "").trim() || "Sabahkı tapşırıq";
      }

      await api.saveReminder({
        text: reminderText.replace(/^xatırlat:?/i, "").trim() || raw,
        due: dueTime,
        done: 0,
        timer: 0,
        sync_status: 1,
      });

      return {
        text: `✓ Xatırlatma yaradıldı və yaddaşa yazıldı:\n> **${reminderText}**\n\nVaxt: *${new Date(
          dueTime
        ).toLocaleString("az-AZ")}*`,
        actionTaken: "reminder_created",
        isStructuredAction: true,
      };
    }

    // 3. Memory patterns (məs: "yadda saxla: anamın ad günü 15 maydır")
    if (lower.startsWith("yadda saxla") || lower.startsWith("qeyd et") || lower.startsWith("remember")) {
      const fact = raw
        .replace(/^(yadda saxla|qeyd et|remember):?\s*/i, "")
        .trim();

      if (fact.length > 0) {
        await api.saveMemory({
          fact_text: fact,
          category: "general",
          confidence: 1.0,
          source: "chat",
          sync_status: 1,
        });

        return {
          text: `🧠 Yadda saxladım:\n> "${fact}"\n\nBu məlumat Debian mərkəzi yaddaşı ilə də sinxronlaşdırılacaq.`,
          actionTaken: "memory_saved",
          isStructuredAction: true,
        };
      }
    }

    // 4. Focus mode (məs: "fokus", "pomodoro")
    if (lower.includes("fokus") || lower.includes("focus")) {
      const dueTime = Date.now() + 25 * 60 * 1000;
      await api.saveReminder({
        text: "🎯 25 dəqiqəlik fokus müddəti bitdi!",
        due: dueTime,
        done: 0,
        timer: 1,
        sync_status: 1,
      });

      return {
        text: "🎯 **Fokus rejimi başladı!** (25 dəqiqə)\n\nFikrinizi əsas işə yönəldin. Vaxt tamam olanda bildirişlə xəbərdarlıq edəcəyəm.",
        actionTaken: "focus_timer",
        isStructuredAction: true,
      };
    }

    // 5. Help / Status
    if (lower === "kömək" || lower === "help" || lower.includes("nə edə bilirsən")) {
      return {
        text: `Salam! Mən **Cahangir** — sənin şəxsi masaüstü köməkçinəm.

Mən nə edə bilərəm?
- **🔔 Xatırlatma və Taymer:** \`"sabah saat 10-da iclas xatırlat"\`, \`"fokus"\`, \`"10 dəqiqəlik taymer"\`
- **🧠 Yaddaş Saxlamaq:** \`"yadda saxla: qapı kodu 4821-dir"\`
- **📲 Fayl Transferi:** P2P menyusundan Android telefonunla böyük faylları ultra-sürətlə ötürmək
- **📋 Pano (Clipboard):** Kompüterdə kopyalanan mətni avtomatik telefona göndərmək
- **📊 Sistem və Debian İzləmə:** Kompüterin və Debian Atom D525 serverinin real resurslarına baxmaq
- **🤖 Kod və Analiz:** İstənilən proqramlaşdırma dilində kod yazmaq və sualları cavablandırmaq.`,
      };
    }

    // 6. If OpenAI-compatible endpoint is configured, query LLM
    if (endpointUrl && endpointUrl.trim().length > 0) {
      try {
        const response = await fetch(endpointUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: "default",
            messages: [
              {
                role: "system",
                content:
                  "You are Cahangir, a helpful, intelligent personal AI assistant running on Windows Desktop in a personal mesh network. Respond naturally, accurately, and assist with coding, tasks, reminders, and knowledge.",
              },
              { role: "user", content: raw },
            ],
            temperature: 0.7,
          }),
        });

        if (response.ok) {
          const json = await response.json();
          const content =
            json?.choices?.[0]?.message?.content ||
            json?.response ||
            "Modeldən boş cavab gəldi.";
          return { text: content };
        }
      } catch (e: any) {
        console.warn("External LLM query failed, falling back to local brain", e);
      }
    }

    // Default intelligent local response
    return {
      text: `Sizin bildirişinizi qəbul etdim: **"${raw}"**.\n\nƏgər xatırlatma yaratmaq istəyirsinizsə \`"xatırlat: ..."\`, yaddaşa yazmaq istəyirsinizsə \`"yadda saxla: ..."\` yazın. Ətraflı dil modeli üçün Ayarlar bölməsindən yerli model endpoint-ini (Ollama / LM Studio) aktivləşdirə bilərsiniz.`,
    };
  }
}
