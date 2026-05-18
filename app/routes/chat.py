import json
import asyncio
import re
import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from app.schemas import ChatBody
from app.database import supabase
from app.config import OPENAI_KEY

router = APIRouter()

_PROCESSO_RE = re.compile(
    r"processo|moviment|prazo|audiên|decisão|sentença|recurso|andament|atualiz|"
    r"aconteceu|novidade|status|como está|como tá|teve|última|ultimo|recente|"
    r"passou|ocorreu|andou",
    re.IGNORECASE,
)

_ENVIO_RE = re.compile(
    r"manda|envia|notifica|avisa|comunica|fala para|fala pra|mande|envie",
    re.IGNORECASE,
)


def _pergunta_sobre_processo(msg: str) -> bool:
    return bool(_PROCESSO_RE.search(msg))


def _detectar_intencao_envio(msg: str) -> bool:
    return bool(_ENVIO_RE.search(msg))


def _encontrar_clientes_mencionados(pergunta: str, processos: list) -> list:
    p = pergunta.lower()
    encontrados = [
        proc for proc in processos
        if any(parte.lower() in p for parte in proc["nome_cliente"].split() if len(parte) > 3)
    ]
    return encontrados if encontrados else processos


async def _stream_openai(messages: list, system: str):
    payload = {
        "model": "gpt-4o-mini",
        "stream": True,
        "messages": [{"role": "system", "content": system}] + messages,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            json=payload,
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
        ) as resp:
            buf = ""
            async for chunk in resp.aiter_text():
                buf += chunk
                while "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    line = line.strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        return
                    try:
                        token = json.loads(data)["choices"][0].get("delta", {}).get("content", "")
                        if token:
                            yield token
                    except Exception:
                        pass


