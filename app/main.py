import asyncio
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import supabase
from app.routes import auth, processos, perfil, chat, webhook, mensagens, prazos
from app.services.codilo import pre_aquecer_cache
from app.services.scheduler import start_scheduler

app = FastAPI(title="Praetor AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(processos.router)
app.include_router(perfil.router)
app.include_router(chat.router)
app.include_router(webhook.router)
app.include_router(mensagens.router)
app.include_router(prazos.router)


@app.get("/")
def root():
    return "Sistema juridico rodando!"


@app.get("/ping")
def ping():
    import time
    return {"ok": True, "ts": int(time.time() * 1000)}


@app.on_event("startup")
async def startup():
    start_scheduler()
    asyncio.create_task(pre_aquecer_cache())
