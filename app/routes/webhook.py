import re
import httpx
from fastapi import APIRouter, Request, Header
from app.database import supabase
from app.config import SPURNOW_SECRET, OPENAI_KEY
from app.services.whatsapp import enviar_whatsapp, enviar_whatsapp_spurnow

router = APIRouter()

_processadas: set = set()


def _ja_processada(msg_id: str | None) -> bool:
    if not msg_id:
        return False
    if msg_id in _processadas:
        return True
    _processadas.add(msg_id)
    if len(_processadas) > 2000:
        _processadas.pop()
    return False


def _normalizar_telefone(raw: str) -> str:
    tel = re.sub(r"@c\.us|@s\.whatsapp\.net", "", raw or "")
    tel = re.sub(r"\D", "", tel)
    tel = re.sub(r"^55", "", tel)
    if len(tel) == 10:
        tel = tel[:2] + "9" + tel[2:]
    return tel


def _extrair_audio_url(body: dict) -> str | None:
    # Z-API: audio PTT (voz)
    audio = body.get("audio") or body.get("ptt") or {}
    if isinstance(audio, dict):
        url = audio.get("audioUrl") or audio.get("url") or audio.get("base64")
        if url:
            return url
    # SpurNow
    content = (body.get("content") or {})
    if isinstance(content, dict):
        audio2 = content.get("audio") or {}
        if isinstance(audio2, dict):
            return audio2.get("url") or audio2.get("link")
    # Fallback genérico
    return body.get("audioUrl") or body.get("mediaUrl")


async def _transcrever_audio(url: str) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            dl = await client.get(url)
            dl.raise_for_status()
            audio_bytes = dl.content
            r = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                files={"file": ("audio.ogg", audio_bytes, "audio/ogg")},
                data={"model": "whisper-1", "language": "pt"},
                headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            )
            r.raise_for_status()
            texto = r.json().get("text", "").strip()
            print(f"[whisper] transcrito: {texto[:80]}")
            return texto or None
    except Exception as e:
        print(f"[whisper] erro: {e}")
        return None


@router.post("/webhook")
async def webhook_zapi(request: Request):
    body = await request.json()
    if not body or body.get("fromMe") or body.get("isGroup"):
        return 200

    msg_id = body.get("messageId") or body.get("id") or (body.get("data", {}) or {}).get("key", {}).get("id")
    if _ja_processada(msg_id):
        return 200

    telefone = _normalizar_telefone(body.get("phone") or body.get("from") or "")
    mensagem = (
        (body.get("text") or {}).get("message")
        or (body.get("texto") or {}).get("mensagem")
        or body.get("message") or body.get("body")
    )

    if not mensagem:
        audio_url = _extrair_audio_url(body)
        if audio_url:
            mensagem = await _transcrever_audio(audio_url)

    if not telefone or not mensagem:
        return 200

    try:
        await _tratar_lead(telefone, mensagem)
    except Exception as e:
        print(f"[webhook] erro: {e}")
    return 200


async def _tratar_lead(telefone: str, mensagem: str):
    from app.services.lead_ai import (
        buscar_ou_criar_lead, buscar_historico_lead,
        processar_mensagem_lead, atualizar_lead, salvar_mensagem_lead,
    )
    try:
        usuarios = supabase.from_("usuarios").select("id,escritorio").limit(1).execute()
        if not usuarios.data:
            return
        usuario_id = usuarios.data[0]["id"]
        escritorio = usuarios.data[0].get("escritorio", "nosso escritório")

        lead = buscar_ou_criar_lead(telefone, usuario_id)
        if not lead:
            return

        if lead.get("status") in ("fechado", "perdido"):
            return

        salvar_mensagem_lead(lead["id"], "cliente", mensagem)
        historico = buscar_historico_lead(lead["id"])
        resultado = await processar_mensagem_lead(
            lead["id"], mensagem, historico, escritorio, lead.get("nome")
        )

        updates = {"status": resultado["status"]}
        if resultado.get("area"):
            updates["area"] = resultado["area"]
        if resultado.get("resumo"):
            updates["resumo"] = resultado["resumo"]
        if resultado.get("status") == "fechado":
            updates["score"] = 100
        atualizar_lead(lead["id"], updates)

        await enviar_whatsapp(telefone, resultado["mensagem"])
        salvar_mensagem_lead(lead["id"], "bot", resultado["mensagem"])
        print(f"[lead] {telefone} status={resultado['status']}")
    except Exception as e:
        print(f"[lead] erro: {e}")


@router.post("/webhook-spurnow")
async def webhook_spurnow(request: Request):
    segredo = request.headers.get("x-webhook-secret") or request.headers.get("x-spur-secret") or request.query_params.get("secret")
    if SPURNOW_SECRET and segredo != SPURNOW_SECRET:
        return 401

    try:
        body = await request.json()
        print(f"[spurnow-webhook] payload: {body}")

        msg_id = body.get("id") or body.get("messageId") or (body.get("data") or {}).get("id")
        if _ja_processada(msg_id):
            return 200

        telefone = _normalizar_telefone(
            body.get("from") or body.get("phone")
            or (body.get("data") or {}).get("from")
            or (body.get("contact") or {}).get("phone") or ""
        )
        mensagem = (
            body.get("message") or body.get("text")
            or (body.get("data") or {}).get("message")
            or ((body.get("content") or {}).get("text") or {}).get("body")
        )

        if not mensagem:
            audio_url = _extrair_audio_url(body)
            if audio_url:
                mensagem = await _transcrever_audio(audio_url)

        if not telefone or not mensagem:
            return 200

        await _tratar_lead(telefone, mensagem)
    except Exception as e:
        print(f"[spurnow-webhook] erro: {e}")
    return 200


@router.post("/testar-whatsapp")
async def testar_whatsapp(body: dict):
    telefone = body.get("telefone", "")
    nome = body.get("nome", "")
    try:
        await enviar_whatsapp(telefone, f"Olá, {nome}! Teste do sistema Advogar.AI.")
        return {"sucesso": True}
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=str(e))
