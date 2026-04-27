import asyncio
from fastapi import APIRouter, Query, HTTPException
from app.schemas import ProcessoBody
from app.database import supabase
from app.services.codilo import buscar_codilo, salvar_cache, buscar_movimentacoes_cache, normalizar_cnj
from app.config import OPENAI_KEY
import httpx

router = APIRouter()


@router.post("/processos")
async def cadastrar_processo(body: ProcessoBody):
    if not body.usuario_id:
        raise HTTPException(status_code=400, detail="usuario_id obrigatorio.")
    res = supabase.from_("processos").insert({
        "numero_processo": body.numero_processo,
        "nome_cliente": body.nome_cliente,
        "telefone_cliente": body.telefone_cliente,
        "usuario_id": body.usuario_id,
    }).execute()
    if not res.data:
        raise HTTPException(status_code=400, detail="Erro ao cadastrar processo.")

    try:
        usu = supabase.from_("usuarios").select("escritorio").eq("id", body.usuario_id).single().execute()
        escritorio = usu.data.get("escritorio", "nosso escritório") if usu.data else "nosso escritório"
        from app.services.whatsapp import enviar_whatsapp
        msg = (
            f"Olá, {body.nome_cliente}! 👋\n\n"
            f"Seu processo foi cadastrado no sistema do escritório *{escritorio}*.\n\n"
            "✅ A partir de agora você receberá atualizações automáticas sempre que houver movimentação no seu processo.\n\n"
            "💬 Qualquer dúvida é só me perguntar aqui mesmo!\n\n"
            "_Sistema Praetor AI_"
        )
        await enviar_whatsapp(body.telefone_cliente, msg)
    except Exception as e:
        print(f"[boas-vindas] erro: {e}")

    asyncio.create_task(_prewarm(body.numero_processo))
    return {"sucesso": True, "data": res.data}


async def _prewarm(numero: str):
    try:
        num = normalizar_cnj(numero)
        print(f"[cache-prewarm] iniciando busca para {num}")
        movs = await buscar_codilo(num)
        if movs:
            await salvar_cache(num, movs)
            print(f"[cache-prewarm] ✅ {num} — {len(movs)} movimentações salvas")
        else:
            print(f"[cache-prewarm] ⚠ {num} — sem dados no momento")
    except Exception as e:
        print(f"[cache-prewarm] erro: {e}")


@router.get("/processos")
async def listar_processos(usuario_id: str = Query(...)):
    try:
        res = supabase.from_("processos").select("*").eq("usuario_id", usuario_id).execute()
        return res.data or []
    except Exception:
        raise HTTPException(status_code=500, detail="Erro ao buscar processos.")


@router.get("/movimentacoes")
async def listar_movimentacoes(usuario_id: str = Query(None)):
    if not usuario_id:
        return []
    try:
        procs = supabase.from_("processos").select("id").eq("usuario_id", usuario_id).execute()
        if not procs.data:
            return []
        ids = [p["id"] for p in procs.data]
        res = supabase.from_("movimentacoes").select("*, processos(nome_cliente, numero_processo)").in_(
            "processo_id", ids).order("detectado_em", desc=True).limit(20).execute()
        return res.data or []
    except Exception:
        return []


@router.get("/processos/resumo")
async def resumo_processos(usuario_id: str = Query(...)):
    try:
        procs_res = supabase.from_("processos").select("*").eq("usuario_id", usuario_id).execute()
        processos = procs_res.data or []
        if not processos:
            return []
        numeros = [normalizar_cnj(p["numero_processo"]) for p in processos]
        cache_res = supabase.from_("cache_movimentos").select("numero_processo,movimentos").in_("numero_processo", numeros).execute()
        cache_map = {row["numero_processo"]: (row["movimentos"] or []) for row in (cache_res.data or [])}
        result = []
        for p in processos:
            cnj = normalizar_cnj(p["numero_processo"])
            movs = cache_map.get(cnj, [])
            result.append({**p, "ultimas_movimentacoes": movs[:2]})
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/processos/{numero}/detalhes")
async def detalhes_processo(numero: str):
    from urllib.parse import unquote
    numero = unquote(numero)
    from app.services.codilo import detectar_tribunal
    tribunal = detectar_tribunal(numero)
    try:
        from app.services.codilo import buscar_movimentacoes_cache
        movs = await buscar_movimentacoes_cache(numero)
        if not movs:
            return {"capa": {}, "partes": [], "movimentacoes": []}

        anos_visiveis = [str(2024 - i) for i in range(5)]
        filtradas = [m for m in movs if m.get("data") and any(a in m["data"] for a in anos_visiveis)]
        movs_final = filtradas if filtradas else movs

        unicos = list(dict.fromkeys(m["nome"] for m in movs_final))[:25]
        explicacoes = {}
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    json={
                        "model": "gpt-4o-mini",
                        "max_tokens": 1200,
                        "messages": [
                            {"role": "system", "content": "Você é um assistente jurídico brasileiro. Para cada movimentação listada, escreva um parágrafo de 2 a 3 frases explicando o que significa e qual o impacto para o processo, em linguagem simples para leigos. Responda APENAS em JSON válido: {\"nome da movimentação\": \"explicação\"}. Nada fora do JSON."},
                            {"role": "user", "content": "\n".join(unicos)}
                        ]
                    },
                    headers={"Authorization": f"Bearer {OPENAI_KEY}"}
                )
            import re, json
            match = re.search(r'\{[\s\S]*\}', r.json()["choices"][0]["message"]["content"])
            if match:
                explicacoes = json.loads(match.group())
        except Exception as e:
            print(f"[explicar] {e}")

        return {
            "capa": {},
            "partes": [],
            "movimentacoes": [{**m, "resumo": explicacoes.get(m["nome"], "")} for m in movs_final]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/processos/explicar")
async def explicar_movimentos(body: dict):
    movimentos = body.get("movimentos", [])
    if not movimentos:
        return {}
    unicos = list(dict.fromkeys(movimentos))[:25]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json={
                    "model": "gpt-4o-mini",
                    "max_tokens": 600,
                    "messages": [
                        {"role": "system", "content": "Você é um assistente jurídico brasileiro. Para cada movimentação processual listada, escreva UMA frase curta (máximo 12 palavras) explicando o que significa em linguagem simples para leigos. Responda APENAS em JSON válido no formato: {\"nome exato da movimentação\": \"explicação simples\"}. Não inclua nada fora do JSON."},
                        {"role": "user", "content": "\n".join(unicos)}
                    ]
                },
                headers={"Authorization": f"Bearer {OPENAI_KEY}"}
            )
        import re, json
        content = r.json()["choices"][0]["message"]["content"]
        match = re.search(r'\{[\s\S]*\}', content)
        return json.loads(match.group()) if match else {}
    except Exception as e:
        print(f"[explicar] {e}")
        return {}


@router.get("/debug-processo/{numero}")
async def debug_processo(numero: str):
    from urllib.parse import unquote
    numero = unquote(numero)
    from app.services.codilo import detectar_tribunal
    tribunal = detectar_tribunal(numero)
    cache_row = None
    try:
        row = supabase.from_("cache_movimentos").select("movimentos,atualizado_em").eq("numero_processo", numero).single().execute()
        if row.data:
            cache_row = {"total": len(row.data.get("movimentos") or []), "atualizado_em": row.data.get("atualizado_em")}
    except Exception:
        pass
    movs = await buscar_codilo(numero)
    return {
        "numero": numero, "tribunal": tribunal,
        "cache_db": cache_row,
        "codilo_agora": {"total": len(movs), "movimentacoes": movs[:3]}
    }
