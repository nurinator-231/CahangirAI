// Typed access to the shared planning engine (shared/planner/planner.js), the same code
// the Android app runs, so plans are identical on both devices.
// @ts-ignore - plain JS module shared with the Android WebView
import * as PlannerModule from "../../../shared/planner/planner.js";
import { EventItem, PlanBlock, ReminderItem, TaskItem } from "../types";
import { api, errText } from "./api";

export interface ParsedTask {
  title: string;
  description: string;
  category: string;
  priority: "low" | "medium" | "high" | "urgent";
  deadline: number | null;
  estimated_minutes: number | null;
  source_text?: string;
}
export interface ParsedEvent {
  title: string;
  start_at: number;
  end_at: number | null;
  duration_minutes: number | null;
  recurrence: any;
  source_text?: string;
}
export interface ParseResult {
  tasks: ParsedTask[];
  events: ParsedEvent[];
  questions: { kind: string; item: string; index: number; text: string }[];
  notes: string[];
  source: string; // "rules" | "ai:<provider>"
}
export interface Alternative {
  type: "extend_day" | "move_lower_priority" | "allow_late" | "reduce_estimate";
  message: string;
  extend_minutes?: number;
  block_ids?: string[];
}
export interface Conflict {
  type: string;
  task_id?: string;
  event_id?: string;
  block_id?: string;
  message: string;
  short_minutes?: number;
  alternatives: Alternative[];
}
export interface Plan {
  add: PlanBlock[];
  remove: string[];
  keep: PlanBlock[];
  conflicts: Conflict[];
  unscheduled: { task_id: string; reason: string; message: string; alternatives?: Alternative[] }[];
  explanations: Record<string, string>;
}
export interface AgendaItem {
  type: "event" | "block" | "deadline" | "reminder";
  start: number;
  end: number;
  title: string;
  id: string;
  task_id?: string;
  status?: string;
  locked?: boolean;
  reason?: string;
  done?: boolean;
  priority?: string;
  unknown_length?: boolean;
  recurring?: boolean;
}

export const Planner: any = (window as any).CahangirPlanner || (PlannerModule as any).default || PlannerModule;

export function prefsFrom(cfg: { planner_day_start?: string; planner_day_end?: string }) {
  return { dayStart: cfg.planner_day_start || "08:00", dayEnd: cfg.planner_day_end || "22:00" };
}

function localIso(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Understands a natural-language request. Uses the server's free-tier AI router when
 * `useAi` is on and available; otherwise (or on any AI failure) the built-in rules.
 * Both paths only keep deadlines/times that the user actually stated.
 */
export async function understand(text: string, useAi: boolean, lang: "az" | "en"): Promise<ParseResult & { aiError?: string }> {
  const rules = Planner.parse(text, Date.now(), { lang });
  if (!useAi) return { ...rules, source: "rules" };
  try {
    const now = new Date();
    const res = await api.aiParse(text, localIso(now), -now.getTimezoneOffset(), now.toLocaleDateString("en-US", { weekday: "long" }));
    if (res.status !== 200) {
      const msg = res.body?.detail?.message || res.body?.detail || `HTTP ${res.status}`;
      return { ...rules, source: "rules", aiError: typeof msg === "string" ? msg : JSON.stringify(msg) };
    }
    const b = res.body;
    const events: ParsedEvent[] = (b.events || []).map((e: any) => ({ ...e, recurrence: e.recurrence || null }));
    const questions = (b.questions || []).map((q: string, i: number) => ({ kind: "ai", item: "ai", index: i, text: q }));
    return { tasks: b.tasks || [], events, questions, notes: [], source: `ai:${b.provider}` };
  } catch (e) {
    return { ...rules, source: "rules", aiError: errText(e) };
  }
}

export function schedule(tasks: TaskItem[], events: EventItem[], blocks: PlanBlock[], prefs: any, lang: string, opts: { allowLate?: string[]; extendMinutes?: number; release?: string[]; boost?: string[] } = {}): Plan {
  return Planner.schedule({ tasks, events, blocks, now: Date.now(), prefs, lang, allowLate: opts.allowLate || [], extendMinutes: opts.extendMinutes || 0, release: opts.release || [], boost: opts.boost || [] });
}

/** Writes an accepted plan: new blocks, removed blocks, and their reminders. */
export async function applyPlan(plan: Plan, tasks: TaskItem[], lang: string, prefs: any) {
  const byId: Record<string, TaskItem> = Object.fromEntries(tasks.map((t) => [t.id, t]));
  for (const id of plan.remove) {
    await api.remove("plan_blocks", id);
    await api.remove("reminders", "rem_blk_" + id.replace(/[^A-Za-z0-9_-]/g, ""));
  }
  if (plan.add.length) await api.saveMany("plan_blocks", plan.add);
  const reminders: Partial<ReminderItem>[] = [];
  for (const b of plan.add) reminders.push(Planner.blockReminder(b, byId[b.task_id], prefs, lang));
  const touched = new Set(plan.add.map((b) => b.task_id));
  for (const id of touched) if (byId[id]) reminders.push(...Planner.deadlineReminders(byId[id], Date.now(), prefs, lang));
  if (reminders.length) await api.saveMany("reminders", reminders);
}

export const fmtWhen = (ms: number, lang: string) => Planner.fmtWhen(ms, lang);
export const fmtMinutes = (m: number, lang: string) => Planner.fmtMinutes(m, lang);
export const fmtClock = (ms: number) => Planner.fmtClock(ms);
