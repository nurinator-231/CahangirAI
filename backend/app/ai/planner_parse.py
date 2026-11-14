"""AI-assisted natural-language task extraction.

The model only proposes structure; this module validates it. A deadline or event time
is accepted only if the model quotes the exact phrase from the user's text that states
it (deadline_text / time_text must occur in the input). Anything else is dropped and
turned into a focused question, so the assistant never invents a deadline or a
commitment.
"""
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

PRIORITIES = {"low", "medium", "high", "urgent"}
CATEGORIES = {"study", "work", "personal", "health", "home", "finance", "social", "general"}

SYSTEM_PROMPT = """You extract a personal planner's data from the user's message.
Return ONLY a JSON object with this exact shape:
{"tasks":[{"title":str,"description":str,"category":str,"priority":"low|medium|high|urgent",
  "deadline":"YYYY-MM-DDTHH:MM"|null,"deadline_text":str|null,"estimated_minutes":int|null,"estimate_text":str|null}],
 "events":[{"title":str,"start":"YYYY-MM-DDTHH:MM"|null,"time_text":str|null,"duration_minutes":int|null,
  "recurrence":null|{"type":"daily"}|{"type":"weekly","wday":0-6}}],
 "questions":[str]}
Rules:
- tasks = things the user must do (assignments, chores, work). events = fixed commitments at a set time (lessons, meetings, appointments).
- deadline_text / time_text / estimate_text MUST be copied verbatim from the user's message (the words that state it). If the message does not state it, use null. NEVER guess dates, times or durations.
- A deadline given only as a day (e.g. "due Friday") means 23:59 that day.
- Resolve relative dates against NOW. Weeks start on Monday. wday: 0=Sunday..6=Saturday.
- category one of: study, work, personal, health, home, finance, social, general.
- priority: "urgent" only if the user says so; "high" if important/soon; default "medium".
- questions: short questions for information that is essential but missing (e.g. how long a task takes).
- Keep the user's language for titles and questions."""


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _quoted(phrase: Optional[str], text: str) -> bool:
    return bool(phrase) and len(_norm(phrase)) >= 2 and _norm(phrase) in _norm(text)


def _to_ms(local_iso: Optional[str], tz_offset_min: int) -> Optional[int]:
    if not local_iso:
        return None
    try:
        dt = datetime.fromisoformat(str(local_iso)[:16])
    except ValueError:
        return None
    tz = timezone(timedelta(minutes=tz_offset_min))
    return int(dt.replace(tzinfo=tz).timestamp() * 1000)


def build_messages(text: str, now_local_iso: str, tz_offset_min: int, weekday: str):
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"NOW: {now_local_iso} ({weekday}), UTC offset {tz_offset_min:+d} minutes.\nMESSAGE:\n{text}"},
    ]


def _extract_json(raw: str) -> Dict[str, Any]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.MULTILINE).strip()
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("model did not return JSON")
    return json.loads(raw[start:end + 1])


def validate(raw_output: str, text: str, tz_offset_min: int, now_ms: int) -> Dict[str, Any]:
    data = _extract_json(raw_output)
    tasks_out: List[dict] = []
    events_out: List[dict] = []
    questions: List[str] = [str(q)[:300] for q in (data.get("questions") or []) if isinstance(q, str)][:10]
    for t in (data.get("tasks") or [])[:30]:
        if not isinstance(t, dict) or not str(t.get("title") or "").strip():
            continue
        title = str(t["title"]).strip()[:300]
        deadline = None
        if t.get("deadline"):
            if _quoted(t.get("deadline_text"), text):
                deadline = _to_ms(t.get("deadline"), tz_offset_min)
            if deadline is None:
                questions.append(f"When is \"{title}\" due?")
        est = t.get("estimated_minutes")
        if est is not None:
            try:
                est = int(est)
            except (TypeError, ValueError):
                est = None
        if est is not None and (est <= 0 or est > 60 * 24 * 14 or not _quoted(t.get("estimate_text"), text)):
            est = None
        if est is None:
            questions.append(f"About how long will \"{title}\" take?")
        prio = str(t.get("priority") or "medium").lower()
        cat = str(t.get("category") or "general").lower()
        tasks_out.append({
            "title": title,
            "description": str(t.get("description") or "")[:2000],
            "category": cat if cat in CATEGORIES else "general",
            "priority": prio if prio in PRIORITIES else "medium",
            "deadline": deadline,
            "estimated_minutes": est,
        })
    for e in (data.get("events") or [])[:30]:
        if not isinstance(e, dict) or not str(e.get("title") or "").strip():
            continue
        title = str(e["title"]).strip()[:300]
        start = _to_ms(e.get("start"), tz_offset_min) if _quoted(e.get("time_text"), text) else None
        if start is None:
            questions.append(f"When exactly is \"{title}\"?")
            continue  # never store a commitment without a stated time
        dur = e.get("duration_minutes")
        try:
            dur = int(dur) if dur is not None else None
        except (TypeError, ValueError):
            dur = None
        rec = e.get("recurrence")
        if not (isinstance(rec, dict) and rec.get("type") in ("daily", "weekly")):
            rec = None
        if dur is None:
            questions.append(f"How long does \"{title}\" last?")
        events_out.append({
            "title": title,
            "start_at": start,
            "end_at": start + dur * 60_000 if dur and dur > 0 else None,
            "duration_minutes": dur if dur and dur > 0 else None,
            "recurrence": rec,
        })
    # Deduplicate questions, keep order.
    seen, uq = set(), []
    for q in questions:
        if q not in seen:
            seen.add(q)
            uq.append(q)
    return {"tasks": tasks_out, "events": events_out, "questions": uq}
