import React, { useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, Lock, Pencil, Plus, Sparkles, Trash2, Unlock, Wand2, X } from "lucide-react";
import { AppConfig, EventItem, PlanBlock, Priority, ReminderItem, TaskItem } from "../types";
import { api, errText } from "../services/api";
import { Language } from "../services/i18n";
import { AgendaItem, applyPlan, fmtClock, fmtMinutes, fmtWhen, ParseResult, Plan, Planner, prefsFrom, schedule, understand } from "../services/planner";

interface Props {
  lang: Language;
  config: AppConfig;
  tasks: TaskItem[];
  events: EventItem[];
  blocks: PlanBlock[];
  reminders: ReminderItem[];
  onChanged: () => void;
  toast: (type: "info" | "success" | "warning" | "error", text: string) => void;
}

type Tab = "today" | "week" | "tasks" | "commitments";

const L = {
  az: {
    title: "Planlayıcı", subtitle: "Nə etməli olduğunuzu yazın — Cahangir tapşırıqları, son tarixləri və uyğun vaxtları tapacaq.",
    placeholder: "Məs: Cüməyə qədər proqramlaşdırma tapşırığım var, təxminən 2 saat. Sabah saat 10-da ingilis dili dərsim var.",
    understand: "Anla", useAi: "AI istifadə et (pulsuz provayderlər)", planNow: "Planı qur", accept: "Planı qəbul et", discard: "İmtina",
    today: "Bu gün", week: "Həftə", tasks: "Tapşırıqlar", commitments: "Öhdəliklər", save: "Saxla", cancel: "Ləğv et",
    questions: "Dəqiqləşdirmə", noItems: "Heç nə tapılmadı. Daha ətraflı yazın.", deadline: "Son tarix", estimate: "Müddət (dəq)",
    priority: "Prioritet", category: "Kateqoriya", start: "Başlama", duration: "Müddət (dəq)", repeat: "Təkrar", none: "yoxdur",
    daily: "hər gün", weekly: "hər həftə", proposal: "Təklif olunan plan", why: "Niyə bu vaxt", conflicts: "Ziddiyyətlər",
    moved: "köçürüləcək", free: "Boş vaxt", upcoming: "Yaxınlaşan son tarixlər", overdue: "Gecikmiş", done: "Tamamlanmış",
    byPriority: "Prioritetə görə", newTask: "Yeni tapşırıq", newEvent: "Yeni öhdəlik", title2: "Ad", empty: "Boşdur.",
    markDone: "Tamamlandı", skip: "Ötür", pin: "Sabitlə (avtomatik dəyişməsin)", unpin: "Sabitləməni götür", edit: "Düzəliş",
    unscheduled: "Planlaşdırılmadı", confirmed: "təsdiqlənmiş", saved: "Saxlanıldı", planSaved: "Plan saxlanıldı, xatırlatmalar quruldu",
    ruleNote: "Daxili qaydalar ilə anlaşıldı (oflayn).", aiNote: "AI ilə anlaşıldı:", aiFail: "AI əlçatmazdır, daxili qaydalar istifadə olundu:",
    planEmpty: "Planlaşdırılacaq yeni iş yoxdur.", nothingToday: "Bu gün üçün heç nə yoxdur.",
  },
  en: {
    title: "Planner", subtitle: "Tell Cahangir what you need to do — it finds the tasks, deadlines and suitable times.",
    placeholder: "e.g. I have a programming assignment due Friday. I need approximately two hours. I also have English lessons tomorrow at 10 AM.",
    understand: "Understand", useAi: "Use AI (free providers)", planNow: "Plan my time", accept: "Accept plan", discard: "Discard",
    today: "Today", week: "Week", tasks: "Tasks", commitments: "Commitments", save: "Save", cancel: "Cancel",
    questions: "Questions", noItems: "Nothing recognised. Please add more detail.", deadline: "Deadline", estimate: "Estimate (min)",
    priority: "Priority", category: "Category", start: "Start", duration: "Duration (min)", repeat: "Repeat", none: "none",
    daily: "daily", weekly: "weekly", proposal: "Proposed plan", why: "Why this time", conflicts: "Conflicts",
    moved: "will be moved", free: "Free time", upcoming: "Upcoming deadlines", overdue: "Overdue", done: "Completed",
    byPriority: "By priority", newTask: "New task", newEvent: "New commitment", title2: "Title", empty: "Empty.",
    markDone: "Done", skip: "Skip", pin: "Pin (never move automatically)", unpin: "Unpin", edit: "Edit",
    unscheduled: "Not scheduled", confirmed: "confirmed", saved: "Saved", planSaved: "Plan saved, reminders set",
    ruleNote: "Understood with built-in rules (offline).", aiNote: "Understood with AI:", aiFail: "AI unavailable, used built-in rules:",
    planEmpty: "Nothing new to schedule.", nothingToday: "Nothing planned for today.",
  },
};

