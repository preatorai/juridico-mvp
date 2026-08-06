from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.database import supabase
from app.routes import auth, perfil, webhook, mensagens, leads

app = FastAPI(title="Advogar.AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(perfil.router)
app.include_router(webhook.router)
app.include_router(mensagens.router)
app.include_router(leads.router)


@app.get("/")
def root():
    from fastapi.responses import FileResponse
    import os
    html = os.path.join(os.path.dirname(__file__), "..", "landing.html")
    if os.path.exists(html):
        return FileResponse(html)
    return "Advogar.AI"


@app.get("/app")
def app_page():
    from fastapi.responses import FileResponse
    import os
    html = os.path.join(os.path.dirname(__file__), "..", "index.html")
    if os.path.exists(html):
        return FileResponse(html)
    return "Advogar.AI"


@app.get("/ping")
def ping():
    import time
    return {"ok": True, "ts": int(time.time() * 1000)}


@app.post("/deploy")
async def deploy(request: Request):
    from app.config import DEPLOY_SECRET
    secret = request.headers.get("x-deploy-secret") or (await request.json()).get("secret", "")
    if not DEPLOY_SECRET or secret != DEPLOY_SECRET:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="Unauthorized")
    import subprocess, os
    subprocess.Popen(
        ["bash", "-c", "sleep 2 && cd /home/ubuntu/juridico-mvp && git pull && sudo systemctl restart praetor"],
        preexec_fn=os.setsid
    )
    return {"ok": True, "msg": "Deploy iniciado"}
