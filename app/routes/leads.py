from fastapi import APIRouter, Query, HTTPException
from app.database import supabase

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
    campos_permitidos = {"status", "nome", "area", "resumo", "score", "notas"}
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
