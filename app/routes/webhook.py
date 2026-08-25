import re
import httpx
from fastapi import APIRouter, Request, Response
from app.database import supabase
from app.config import SPURNOW_SECRET, ZAPI_WEBHOOK_SECRET, OPENAI_KEY, WHATSAPP_USUARIO_EMAIL
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


# ── Z-API: recebimento de mensagens ────────────────────────────────────────

def _webhook_autorizado(request: Request) -> bool:
    """Valida a chamada como vinda de fato da Z-API.

    Se ZAPI_WEBHOOK_SECRET estiver configurado no .env, exige que o mesmo valor
    venha num header — configure um "Header customizado" com esse valor no
    painel da Z-API (aba Webhooks). Sem secret configurado, só a validação de
    formato do payload (abaixo) é aplicada.
    """
    if not ZAPI_WEBHOOK_SECRET:
        return True
    recebido = request.headers.get("x-zapi-webhook-secret") or request.headers.get("client-token")
    return recebido == ZAPI_WEBHOOK_SECRET


def _parse_zapi_payload(body: dict) -> dict:
    """Extrai os campos relevantes do payload de webhook da Z-API.

    Retorna: {telefone, mensagem, msg_id, audio_url}
    - telefone/mensagem vêm None quando o payload não trouxer esses dados
      (ex: mensagem de áudio chega sem `mensagem`, mas com `audio_url`)
    """
    msg_id = (
        body.get("messageId") or body.get("id")
        or (body.get("data", {}) or {}).get("key", {}).get("id")
    )
    telefone = _normalizar_telefone(body.get("phone") or body.get("from") or "")
    mensagem = (
        (body.get("text") or {}).get("message")
        or (body.get("texto") or {}).get("mensagem")
        or body.get("message") or body.get("body")
    )
    audio_url = _extrair_audio_url(body) if not mensagem else None
    return {"telefone": telefone or None, "mensagem": mensagem, "msg_id": msg_id, "audio_url": audio_url}


@router.post("/webhook")
async def webhook_zapi(request: Request):
    if not _webhook_autorizado(request):
        return Response(status_code=401)

    body = await request.json()
    if not isinstance(body, dict) or not body:
        return {"ok": True}  # payload em formato inesperado — confirma recebimento e ignora
    if body.get("fromMe") or body.get("isGroup"):
        return {"ok": True}

    dados = _parse_zapi_payload(body)
    if _ja_processada(dados["msg_id"]):
        return {"ok": True}

    mensagem = dados["mensagem"]
    if not mensagem and dados["audio_url"]:
        mensagem = await _transcrever_audio(dados["audio_url"])

    if not dados["telefone"] or not mensagem:
        return {"ok": True}

    # ── PONTO DE EXTENSÃO ──
    # É aqui que a lógica de negócio entra depois de já termos telefone + mensagem
    # normalizados. Hoje isso cai direto no fluxo de qualificação de lead.
    try:
        await _tratar_lead(dados["telefone"], mensagem)
    except Exception as e:
        print(f"[webhook] erro: {e}")

    return {"ok": True}


def _buscar_usuario_whatsapp():
    """Conta dona do numero de WhatsApp conectado hoje (uma unica instancia
    compartilhada). Usa WHATSAPP_USUARIO_EMAIL se configurado; senão cai no
    primeiro usuário cadastrado (comportamento antigo, so como fallback)."""
    if WHATSAPP_USUARIO_EMAIL:
        res = supabase.from_("usuarios").select("id,escritorio").eq("email", WHATSAPP_USUARIO_EMAIL).execute()
        if res.data:
            return res.data[0]
        print(f"[webhook] WHATSAPP_USUARIO_EMAIL={WHATSAPP_USUARIO_EMAIL!r} não encontrado — usando fallback")
    res = supabase.from_("usuarios").select("id,escritorio").limit(1).execute()
    return res.data[0] if res.data else None


async def _tratar_lead(telefone: str, mensagem: str):
    from app.services import lead_engine, handoff
    try:
        usuario = _buscar_usuario_whatsapp()
        if not usuario:
            return
        usuario_id = usuario["id"]
        escritorio = usuario.get("escritorio", "nosso escritório")

        lead = lead_engine.buscar_ou_criar_lead(telefone, usuario_id)
        if not lead:
            return

        if lead.get("status") in ("fechado", "perdido"):
            return

        lead_engine.salvar_mensagem_lead(lead["id"], "cliente", mensagem)

        campos_reset = {}
        if lead.get("follow_up_enviado"):
            campos_reset["follow_up_enviado"] = False
        if campos_reset:
            lead_engine.atualizar_lead(lead["id"], campos_reset)

        if lead.get("atendimento_humano"):
            # advogado assumiu essa conversa — só registra a mensagem, IA não responde
            print(f"[lead] {telefone} em atendimento humano, IA nao respondeu")
            return

        historico = lead_engine.buscar_historico_lead(lead["id"])
        resultado = await lead_engine.processar_mensagem_lead(lead, mensagem, historico, escritorio)

        updates = resultado["updates"]
        if updates:
            lead_engine.atualizar_lead(lead["id"], updates)

        await enviar_whatsapp(telefone, resultado["resposta"])
        lead_engine.salvar_mensagem_lead(lead["id"], "bot", resultado["resposta"])

        nome_atual = updates.get("nome", lead.get("nome"))
        area_atual = updates.get("area", lead.get("area"))
        dados_atual = updates.get("dados", lead.get("dados") or {})

        if resultado["urgencia_motivo"]:
            await handoff.notificar_urgente(usuario_id, nome_atual, telefone, area_atual, dados_atual, resultado["urgencia_motivo"])

        if resultado["agendado_label"]:
            await handoff.notificar_qualificado_agendado(usuario_id, nome_atual, telefone, area_atual, dados_atual, resultado["agendado_label"])

        print(f"[lead] {telefone} etapa={updates.get('etapa', lead.get('etapa'))}")
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


@router.get("/zapi/status")
async def zapi_status():
    """Verifica se a instância Z-API está conectada (útil pra validar as
    credenciais sem precisar enviar mensagem nenhuma)."""
    from app.services import zapi_service
    try:
        return await zapi_service.get_status()
    except zapi_service.ZAPIError as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=502, detail=str(e))
