from datetime import datetime, timezone
from fastapi import APIRouter, Query, HTTPException
from app.database import supabase
from app.services.whatsapp import enviar_whatsapp

router = APIRouter()


@router.get("/leads")
async def listar_leads(usuario_id: str = Query(...)):
    try:
        res = supabase.from_("leads").select("*") \
            .eq("usuario_id", usuario_id).order("criado_em", desc=True).execute()
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/leads/{lead_id}")
async def atualizar_lead(lead_id: str, body: dict):
    campos_permitidos = {"status", "nome", "area", "resumo", "score", "notas", "atendimento_humano"}
    updates = {k: v for k, v in body.items() if k in campos_permitidos}
    if not updates:
        raise HTTPException(status_code=400, detail="Nenhum campo válido para atualizar.")
    try:
        res = supabase.from_("leads").update(updates).eq("id", lead_id).select().execute()
        return res.data[0] if res.data else {}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/leads/{lead_id}")
async def deletar_lead(lead_id: str):
    try:
        supabase.from_("mensagens_leads").delete().eq("lead_id", lead_id).execute()
        supabase.from_("leads").delete().eq("id", lead_id).execute()
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/leads/{lead_id}/chat")
async def chat_lead(lead_id: str):
    try:
        res = supabase.from_("mensagens_leads").select("*") \
            .eq("lead_id", lead_id).order("criado_em").execute()
        return res.data or []
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/leads/{lead_id}/mensagem")
async def enviar_mensagem_lead(lead_id: str, body: dict):
    """Advogado manda mensagem manual pro lead — envia de verdade pelo
    WhatsApp, grava no historico certo (mensagens_leads) e marca
    atendimento_humano=true (a IA para de responder automaticamente até
    alguém desmarcar isso — ver PATCH /leads/{id})."""
    conteudo = (body.get("conteudo") or "").strip()
    if not conteudo:
        raise HTTPException(status_code=400, detail="Mensagem vazia.")

    lead_res = supabase.from_("leads").select("id,telefone").eq("id", lead_id).single().execute()
    if not lead_res.data:
        raise HTTPException(status_code=404, detail="Lead não encontrado.")
    telefone = lead_res.data["telefone"]

    try:
        await enviar_whatsapp(telefone, conteudo)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Erro ao enviar pelo WhatsApp: {e}")

    supabase.from_("mensagens_leads").insert({
        "lead_id": lead_id, "remetente": "advogado", "conteudo": conteudo,
    }).execute()
    supabase.from_("leads").update({
        "atendimento_humano": True,
        "atualizado_em": datetime.now(timezone.utc).isoformat(),
    }).eq("id", lead_id).execute()

    return {"sucesso": True}


@router.get("/leads/metrics")
async def metrics_leads(usuario_id: str = Query(...)):
    try:
        res = supabase.from_("leads").select("status").eq("usuario_id", usuario_id).execute()
        leads = res.data or []
        contagem = {"novo": 0, "qualificado": 0, "proposta": 0, "fechado": 0, "perdido": 0}
        for l in leads:
            s = l.get("status", "novo")
            if s in contagem:
                contagem[s] += 1
        total = len(leads)
        fechados = contagem["fechado"]
        taxa = round((fechados / total * 100) if total > 0 else 0, 1)
        return {"total": total, "por_status": contagem, "taxa_conversao": taxa}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
