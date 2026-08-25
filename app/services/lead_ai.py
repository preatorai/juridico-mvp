import json
import httpx
from app.config import OPENAI_KEY
from app.database import supabase

STAGES = {
    "novo": "novo",
    "qualificado": "qualificado",
    "proposta": "proposta",
    "fechado": "fechado",
    "perdido": "perdido",
}

SYSTEM_QUALIFICACAO = """Você é Lex, assistente jurídico inteligente de um escritório de advocacia. Sua missão é:
1. Recepcionar leads que entram pelo WhatsApp
2. Entender o problema jurídico deles em linguagem simples
3. Qualificar se o caso tem potencial para o escritório
4. Enviar uma proposta de honorários e fechar o contrato

FLUXO:
- Mensagem 1-2: Cumprimentar, perguntar o problema e coletar informações básicas (nome completo, tipo de caso)
- Mensagem 3-4: Aprofundar o caso, mostrar empatia, demonstrar expertise
- Mensagem 5: Se qualificado → enviar proposta com valor e condições. Se não qualificado → dispensar educadamente
- Mensagem 6+: Responder objeções e fechar o contrato

REGRAS ABSOLUTAS:
- NUNCA diga para procurar outro escritório ou ir pessoalmente ao escritório
- NUNCA peça documentos neste momento
- Linguagem acolhedora, simples, sem juridiquês
- Respostas curtas (máximo 4 linhas)
- Ao enviar proposta, seja direto com o valor e condições de pagamento
- Se o lead aceitar a proposta, confirmar o fechamento e informar os próximos passos

ANÁLISE DE STATUS (retornar no JSON):
- "novo" → ainda coletando informações
- "qualificado" → caso tem potencial, pronto para proposta
- "proposta" → proposta enviada, aguardando resposta
- "fechado" → lead aceitou, contrato fechado
- "perdido" → lead desistiu, sem potencial, ou caso fora da área do escritório

RESPONDA SEMPRE EM JSON com esta estrutura:
{"mensagem": "texto para enviar ao lead", "status": "novo|qualificado|proposta|fechado|perdido", "area": "trabalhista|civil|criminal|família|previdenciário|consumidor|outro", "resumo": "resumo do caso em 1 linha"}"""


async def processar_mensagem_lead(
    lead_id: str,
    mensagem: str,
    historico: list,
    escritorio: str,
    nome_lead: str | None = None,
) -> dict:
    messages = []
    for h in historico[-10:]:
        role = "assistant" if h.get("remetente") == "bot" else "user"
        messages.append({"role": role, "content": h["conteudo"]})
    messages.append({"role": "user", "content": mensagem})

    system = SYSTEM_QUALIFICACAO.replace("um escritório de advocacia", f"o escritório {escritorio}")
    if nome_lead:
        system += f"\n\nNome do lead: {nome_lead}"

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                "https://api.openai.com/v1/chat/completions",
                json={
                    "model": "gpt-4o-mini",
                    "temperature": 0.3,
                    "max_tokens": 600,
                    "response_format": {"type": "json_object"},
                    "messages": [{"role": "system", "content": system}] + messages,
                },
                headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            )
        data = r.json()["choices"][0]["message"]["content"]
        result = json.loads(data)
        return {
            "mensagem": result.get("mensagem", "Olá! Em que posso ajudar?"),
            "status": result.get("status", "novo"),
            "area": result.get("area", "outro"),
            "resumo": result.get("resumo", ""),
        }
    except Exception as e:
        print(f"[lead-ai] erro: {e}")
        return {
            "mensagem": "Olá! Recebemos sua mensagem. Em que posso te ajudar?",
            "status": "novo",
            "area": "outro",
            "resumo": "",
        }


def atualizar_lead(lead_id: str, updates: dict):
    try:
        supabase.from_("leads").update(updates).eq("id", lead_id).execute()
    except Exception as e:
        print(f"[lead-ai] erro ao atualizar: {e}")


def salvar_mensagem_lead(lead_id: str, remetente: str, conteudo: str):
    try:
        supabase.from_("mensagens_leads").insert({
            "lead_id": lead_id,
            "remetente": remetente,
            "conteudo": conteudo,
        }).execute()
    except Exception as e:
        print(f"[lead-ai] erro ao salvar msg: {e}")


def buscar_historico_lead(lead_id: str) -> list:
    try:
        res = supabase.from_("mensagens_leads").select("remetente,conteudo,criado_em") \
            .eq("lead_id", lead_id).order("criado_em").limit(20).execute()
        return res.data or []
    except Exception:
        return []


def buscar_ou_criar_lead(telefone: str, usuario_id: str) -> dict | None:
    try:
        res = supabase.from_("leads").select("*") \
            .eq("telefone", telefone).eq("usuario_id", usuario_id).execute()
        if res.data:
            return res.data[0]
        novo = supabase.from_("leads").insert({
            "telefone": telefone,
            "usuario_id": usuario_id,
            "status": "novo",
        }).execute()
        return novo.data[0] if novo.data else None
    except Exception as e:
        print(f"[lead-ai] erro buscar/criar lead: {e}")
        return None