@router.post("/chat-advogado")
async def chat_advogado(body: ChatBody):
    if not body.usuario_id or not body.pergunta:
        raise HTTPException(status_code=400, detail="Campos obrigatórios.")

    query = supabase.from_("processos").select("*").eq("usuario_id", body.usuario_id)
    if body.processo_id:
        query = query.eq("id", body.processo_id)
    procs_res = query.execute()
    processos = procs_res.data or []

    if not processos:
        async def _sem_processos():
            yield 'data: ' + json.dumps({"token": "Nenhum processo cadastrado ainda."}) + "\n\n"
            yield 'data: ' + json.dumps({"done": True, "mensagens_pendentes": []}) + "\n\n"
        return StreamingResponse(_sem_processos(), media_type="text/event-stream")

    usu_res = supabase.from_("usuarios").select("escritorio,nome").eq("id", body.usuario_id).single().execute()
    escritorio = usu_res.data.get("escritorio", "nosso escritório") if usu_res.data else "nosso escritório"
    nome_adv = usu_res.data.get("nome", "Advogado") if usu_res.data else "Advogado"

    processos_alvo = _encontrar_clientes_mencionados(body.pergunta, processos)[:3]
    dados = list(processos_alvo)

    pergunta_sobre = _pergunta_sobre_processo(body.pergunta)
    intencao_envio = _detectar_intencao_envio(body.pergunta)

    if pergunta_sobre and not intencao_envio:
        from app.services.codilo import buscar_movimentacoes_cache
        contexto_movs = ""
        for p in dados:
            contexto_movs += f"Cliente: {p['nome_cliente']}\n"
            movs = await buscar_movimentacoes_cache(p["numero_processo"])
            if movs:
                contexto_movs += "Últimas 3 movimentações:\n"
                for i, m in enumerate(movs[:3], 1):
                    contexto_movs += f"{i}. {m['nome']} — {m['data']}\n"
            else:
                contexto_movs += "DADOS_INDISPONÍVEIS: não foi possível consultar o tribunal agora.\n"

        system = (
            f"Você é Lex, assistente jurídico do escritório {escritorio}. Está respondendo ao ADVOGADO.\n\n"
            "AO MOSTRAR MOVIMENTAÇÕES, use este formato simples e direto:\n\n"
            "1. *DD/MM/AAAA — Nome da Movimentação*: Uma frase explicando o que foi e o que fazer agora.\n\n"
            "REGRAS:\n"
            "- Respostas curtas e diretas — máximo 5 linhas\n"
            "- Linguagem objetiva, sem enrolação\n"
            "- Se tiver prazo urgente, destaque com ⚠️\n"
            "- Nunca diga para verificar em portais externos\n"
            "- Se aparecer DADOS_INDISPONÍVEIS: informe que não foi possível consultar o tribunal agora\n\n"
            f"PROCESSOS:\n{contexto_movs}"
        )

        async def _sse_movs():
            async for token in _stream_openai([{"role": "user", "content": body.pergunta}], system):
                yield "data: " + json.dumps({"token": token}) + "\n\n"
            yield "data: " + json.dumps({"done": True, "mensagens_pendentes": []}) + "\n\n"

        return StreamingResponse(_sse_movs(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})

    contexto = ""
    if intencao_envio:
        from app.services.codilo import buscar_movimentacoes_cache
        contexto = "Processos do escritório:\n"
        for p in dados:
            contexto += f"\nProcesso {p['numero_processo']} — Cliente: {p['nome_cliente']}\n"
            movs = await buscar_movimentacoes_cache(p["numero_processo"])
            if movs:
                contexto += "Movimentações:\n"
                for m in movs[:3]:
                    contexto += f"- {m['nome']} ({m['data']})\n"
            else:
                contexto += "DADOS_INDISPONÍVEIS: não foi possível consultar o tribunal agora.\n"

    system_geral = (
        f"Você é Lex, assistente jurídico especializado do escritório {escritorio}, auxiliando o advogado {nome_adv}. "
        "Os processos já estão identificados — NUNCA peça número de processo ou qualquer dado de identificação.\n\n"
        "SEU PERFIL:\n"
        "- Conhecimento profundo em todas as áreas do direito brasileiro: civil, trabalhista, criminal, tributário, previdenciário, família, consumidor, administrativo e constitucional\n"
        "- Domínio do CPC, CLT, CC, CP, CDC e demais legislações vigentes\n"
        "- Capacidade de redigir peças, notificações e mensagens profissionais\n\n"
        "COMO RESPONDER:\n"
        "- NUNCA mencione o número do processo — refira-se sempre pelo nome do cliente\n"
        "- NUNCA diga para verificar no portal do tribunal ou em sistemas externos\n"
        "- Para dúvidas jurídicas: responda com profundidade técnica, cite artigos de lei e jurisprudência relevante\n"
        "- Se aparecer DADOS_INDISPONÍVEIS: informe que não foi possível consultar o tribunal agora e oriente o advogado a tentar novamente em instantes\n\n"
        + contexto
    )

    resposta_final = []

    async def _sse_geral():
        async for token in _stream_openai([{"role": "user", "content": body.pergunta}], system_geral):
            resposta_final.append(token)
            yield "data: " + json.dumps({"token": token}) + "\n\n"

        mensagens_pendentes = []
        if intencao_envio:
            alvo = _encontrar_clientes_mencionados(body.pergunta, dados)
            for proc in alvo:
                ctx_cli = f"Processo {proc['numero_processo']}:\nSem movimentações recentes.\n"
                try:
                    async with httpx.AsyncClient(timeout=15) as client:
                        r = await client.post(
                            "https://api.openai.com/v1/chat/completions",
                            json={
                                "model": "gpt-4o-mini",
                                "messages": [
                                    {"role": "system", "content": f"Você é um assistente do escritório {escritorio}. Escreva uma mensagem de WhatsApp para o cliente {proc['nome_cliente']} em linguagem simples e amigável. Máximo 5 linhas."},
                                    {"role": "user", "content": f"Novidades: {ctx_cli}"},
                                ]
                            },
                            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
                        )
                    msg_cli = r.json()["choices"][0]["message"]["content"]
                    mensagens_pendentes.append({
                        "nome_cliente": proc["nome_cliente"],
                        "telefone_cliente": proc["telefone_cliente"],
                        "mensagem": msg_cli,
                    })
                except Exception as e:
                    print(f"[chat] gerar msg cliente erro: {e}")

        yield "data: " + json.dumps({"done": True, "mensagens_pendentes": mensagens_pendentes}) + "\n\n"

    return StreamingResponse(_sse_geral(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})
