import asyncio
from fastapi import APIRouter, Query, HTTPException
from app.schemas import PrazoSincBody
from app.database import supabase
from app.services.codilo import buscar_movimentacoes_cache

router = APIRouter(prefix="/prazos")

PALAVRAS_PRAZO = [
    "prazo", "audiência", "audiencia", "decisão", "decisao",
    "sentença", "sentenca", "intimação", "intimacao", "despacho",
    "julgamento", "recurso", "citação", "citacao", "mandado",
    "penhora", "bloqueio", "concluso", "publicado", "diário", "diario",
]


def detectar_urgencia(descricao: str, data_mov: str) -> str:
    from datetime import datetime
    desc = descricao.lower()
    try:
        partes = data_mov.split("/")
        data_m = datetime(int(partes[2]), int(partes[1]), int(partes[0]))
        diff = (datetime.now() - data_m).days
    except Exception:
        diff = 999
    if any(k in desc for k in ["audiên", "audienc", "sentença", "sentenca", "decisão", "decisao"]):
        return "urgente"
    if diff <= 7:
        return "esta_semana"
    return "normal"


async def sincronizar_prazos(usuario_id: str):
    procs = supabase.from_("processos").select("*").eq("usuario_id", usuario_id).execute()
    if not procs.data:
        return
    for proc in procs.data:
        try:
            movs = await buscar_movimentacoes_cache(proc["numero_processo"])
            importantes = [m for m in movs if any(p in m["nome"].lower() for p in PALAVRAS_PRAZO)]
            for mov in importantes:
                if not mov.get("data") or mov["data"] == "—" or "/" not in mov["data"]:
                    continue
                existe = supabase.from_("prazos").select("id").eq("processo_id", proc["id"]).eq("descricao", mov["nome"]).eq("data_movimentacao", mov["data"]).single().execute()
                if existe.data:
                    continue
                urgencia = detectar_urgencia(mov["nome"], mov["data"])
                supabase.from_("prazos").insert({
                    "processo_id": proc["id"],
                    "usuario_id": usuario_id,
                    "numero_processo": proc["numero_processo"],
                    "nome_cliente": proc["nome_cliente"],
                    "descricao": mov["nome"],
                    "data_movimentacao": mov["data"],
                    "urgencia": urgencia,
                }).execute()
        except Exception as e:
            print(f"[prazos] {e}")


@router.get("")
async def listar_prazos(usuario_id: str = Query(None)):
    if not usuario_id:
        return []
    res = supabase.from_("prazos").select("*").eq("usuario_id", usuario_id).eq("visto", False).order("criado_em", desc=True).execute()
    asyncio.create_task(sincronizar_prazos(usuario_id))
    return res.data or []


@router.post("/sincronizar")
async def sincronizar(body: PrazoSincBody):
    if not body.usuario_id:
        raise HTTPException(status_code=400, detail="usuario_id obrigatorio")
    try:
        await sincronizar_prazos(body.usuario_id)
        return {"sucesso": True, "mensagem": "Sincronização concluída"}
    except Exception as e:
        print(f"[prazos sync] {e}")
        return {"sucesso": True, "mensagem": "Sincronização concluída com erros"}


@router.post("/{prazo_id}/visto")
async def marcar_visto(prazo_id: str):
    try:
        supabase.from_("prazos").update({"visto": True}).eq("id", prazo_id).execute()
        return {"sucesso": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Erro ao marcar prazo.")
