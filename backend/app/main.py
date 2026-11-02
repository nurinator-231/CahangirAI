import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config import HOST, LOG_LEVEL, PORT
from app.database import init_db
from app.routers import (
    auth_router,
    health_router,
    memory_router,
    projects_router,
    reminders_router,
    sync_router,
)

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("cahangir.backend")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Cahangir SQLite persistent database...")
    init_db()
    logger.info(f"Cahangir backend ready on {HOST}:{PORT}")
    yield
    logger.info("Cahangir backend shutting down cleanly.")


app = FastAPI(
    title="Cahangir Central Memory & Sync API",
    description="Offline-first central memory and synchronization backend for Cahangir AI assistant.",
    version="3.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router.router)
app.include_router(sync_router.router)
app.include_router(memory_router.router)
app.include_router(reminders_router.router)
app.include_router(projects_router.router)
app.include_router(health_router.router)


@app.get("/", tags=["Root"])
def root():
    return {
        "app": "Cahangir Central Backend",
        "version": "3.0.0",
        "status": "online",
        "docs_url": "/docs",
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level=LOG_LEVEL.lower())
