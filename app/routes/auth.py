from fastapi import APIRouter, HTTPException, Request
from app.schemas import CadastroBody, LoginBody
from app.database import supabase
from app.security import hash_senha, verificar_senha, _e_hash_bcrypt, checar_rate_limit, limpar_rate_limit

router = APIRouter(prefix="/auth")


@router.post("/cadastro")
async def cadastro(body: CadastroBody):
    if not body.nome or not body.email or not body.senha or not body.escritorio:
        raise HTTPException(status_code=400, detail="Preencha todos os campos.")
    if len(body.senha) < 6:
        raise HTTPException(status_code=400, detail="Senha deve ter mínimo 6 caracteres.")
    try:
        existe = supabase.from_("usuarios").select("id").eq("email", body.email).execute()
        if existe.data:
            raise HTTPException(status_code=400, detail="Email já cadastrado.")
        supabase.from_("usuarios").insert({
            "nome": body.nome,
            "email": body.email,
            "senha": hash_senha(body.senha),
            "escritorio": body.escritorio,
        }).execute()
        return {"sucesso": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
async def login(body: LoginBody, request: Request):
    if not body.email or not body.senha:
        raise HTTPException(status_code=400, detail="Preencha todos os campos.")

    ip = request.client.host if request.client else "unknown"
    if checar_rate_limit(ip):
        raise HTTPException(status_code=429, detail="Muitas tentativas. Aguarde 1 minuto.")

    try:
        res = supabase.from_("usuarios").select("*").eq("email", body.email).single().execute()
        if not res.data:
            raise HTTPException(status_code=401, detail="Email ou senha incorretos.")

        d = res.data
        senha_salva = d.get("senha", "")

        if not verificar_senha(body.senha, senha_salva):
            raise HTTPException(status_code=401, detail="Email ou senha incorretos.")

        # migração automática: senha em texto puro → hash
        if not _e_hash_bcrypt(senha_salva) and not senha_salva.startswith("sha256:"):
            try:
                supabase.from_("usuarios").update(
                    {"senha": hash_senha(body.senha)}
                ).eq("id", d["id"]).execute()
                print(f"[auth] senha de {body.email} migrada para hash")
            except Exception:
                pass

        limpar_rate_limit(ip)
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
            },
        }
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail="Erro ao fazer login.")
