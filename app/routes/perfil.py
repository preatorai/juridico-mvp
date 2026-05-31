from fastapi import APIRouter, HTTPException
from app.schemas import TelefoneBody, EscritorioBody, PerfilConfigBody, SenhaBody
from app.database import supabase
from pydantic import BaseModel
from typing import Optional

class AgenteConfigBody(BaseModel):
    usuario_id: str
    agente_nome: Optional[str] = None
    agente_tom: Optional[str] = None
    agente_detalhe: Optional[str] = None
    agente_instrucoes: Optional[str] = None

router = APIRouter(prefix="/perfil")


@router.post("/telefone")
async def atualizar_telefone(body: TelefoneBody):
    if not body.usuario_id or not body.telefone:
        raise HTTPException(status_code=400, detail="Campos obrigatórios.")
    res = supabase.from_("usuarios").update({"telefone": body.telefone}).eq("id", body.usuario_id).execute()
    return {"sucesso": True}


@router.post("/escritorio")
async def atualizar_escritorio(body: EscritorioBody):
    if not body.usuario_id or not body.escritorio:
        raise HTTPException(status_code=400, detail="Campos obrigatórios.")
    supabase.from_("usuarios").update({"escritorio": body.escritorio}).eq("id", body.usuario_id).execute()
    return {"sucesso": True}


@router.post("/config")
async def atualizar_config(body: PerfilConfigBody):
    if not body.usuario_id:
        raise HTTPException(status_code=400, detail="usuario_id obrigatório.")
    campos = {}
    if body.telefone is not None:
        campos["telefone"] = body.telefone
    if body.horario_alerta is not None:
        campos["horario_alerta"] = body.horario_alerta
    if body.tipos_alerta is not None:
        campos["tipos_alerta"] = body.tipos_alerta
    if body.escritorio is not None:
        campos["escritorio"] = body.escritorio
    if body.oab is not None:
        campos["oab"] = body.oab
    if body.estado is not None:
        campos["estado"] = body.estado
    if not campos:
        raise HTTPException(status_code=400, detail="Nenhum campo para atualizar.")
    supabase.from_("usuarios").update(campos).eq("id", body.usuario_id).execute()
    return {"sucesso": True}


@router.get("/agente")
async def obter_agente(usuario_id: str):
    res = supabase.from_("usuarios").select("agente_nome,agente_tom,agente_detalhe,agente_instrucoes").eq("id", usuario_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    return res.data


@router.post("/agente")
async def salvar_agente(body: AgenteConfigBody):
    if not body.usuario_id:
        raise HTTPException(status_code=400, detail="usuario_id obrigatório.")
    campos = {}
    if body.agente_nome is not None:
        campos["agente_nome"] = body.agente_nome
    if body.agente_tom is not None:
        campos["agente_tom"] = body.agente_tom
    if body.agente_detalhe is not None:
        campos["agente_detalhe"] = body.agente_detalhe
    if body.agente_instrucoes is not None:
        campos["agente_instrucoes"] = body.agente_instrucoes
    if not campos:
        raise HTTPException(status_code=400, detail="Nenhum campo para atualizar.")
    supabase.from_("usuarios").update(campos).eq("id", body.usuario_id).execute()
    return {"sucesso": True}


@router.post("/senha")
async def atualizar_senha(body: SenhaBody):
    if not body.usuario_id or not body.senha_atual or not body.senha_nova:
        raise HTTPException(status_code=400, detail="Campos obrigatórios.")
    if len(body.senha_nova) < 6:
        raise HTTPException(status_code=400, detail="Nova senha deve ter mínimo 6 caracteres.")
    from app.security import hash_senha, verificar_senha
    res = supabase.from_("usuarios").select("senha").eq("id", body.usuario_id).single().execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Usuário não encontrado.")
    if not verificar_senha(body.senha_atual, res.data.get("senha", "")):
        raise HTTPException(status_code=401, detail="Senha atual incorreta.")
    supabase.from_("usuarios").update({"senha": hash_senha(body.senha_nova)}).eq("id", body.usuario_id).execute()
    return {"sucesso": True}
