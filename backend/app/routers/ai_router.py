from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.ai import planner_parse
from app.ai.router import NoProviderAvailable, get_router
from app.auth import verify_device_token
from app.database import now_ms

router = APIRouter(prefix="/api/ai", tags=["AI Router"])


class ChatMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant|system)$")
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    messages: List[ChatMessage] = Field(min_length=1, max_length=40)
    task: str = "chat"
    context: Optional[str] = Field(None, max_length=4000)


class ParseRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    now_local: str = Field(description="Client local time, ISO 'YYYY-MM-DDTHH:MM'")
    tz_offset_minutes: int = Field(0, ge=-14 * 60, le=14 * 60)
    weekday: str = ""


def _unavailable(e: NoProviderAvailable):
    raise HTTPException(
        status_code=503,
        detail={"error": "ai_unavailable", "message": str(e), "attempts": e.attempts,
                "fallback": "Use the built-in (non-AI) planner and commands."},
    )


@router.get("/providers")
def providers(device_id: str = Depends(verify_device_token)):
    """Status of every supported free-tier provider (keys are never returned)."""
    r = get_router()
    st = r.status()
    return {"providers": st, "any_available": any(p["available"] for p in st), "order": {t: r.order_for(t) for t in ("parse", "chat", "plan")}}


SYSTEM_CHAT = (
    "You are Cahangir, a concise personal assistant. Answer in the user's language "
    "(Azerbaijani by default). If you do not know, say so; never invent facts, dates or "
    "commitments. The app itself creates reminders and tasks; do not claim you did."
)


@router.post("/chat")
def chat(req: ChatRequest, device_id: str = Depends(verify_device_token)):
    msgs: List[Dict[str, str]] = [{"role": "system", "content": SYSTEM_CHAT + (f"\nContext: {req.context}" if req.context else "")}]
    msgs += [m.model_dump() for m in req.messages if m.role != "system"]
    try:
        res = get_router().complete(req.task if req.task in ("chat", "plan") else "chat", msgs)
    except NoProviderAvailable as e:
        _unavailable(e)
    return {"text": res.text, "provider": res.provider, "model": res.model}


@router.post("/parse")
def parse(req: ParseRequest, device_id: str = Depends(verify_device_token)):
    """Natural-language -> structured tasks/events, validated against the input text."""
    msgs = planner_parse.build_messages(req.text, req.now_local, req.tz_offset_minutes, req.weekday)
    try:
        res = get_router().complete("parse", msgs, json_mode=True)
    except NoProviderAvailable as e:
        _unavailable(e)
    try:
        out = planner_parse.validate(res.text, req.text, req.tz_offset_minutes, now_ms())
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=502, detail={"error": "ai_bad_output", "message": "The AI response could not be used; falling back to built-in parsing."})
    out["provider"] = res.provider
    out["model"] = res.model
    return out
