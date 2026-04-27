from fastapi import APIRouter
from app.schemas import CadastroBody, LoginBody
from app.database import supabase

router = APIRouter(prefix="/auth")


@router.post("/cadastro")
async def cadastro(body: CadastroBody):
    if not body.nome or not body.email or not body.senha or not body.escritorio:
        return {"erro": "Preencha todos os campos."}, 400
    try:
        existe = supabase.from_("usuarios").select("id").eq("email", body.email).single().execute()
        if existe.data:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="Email ja cadastrado.")
        res = supabase.from_("usuarios").insert({
            "nome": body.nome, "email": body.email,
            "senha": body.senha, "escritorio": body.escritorio
        }).execute()
        if res.data is None:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail="Erro ao cadastrar.")
        return {"sucesso": True}
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
async def login(body: LoginBody):
    if not body.email or not body.senha:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="Preencha todos os campos.")
    try:
        res = supabase.from_("usuarios").select("*").eq("email", body.email).eq("senha", body.senha).single().execute()
        if not res.data:
            from fastapi import HTTPException
            raise HTTPException(status_code=401, detail="Email ou senha incorretos.")
        d = res.data
        return {
            "sucesso": True,
            "usuario": {
                "id": d["id"], "nome": d["nome"], "email": d["email"],
                "escritorio": d.get("escritorio", ""),
                "telefone": d.get("telefone", ""),
                "oab": d.get("oab", ""),
                "estado": d.get("estado", ""),
                "horario_alerta": d.get("horario_alerta", "08:00"),
                "tipos_alerta": d.get("tipos_alerta", "urgente,semana"),
            }
        }
    except Exception as e:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail="Erro ao fazer login.")