const toInput = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromInput = (s: string): number | null => (s ? new Date(s).getTime() : null);
const PRIOS: Priority[] = ["urgent", "high", "medium", "low"];
const CATS = ["study", "work", "personal", "health", "home", "finance", "social", "general"];

export const PlannerView: React.FC<Props> = ({ lang, config, tasks, events, blocks, reminders, onChanged, toast }) => {
  const t = L[lang];
  const prefs = prefsFrom(config);
  const [tab, setTab] = useState<Tab>("today");
  const [text, setText] = useState("");
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<(ParseResult & { aiError?: string }) | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  type PlanOpts = { allowLate: string[]; extendMinutes: number; release: string[]; boost: string[] };
  const NO_OPTS: PlanOpts = { allowLate: [], extendMinutes: 0, release: [], boost: [] };
  const [planOpts, setPlanOpts] = useState<PlanOpts>(NO_OPTS);
  const [editTask, setEditTask] = useState<Partial<TaskItem> | null>(null);
  const [editEvent, setEditEvent] = useState<Partial<EventItem> | null>(null);
  const [editBlock, setEditBlock] = useState<PlanBlock | null>(null);
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  useEffect(() => {
    api.aiProviders().then((r) => setAiAvailable(!!r?.any_available)).catch(() => setAiAvailable(false));
  }, [config.server_url]);

  const taskById = useMemo(() => Object.fromEntries(tasks.map((x) => [x.id, x])), [tasks]);
  const data = { tasks, events, blocks, reminders };
  const now = Date.now();

  // ---------- capture ----------
  const doUnderstand = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setParsed(await understand(text, useAi && aiAvailable !== false, lang));
    } finally {
      setBusy(false);
    }
  };

  const saveParsed = async () => {
    if (!parsed) return;
    try {
      const savedTasks = await api.saveMany<TaskItem>(
        "tasks",
        parsed.tasks.map((x) => ({ title: x.title, description: x.description || "", category: x.category, priority: x.priority, deadline: x.deadline, estimated_minutes: x.estimated_minutes, status: "todo", source: parsed.source })),
      );
      const savedEvents = await api.saveMany<EventItem>(
        "events",
        parsed.events.map((e) => ({ title: e.title, start_at: e.start_at, end_at: e.end_at ?? (e.duration_minutes ? e.start_at + e.duration_minutes * 60000 : null), recurrence: e.recurrence ? JSON.stringify(e.recurrence) : null, confirmed: 1, source: parsed.source })),
      );
      const rems: any[] = [];
      for (const tk of savedTasks) rems.push(...Planner.deadlineReminders(tk, Date.now(), prefs, lang));
      for (const ev of savedEvents) if (ev.start_at > Date.now()) rems.push(Planner.eventReminder(ev, prefs, lang));
      if (rems.length) await api.saveMany("reminders", rems);
      toast("success", `${t.saved}: ${savedTasks.length} + ${savedEvents.length}`);
      setParsed(null);
      setText("");
      onChanged();
    } catch (e) {
      toast("error", errText(e));
    }
  };

  // ---------- planning ----------
  const makePlan = (opts = planOpts) => setPlan(schedule(tasks, events, blocks, prefs, lang, opts));
  const acceptPlan = async () => {
    if (!plan) return;
    try {
      await applyPlan(plan, tasks, lang, prefs);
      toast("success", t.planSaved);
      setPlan(null);
      setPlanOpts(NO_OPTS);
      onChanged();
    } catch (e) {
      toast("error", errText(e));
    }
  };
  const chooseAlternative = (taskId: string | undefined, alt: any) => {
    const o = { ...planOpts };
    if (alt.type === "allow_late" && taskId) o.allowLate = [...o.allowLate, taskId];
    else if (alt.type === "extend_day") o.extendMinutes = alt.extend_minutes || 120;
    else if (alt.type === "move_lower_priority" && taskId) {
      // Earlier deadline wins: re-plan with this task first by allowing others to slide.
      o.allowLate = [...o.allowLate];
    } else if (alt.type === "reduce_estimate" && taskId) {
      setEditTask(taskById[taskId]);
      return;
    }
    setPlanOpts(o);
    makePlan(o);
  };

  // ---------- edits ----------
  const saveTask = async () => {
    if (!editTask?.title?.trim()) return;
    const isDone = editTask.status === "done";
    const saved = await api.save<TaskItem>("tasks", { ...editTask, completed_at: isDone ? editTask.completed_at || Date.now() : null });
    await api.saveMany("reminders", Planner.deadlineReminders(saved, Date.now(), prefs, lang));
    setEditTask(null);
    onChanged();
  };
  const setTaskStatus = async (tk: TaskItem, status: TaskItem["status"]) => {
    await api.save("tasks", { id: tk.id, status, completed_at: status === "done" ? Date.now() : null });
    if (status === "done") {
      for (const r of reminders.filter((r) => r.task_id === tk.id && !r.done)) await api.save("reminders", { id: r.id, done: 1 });
    }
    onChanged();
  };
  const deleteTask = async (tk: TaskItem) => {
    if (!window.confirm(`"${tk.title}"?`)) return;
    await api.remove("tasks", tk.id);
    for (const b of blocks.filter((b) => b.task_id === tk.id && b.end_at > Date.now())) await api.remove("plan_blocks", b.id);
    for (const r of reminders.filter((r) => r.task_id === tk.id)) await api.remove("reminders", r.id);
    onChanged();
  };
  const saveEvent = async () => {
    if (!editEvent?.title?.trim() || !editEvent.start_at) return;
    const saved = await api.save<EventItem>("events", editEvent);
    if (saved.start_at > Date.now() || saved.recurrence) await api.save("reminders", Planner.eventReminder(saved, prefs, lang));
    setEditEvent(null);
    onChanged();
  };
  const deleteEvent = async (ev: EventItem) => {
    if (!window.confirm(`"${ev.title}"?`)) return;
    await api.remove("events", ev.id);
    await api.remove("reminders", "rem_evt_" + ev.id.replace(/[^A-Za-z0-9_-]/g, ""));
    onChanged();
  };
  const blockAction = async (b: PlanBlock, patch: Partial<PlanBlock>) => {
    await api.save("plan_blocks", { id: b.id, ...patch });
    onChanged();
  };
  const saveBlockEdit = async () => {
    if (!editBlock) return;
    // A manually edited session is pinned so automatic re-planning never moves it.
    await api.save("plan_blocks", { id: editBlock.id, start_at: editBlock.start_at, end_at: editBlock.end_at, locked: 1 });
    await api.save("reminders", Planner.blockReminder(editBlock, taskById[editBlock.task_id], prefs, lang));
    setEditBlock(null);
    onChanged();
  };

  // ---------- render helpers ----------
  const prioPill = (p?: string) => (p ? <span className={`pill ${p === "urgent" ? "urgent" : p === "high" ? "high" : ""}`}>{p}</span> : null);
  const taskLine = (tk: TaskItem) => (
    <div className="item" key={tk.id}>
      <input type="checkbox" checked={tk.status === "done"} onChange={() => setTaskStatus(tk, tk.status === "done" ? "todo" : "done")} />
      <div className="grow">
        <div className="title" style={{ textDecoration: tk.status === "done" ? "line-through" : undefined }}>{tk.title}</div>
        <div className="muted">
          {prioPill(tk.priority)}
          <span className="pill">{tk.category}</span>
          {tk.deadline ? <span className={`pill ${tk.deadline < now && tk.status !== "done" ? "urgent" : ""}`}>{t.deadline}: {fmtWhen(tk.deadline, lang)}</span> : null}
          {tk.estimated_minutes ? <span className="pill">{fmtMinutes(tk.estimated_minutes, lang)}</span> : <span className="pill high">{t.estimate}?</span>}
          {(() => {
            const planned = blocks.filter((b) => b.task_id === tk.id && b.status !== "skipped").reduce((s, b) => s + (b.end_at - b.start_at) / 60000, 0);
            return planned ? <span className="pill ok">{Math.round(planned)} / {tk.estimated_minutes || "?"} min</span> : null;
          })()}
        </div>
      </div>
      <button className="btn-icon" title={t.edit} onClick={() => setEditTask(tk)}><Pencil size={14} /></button>
      <button className="btn-icon" title="Delete" onClick={() => deleteTask(tk)}><Trash2 size={14} /></button>
    </div>
  );

  const agendaRow = (it: AgendaItem) => {
    const b = it.type === "block" ? blocks.find((x) => x.id === it.id) : undefined;
    return (
      <div className="item" key={it.type + it.id + it.start}>
        <div style={{ width: 92, flexShrink: 0 }} className="muted">
          {fmtClock(it.start)}{it.end > it.start ? `–${fmtClock(it.end)}` : ""}
        </div>
        <div className="grow">
          <div className="title">
            {it.type === "event" && <span className="pill event">{t.commitments}</span>}
            {it.type === "deadline" && <span className="pill urgent">{t.deadline}</span>}
            {it.type === "reminder" && <span className="pill">🔔</span>}
            {it.title}
            {it.locked && <Lock size={12} style={{ marginLeft: 6 }} />}
          </div>
          {it.reason && <div className="muted">{t.why}: {it.reason}</div>}
          {it.unknown_length && <div className="muted">⏱ {lang === "en" ? "length unknown — 60 min assumed" : "müddət bilinmir — 60 dəq götürülür"}</div>}
          {b && b.status === "done" && <span className="pill ok">✓</span>}
        </div>
        {b && b.status !== "done" && (
          <div className="row">
            <button className="btn-secondary btn-small" onClick={() => blockAction(b, { status: "done" })}><Check size={13} /> {t.markDone}</button>
            <button className="btn-secondary btn-small" onClick={() => blockAction(b, { status: "skipped" })}>{t.skip}</button>
            <button className="btn-icon" title={b.locked ? t.unpin : t.pin} onClick={() => blockAction(b, { locked: b.locked ? 0 : 1 })}>{b.locked ? <Unlock size={14} /> : <Lock size={14} />}</button>
            <button className="btn-icon" title={t.edit} onClick={() => setEditBlock(b)}><Pencil size={14} /></button>
          </div>
        )}
      </div>
    );
  };

  const today = Planner.dayAgenda(data, now, prefs);
  const week = Planner.weekOverview(data, Planner.addDays(Planner.startOfWeek(now), weekOffset * 7), prefs);
  const openTasks = tasks.filter((x) => x.status !== "done" && x.status !== "cancelled");

  return (
    <div className="content-view">
      <div>
        <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>{t.title}</h2>
        <p className="muted">{t.subtitle}</p>
      </div>

      {/* Natural-language capture */}
      <div className="card col">
        <textarea className="nl" value={text} placeholder={t.placeholder} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doUnderstand(); }} />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label className="row muted">
            <input type="checkbox" checked={useAi && aiAvailable !== false} disabled={aiAvailable === false} onChange={(e) => setUseAi(e.target.checked)} />
            {t.useAi} {aiAvailable === false && (lang === "en" ? "(not available)" : "(əlçatmaz)")}
          </label>
          <div className="row">
            <button className="btn-secondary" onClick={() => makePlan()}><Wand2 size={15} /> {t.planNow}</button>
            <button className="btn-primary" disabled={busy || !text.trim()} onClick={doUnderstand}><Sparkles size={15} /> {busy ? "…" : t.understand}</button>
          </div>
        </div>
      </div>

      {parsed && (
        <div className="card col">
          <div className="muted">
            {parsed.source === "rules" ? (parsed.aiError ? `${t.aiFail} ${parsed.aiError}` : t.ruleNote) : `${t.aiNote} ${parsed.source.slice(3)}`}
          </div>
          {!parsed.tasks.length && !parsed.events.length && <div>{t.noItems}</div>}
          {parsed.tasks.map((x, i) => (
            <div className="item" key={"pt" + i}>
              <div className="grow col">
                <input type="text" value={x.title} onChange={(e) => { const c = { ...parsed }; c.tasks[i] = { ...x, title: e.target.value }; setParsed(c); }} />
                <div className="form-grid">
                  <label>{t.deadline}<input type="datetime-local" value={toInput(x.deadline)} onChange={(e) => { const c = { ...parsed }; c.tasks[i] = { ...x, deadline: fromInput(e.target.value) }; setParsed(c); }} /></label>
                  <label>{t.estimate}<input type="number" min={5} step={5} value={x.estimated_minutes ?? ""} onChange={(e) => { const c = { ...parsed }; c.tasks[i] = { ...x, estimated_minutes: e.target.value ? +e.target.value : null }; setParsed(c); }} /></label>
                  <label>{t.priority}<select value={x.priority} onChange={(e) => { const c = { ...parsed }; c.tasks[i] = { ...x, priority: e.target.value as Priority }; setParsed(c); }}>{PRIOS.map((p) => <option key={p}>{p}</option>)}</select></label>
                  <label>{t.category}<select value={x.category} onChange={(e) => { const c = { ...parsed }; c.tasks[i] = { ...x, category: e.target.value }; setParsed(c); }}>{CATS.map((p) => <option key={p}>{p}</option>)}</select></label>
                </div>
              </div>
              <button className="btn-icon" onClick={() => { const c = { ...parsed, tasks: parsed.tasks.filter((_, j) => j !== i) }; setParsed(c); }}><X size={14} /></button>
            </div>
          ))}
          {parsed.events.map((x, i) => (
            <div className="item" key={"pe" + i}>
              <span className="pill event">{t.commitments}</span>
              <div className="grow col">
                <input type="text" value={x.title} onChange={(e) => { const c = { ...parsed }; c.events[i] = { ...x, title: e.target.value }; setParsed(c); }} />
                <div className="form-grid">
                  <label>{t.start}<input type="datetime-local" value={toInput(x.start_at)} onChange={(e) => { const c = { ...parsed }; c.events[i] = { ...x, start_at: fromInput(e.target.value) || x.start_at }; setParsed(c); }} /></label>
                  <label>{t.duration}<input type="number" min={5} step={5} value={x.duration_minutes ?? ""} onChange={(e) => { const c = { ...parsed }; const d = e.target.value ? +e.target.value : null; c.events[i] = { ...x, duration_minutes: d, end_at: d ? x.start_at + d * 60000 : null }; setParsed(c); }} /></label>
                  <label>{t.repeat}<span className="muted">{x.recurrence ? (x.recurrence.type === "daily" ? t.daily : t.weekly) : t.none}</span></label>
                </div>
              </div>
              <button className="btn-icon" onClick={() => { const c = { ...parsed, events: parsed.events.filter((_, j) => j !== i) }; setParsed(c); }}><X size={14} /></button>
            </div>
          ))}
          {parsed.questions.length > 0 && (
            <div className="conflict">
              <b>{t.questions}</b>
              {parsed.questions.map((q, i) => <div key={i}>• {q.text}</div>)}
            </div>
          )}
          {parsed.notes.map((n, i) => <div className="muted" key={i}>ℹ {n}</div>)}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-secondary" onClick={() => setParsed(null)}>{t.discard}</button>
            <button className="btn-primary" disabled={!parsed.tasks.length && !parsed.events.length} onClick={saveParsed}><Check size={15} /> {t.save}</button>
          </div>
        </div>
      )}

      {plan && (
        <div className="card col">
          <b>{t.proposal}</b>
          {!plan.add.length && !plan.remove.length && <div className="muted">{t.planEmpty}</div>}
          {plan.add.map((b) => (
            <div className="item" key={b.id}>
              <div style={{ width: 150 }} className="muted">{fmtWhen(b.start_at, lang)}–{fmtClock(b.end_at)}</div>
              <div className="grow">
                <div className="title">{taskById[b.task_id]?.title}</div>
                <div className="muted">{t.why}: {b.reason}</div>
              </div>
            </div>
          ))}
          {plan.remove.length > 0 && <div className="muted">{plan.remove.length} {t.moved}</div>}
          {(plan.conflicts.length > 0 || plan.unscheduled.length > 0) && <b>{t.conflicts}</b>}
          {plan.conflicts.map((c, i) => (
            <div className={c.type === "deadline_at_risk" || c.type === "overdue" ? "danger-box" : "conflict"} key={"c" + i}>
              <div>{c.message}</div>
              <div className="row" style={{ marginTop: 6 }}>
                {c.alternatives.map((a, j) => <button key={j} className="btn-secondary btn-small" onClick={() => chooseAlternative(c.task_id, a)}>{a.message}</button>)}
              </div>
            </div>
          ))}
          {plan.unscheduled.map((u, i) => (
            <div className="conflict" key={"u" + i}>
              <div>{u.message}</div>
              {u.reason === "needs_estimate" && <button className="btn-secondary btn-small" onClick={() => setEditTask(taskById[u.task_id])}>{t.edit}</button>}
              {u.alternatives?.filter((a) => a.type === "allow_late").map((a, j) => <button key={j} className="btn-secondary btn-small" onClick={() => chooseAlternative(u.task_id, a)}>{a.message}</button>)}
            </div>
          ))}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-secondary" onClick={() => { setPlan(null); setPlanOpts(NO_OPTS); }}>{t.discard}</button>
            <button className="btn-primary" disabled={!plan.add.length && !plan.remove.length} onClick={acceptPlan}><Check size={15} /> {t.accept}</button>
          </div>
        </div>
      )}

      <div className="tabs">
        {(["today", "week", "tasks", "commitments"] as Tab[]).map((k) => (
          <button key={k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{t[k]}</button>
        ))}
      </div>

      {tab === "today" && (
        <div className="col">
          <div className="muted">{t.free}: {fmtMinutes(today.free_minutes, lang)} · {today.free.map((f: any) => `${fmtClock(f.start)}–${fmtClock(f.end)}`).join(", ")}</div>
          {today.items.length ? today.items.map(agendaRow) : <div className="muted">{t.nothingToday}</div>}
          {Planner.overdueTasks(tasks, now).length > 0 && (
            <div className="danger-box"><b>{t.overdue}</b>{Planner.overdueTasks(tasks, now).map((x: TaskItem) => <div key={x.id}>• {x.title} ({fmtWhen(x.deadline!, lang)})</div>)}</div>
          )}
        </div>
      )}

      {tab === "week" && (
        <div className="row">
          <button className="btn-secondary btn-small" onClick={() => setWeekOffset(weekOffset - 1)}>‹</button>
          <button className="btn-secondary btn-small" onClick={() => setWeekOffset(0)}>{t.today}</button>
          <button className="btn-secondary btn-small" onClick={() => setWeekOffset(weekOffset + 1)}>›</button>
        </div>
      )}
      {tab === "week" && (
        <div className="week-grid">
          {week.map((d: any) => (
            <div key={d.day} className={`week-day ${Planner.sod(now) === d.day ? "today" : ""}`}>
              <b>{new Date(d.day).toLocaleDateString(lang === "en" ? "en-GB" : "az-AZ", { weekday: "short", day: "numeric", month: "short" })}</b>
              <div className="muted">{t.free}: {fmtMinutes(d.free_minutes, lang)}</div>
              <div className="muted">⏱ {fmtMinutes(d.planned_minutes, lang)}</div>
              {d.items.filter((i: AgendaItem) => i.type !== "reminder").map((i: AgendaItem) => (
                <div key={i.type + i.id + i.start} style={{ marginTop: 3, color: i.type === "deadline" ? "var(--danger)" : i.type === "event" ? "var(--accent-blue)" : undefined }}>
                  {i.type === "deadline" ? "⚑" : fmtClock(i.start)} {i.title}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "tasks" && (
        <div className="col">
          <div className="row"><button className="btn-primary" onClick={() => setEditTask({ title: "", priority: "medium", category: "general", status: "todo", deadline: null, estimated_minutes: null })}><Plus size={15} /> {t.newTask}</button></div>
          {Planner.overdueTasks(tasks, now).length > 0 && <b style={{ color: "var(--danger)" }}>{t.overdue}</b>}
          {Planner.overdueTasks(tasks, now).map(taskLine)}
          <b>{t.upcoming}</b>
          {Planner.upcomingDeadlines(tasks, now, 7).length ? Planner.upcomingDeadlines(tasks, now, 7).map(taskLine) : <div className="muted">{t.empty}</div>}
          <b>{t.byPriority}</b>
          {(() => {
            const g = Planner.byPriority(openTasks);
            return PRIOS.flatMap((p) => g[p]).length ? PRIOS.flatMap((p) => g[p]).map(taskLine) : <div className="muted">{t.empty}</div>;
          })()}
          <b>{t.done}</b>
          {Planner.completedTasks(tasks).slice(0, 20).map(taskLine)}
        </div>
      )}

      {tab === "commitments" && (
        <div className="col">
          <div className="row"><button className="btn-primary" onClick={() => setEditEvent({ title: "", start_at: Math.ceil((Date.now() + 3600000) / 900000) * 900000, end_at: null, confirmed: 1, recurrence: null })}><CalendarDays size={15} /> {t.newEvent}</button></div>
          {events.length ? events.slice().sort((a, b) => a.start_at - b.start_at).map((ev) => (
            <div className="item" key={ev.id}>
              <div className="grow">
                <div className="title">{ev.title} {ev.confirmed ? <span className="pill ok">{t.confirmed}</span> : null}</div>
                <div className="muted">{fmtWhen(ev.start_at, lang)}{ev.end_at ? `–${fmtClock(ev.end_at)}` : ""} {ev.recurrence ? `· 🔁 ${JSON.parse(ev.recurrence).type === "daily" ? t.daily : t.weekly}` : ""}</div>
              </div>
              <button className="btn-icon" onClick={() => setEditEvent(ev)}><Pencil size={14} /></button>
              <button className="btn-icon" onClick={() => deleteEvent(ev)}><Trash2 size={14} /></button>
            </div>
          )) : <div className="muted">{t.empty}</div>}
        </div>
      )}

      {editTask && (
        <div className="card col">
          <b>{editTask.id ? t.edit : t.newTask}</b>
          <input type="text" placeholder={t.title2} value={editTask.title || ""} onChange={(e) => setEditTask({ ...editTask, title: e.target.value })} />
          <div className="form-grid">
            <label>{t.deadline}<input type="datetime-local" value={toInput(editTask.deadline ?? null)} onChange={(e) => setEditTask({ ...editTask, deadline: fromInput(e.target.value) })} /></label>
            <label>{t.estimate}<input type="number" min={5} step={5} value={editTask.estimated_minutes ?? ""} onChange={(e) => setEditTask({ ...editTask, estimated_minutes: e.target.value ? +e.target.value : null })} /></label>
            <label>{t.priority}<select value={editTask.priority} onChange={(e) => setEditTask({ ...editTask, priority: e.target.value as Priority })}>{PRIOS.map((p) => <option key={p}>{p}</option>)}</select></label>
            <label>{t.category}<select value={editTask.category} onChange={(e) => setEditTask({ ...editTask, category: e.target.value })}>{CATS.map((p) => <option key={p}>{p}</option>)}</select></label>
            <label>Status<select value={editTask.status} onChange={(e) => setEditTask({ ...editTask, status: e.target.value as TaskItem["status"] })}>{["todo", "in_progress", "done", "cancelled"].map((p) => <option key={p}>{p}</option>)}</select></label>
          </div>
          <textarea value={editTask.description || ""} placeholder="…" onChange={(e) => setEditTask({ ...editTask, description: e.target.value })} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-secondary" onClick={() => setEditTask(null)}>{t.cancel}</button>
            <button className="btn-primary" onClick={saveTask}>{t.save}</button>
          </div>
        </div>
      )}

      {editEvent && (
        <div className="card col">
          <b>{editEvent.id ? t.edit : t.newEvent}</b>
          <input type="text" placeholder={t.title2} value={editEvent.title || ""} onChange={(e) => setEditEvent({ ...editEvent, title: e.target.value })} />
          <div className="form-grid">
            <label>{t.start}<input type="datetime-local" value={toInput(editEvent.start_at ?? null)} onChange={(e) => {
              const s = fromInput(e.target.value) || 0;
              const len = editEvent.end_at && editEvent.start_at ? editEvent.end_at - editEvent.start_at : null;
              setEditEvent({ ...editEvent, start_at: s, end_at: len ? s + len : null });
            }} /></label>
            <label>{t.duration}<input type="number" min={5} step={5} value={editEvent.end_at && editEvent.start_at ? Math.round((editEvent.end_at - editEvent.start_at) / 60000) : ""} onChange={(e) => setEditEvent({ ...editEvent, end_at: e.target.value ? (editEvent.start_at || 0) + +e.target.value * 60000 : null })} /></label>
            <label>{t.repeat}<select value={editEvent.recurrence ? JSON.parse(editEvent.recurrence).type : ""} onChange={(e) => setEditEvent({ ...editEvent, recurrence: e.target.value === "daily" ? '{"type":"daily"}' : e.target.value === "weekly" ? JSON.stringify({ type: "weekly", wday: new Date(editEvent.start_at || Date.now()).getDay() }) : null })}>
              <option value="">{t.none}</option><option value="daily">{t.daily}</option><option value="weekly">{t.weekly}</option>
            </select></label>
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-secondary" onClick={() => setEditEvent(null)}>{t.cancel}</button>
            <button className="btn-primary" onClick={saveEvent}>{t.save}</button>
          </div>
        </div>
      )}

      {editBlock && (
        <div className="card col">
          <b>{t.edit}: {taskById[editBlock.task_id]?.title}</b>
          <div className="form-grid">
            <label>{t.start}<input type="datetime-local" value={toInput(editBlock.start_at)} onChange={(e) => { const s = fromInput(e.target.value) || editBlock.start_at; setEditBlock({ ...editBlock, start_at: s, end_at: s + (editBlock.end_at - editBlock.start_at) }); }} /></label>
            <label>{t.duration}<input type="number" min={5} step={5} value={Math.round((editBlock.end_at - editBlock.start_at) / 60000)} onChange={(e) => setEditBlock({ ...editBlock, end_at: editBlock.start_at + (+e.target.value || 5) * 60000 })} /></label>
          </div>
          <div className="muted">{t.pin}</div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn-secondary" onClick={() => setEditBlock(null)}>{t.cancel}</button>
            <button className="btn-primary" onClick={saveBlockEdit}>{t.save}</button>
          </div>
        </div>
      )}
    </div>
  );
};
