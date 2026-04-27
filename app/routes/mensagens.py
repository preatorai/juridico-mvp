from fastapi import APIRouter, Query, HTTPException
from app.schemas import MensagemEnviarBody
from app.database import supabase
from app.services.whatsapp import enviar_whatsapp

router = APIRouter(prefix="/mensagens")


@router.get("/conversas")
async def listar_conversas(usuario_id: str = Query(None)):
    if not usuario_id:
        return []
    try:
        res = supabase.from_("mensagens").select("*").eq("usuario_id", usuario_id).order("criado_em", desc=True).execute()
        if not res.data:
            return []
        seen = set()
        conversas = []
        for msg in res.data:
            if msg["telefone"] not in seen:
                seen.add(msg["telefone"])
                conversas.append(msg)
        return conversas
    except Exception:
        return []


@router.get("/conversa")
async def historico_conversa(usuario_id: str = Query(None), telefone: str = Query(None)):
    if not usuario_id or not telefone:
        return []
    try:
        res = supabase.from_("mensagens").select("*").eq("usuario_id", usuario_id).eq("telefone", telefone).order("criado_em", desc=False).execute()
        return res.data or []
    except Exception:
        return []


@router.post("/enviar")
async def enviar_mensagem(body: MensagemEnviarBody):
    if not body.usuario_id or not body.telefone or not body.conteudo:
        raise HTTPException(status_code=400, detail="Campos obrigatórios.")
    try:
        nums = body.telefone.replace("-", "").replace(" ", "").replace("(", "").replace(")", "")
        nums = "".join(c for c in nums if c.isdigit())
        fone = nums if nums.startswith("55") else "55" + nums
        print(f"[enviar] telefone recebido: {body.telefone} → normalizado: {fone}")
        await enviar_whatsapp(fone, body.conteudo)
        supabase.from_("mensagens").insert({
            "usuario_id": body.usuario_id,
            "telefone": fone,
            "nome_cliente": body.nome_cliente or "Cliente",
            "remetente": "advogado",
            "conteudo": body.conteudo,
        }).execute()
        return {"sucesso": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
