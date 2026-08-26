"""
Motor de conversa do atendente virtual do WhatsApp.

Conduz o lead por 4 etapas (acolhimento -> triagem -> qualificacao ->
agendamento -> finalizado) numa única conversa contínua. O modelo (OpenAI,
via function calling) decide o que perguntar e como reagir dentro da etapa
atual, mas é este código — não o modelo — quem decide se pode de fato
avançar de etapa, validando quais campos obrigatórios já foram preenchidos.

Ponto de entrada usado pelo webhook: `processar_mensagem_lead(...)`.
"""
import json
import os
import httpx

from app.config import OPENAI_KEY
from app.database import supabase
from app.services import scheduling, handoff

_MODEL = "gpt-4o-mini"

with open(os.path.join(os.path.dirname(__file__), "..", "data", "areas_direito.json"), encoding="utf-8") as _f:
    _CONFIG = json.load(_f)

ETAPAS = ["acolhimento", "triagem", "qualificacao", "agendamento", "finalizado"]

# campos que têm coluna própria na tabela `leads` — o resto vai pra `dados` (JSON)
_CAMPOS_COLUNA_DIRETA = {"nome_completo": "nome", "resumo_problema": "resumo", "area": "area"}


# ── Config helpers ───────────────────────────────────────────────────────────

def _areas_validas() -> set[str]:
    return {a["id"] for a in _CONFIG["areas"]}


def _campos_pendentes(dados: dict, area: str | None) -> list[dict]:
    pendentes = [q for q in _CONFIG["perguntas_base"] if not dados.get(q["campo"])]
    if area and area in _CONFIG["perguntas_por_area"]:
        pendentes += [q for q in _CONFIG["perguntas_por_area"][area] if not dados.get(q["campo"])]
    return pendentes


# ── Persistência (Supabase) ──────────────────────────────────────────────────

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
            "etapa": "acolhimento",
            "prioridade": "normal",
            "dados": {},
        }).execute()
        return novo.data[0] if novo.data else None
    except Exception as e:
        print(f"[lead-engine] erro buscar/criar lead: {e}")
        return None


def atualizar_lead(lead_id: str, updates: dict):
    from datetime import datetime, timezone
    updates = dict(updates)
    updates["atualizado_em"] = datetime.now(timezone.utc).isoformat()
    try:
        supabase.from_("leads").update(updates).eq("id", lead_id).execute()
    except Exception as e:
        print(f"[lead-engine] erro ao atualizar lead: {e}")


def salvar_mensagem_lead(lead_id: str, remetente: str, conteudo: str):
    try:
        supabase.from_("mensagens_leads").insert({
            "lead_id": lead_id, "remetente": remetente, "conteudo": conteudo,
        }).execute()
    except Exception as e:
        print(f"[lead-engine] erro ao salvar mensagem: {e}")


def buscar_historico_lead(lead_id: str, limite: int = 20) -> list[dict]:
    """Retorna as últimas `limite` mensagens, em ordem cronológica (mais
    antiga primeiro) — pra manter o contexto recente da conversa, não o
    início dela."""
    try:
        res = supabase.from_("mensagens_leads").select("remetente,conteudo,criado_em") \
            .eq("lead_id", lead_id).order("criado_em", desc=True).limit(limite).execute()
        return list(reversed(res.data or []))
    except Exception:
        return []


# ── Tools (function calling) ─────────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "salvar_dado_lead",
            "description": "Salva uma informação que o lead acabou de fornecer durante a conversa.",
            "parameters": {
                "type": "object",
                "properties": {
                    "campo": {"type": "string", "description": "Nome do campo coletado (ex: nome_completo, area, resumo_problema, tempo_ou_prazo, processo_existente, cidade_estado, ou um campo específico da área)."},
                    "valor": {"type": "string", "description": "Valor informado pelo lead."},
                },
                "required": ["campo", "valor"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "avancar_etapa",
            "description": "Solicita avançar para a próxima etapa do atendimento, quando as informações da etapa atual parecerem completas. O sistema valida se realmente pode avançar e responde se faltar algo.",
            "parameters": {
                "type": "object",
                "properties": {"nova_etapa": {"type": "string", "enum": ETAPAS}},
                "required": ["nova_etapa"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "sinalizar_urgencia",
            "description": "Sinaliza prioridade máxima para um advogado humano assumir imediatamente — use para prisão iminente, prazo processual vencendo em poucos dias, violência doméstica em curso, ou situação de risco similar. Pode ser chamada a qualquer momento da conversa, mesmo antes da qualificação terminar.",
            "parameters": {
                "type": "object",
                "properties": {"motivo": {"type": "string", "description": "Breve descrição da urgência."}},
                "required": ["motivo"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "agendar_horario",
            "description": "Confirma o agendamento no horário escolhido pelo lead, dentre os horários oferecidos na etapa de agendamento.",
            "parameters": {
                "type": "object",
                "properties": {"horario_escolhido": {"type": "string", "description": "Identificador exato do horário, igual ao oferecido (ex: '2026-08-27T14:00')."}},
                "required": ["horario_escolhido"],
            },
        },
    },
]


def _validar_avanco(etapa_atual: str, nova_etapa: str, dados: dict, area: str | None) -> tuple[bool, str | None]:
    if nova_etapa not in ETAPAS:
        return False, "etapa inexistente"
    if nova_etapa == "finalizado":
        return False, "etapa 'finalizado' só é definida automaticamente ao confirmar um agendamento (agendar_horario)"

    idx_atual, idx_nova = ETAPAS.index(etapa_atual), ETAPAS.index(nova_etapa)
    if idx_nova <= idx_atual:
        return True, None  # ficar ou voltar é sempre permitido

    if idx_nova > idx_atual + 1:
        return False, "não é possível pular etapas"

    if nova_etapa == "qualificacao" and not area:
        return False, "a área do direito ainda não foi identificada — chame salvar_dado_lead(campo='area', ...) primeiro"

    if nova_etapa == "agendamento":
        pendentes = _campos_pendentes(dados, area)
        if pendentes:
            faltando = ", ".join(p["campo"] for p in pendentes)
            return False, f"ainda faltam campos obrigatórios: {faltando}"

    return True, None


def _auto_avancar(ctx: "_Contexto", teve_historico: bool):
    """Avança a etapa automaticamente quando os requisitos já foram cumpridos.

    Existe pra não depender do modelo lembrar de chamar avancar_etapa — o
    modelo ainda PODE chamar essa tool (fica registrado no comportamento
    esperado), mas o progresso do fluxo não trava se ele não chamar.
    """
    if ctx.etapa == "acolhimento" and teve_historico:
        areas = _CONFIG["areas"]
        if len(areas) == 1 and not ctx.area:
            # só existe uma área configurada — pula a triagem, nem pergunta
            ctx.area = areas[0]["id"]
            ctx.updates["area"] = ctx.area
            ctx.etapa = "qualificacao"
            ctx.updates["etapa"] = "qualificacao"
        else:
            ctx.etapa = "triagem"
            ctx.updates["etapa"] = "triagem"
    if ctx.etapa == "triagem" and ctx.area:
        ctx.etapa = "qualificacao"
        ctx.updates["etapa"] = "qualificacao"
    if ctx.etapa == "qualificacao" and ctx.area and not _campos_pendentes(ctx.dados, ctx.area):
        ctx.etapa = "agendamento"
        ctx.updates["etapa"] = "agendamento"


class _Contexto:
    def __init__(self, lead: dict):
        self.lead_id = lead["id"]
        self.telefone = lead["telefone"]
        self.usuario_id = lead["usuario_id"]
        self.etapa = lead.get("etapa") or "acolhimento"
        self.area = lead.get("area")
        self.dados = dict(lead.get("dados") or {})
        self.nome = lead.get("nome")
        self.horario_agendado = lead.get("horario_agendado")
        self.updates: dict = {}
        self.urgencia_motivo: str | None = None
        self.agendado_label: str | None = None


def _executar_tool(nome_tool: str, args: dict, ctx: _Contexto) -> dict:
    if nome_tool == "salvar_dado_lead":
        campo, valor = args.get("campo"), args.get("valor")
        if not campo or valor in (None, ""):
            return {"ok": False, "erro": "campo ou valor ausente"}

        if campo == "area":
            if valor not in _areas_validas():
                return {"ok": False, "erro": f"área desconhecida. Áreas válidas: {sorted(_areas_validas())}"}
            ctx.area = valor
            ctx.updates["area"] = valor
        elif campo == "nome_completo":
            ctx.nome = valor
            ctx.updates["nome"] = valor
            ctx.dados[campo] = valor
        elif campo == "resumo_problema":
            ctx.updates["resumo"] = valor
            ctx.dados[campo] = valor
        else:
            ctx.dados[campo] = valor
        ctx.updates["dados"] = ctx.dados
        return {"ok": True}

    if nome_tool == "avancar_etapa":
        nova = args.get("nova_etapa", "")
        ok, motivo = _validar_avanco(ctx.etapa, nova, ctx.dados, ctx.area)
        if ok:
            ctx.etapa = nova
            ctx.updates["etapa"] = nova
            return {"ok": True, "etapa_atual": nova}
        return {"ok": False, "motivo": motivo}

    if nome_tool == "sinalizar_urgencia":
        ctx.urgencia_motivo = args.get("motivo") or "não especificado"
        ctx.updates["prioridade"] = "urgente"
        return {"ok": True}

    if nome_tool == "agendar_horario":
        horario = args.get("horario_escolhido", "")
        try:
            reserva = scheduling.book_slot(ctx.lead_id, ctx.telefone, horario)
        except ValueError as e:
            disponiveis = [s["id"] for s in scheduling.get_available_slots(ctx.area)]
            return {"ok": False, "erro": str(e), "horarios_disponiveis": disponiveis}
        ctx.etapa = "finalizado"
        ctx.updates["etapa"] = "finalizado"
        ctx.updates["status"] = "qualificado"
        ctx.updates["horario_agendado"] = reserva["inicio"]
        ctx.agendado_label = reserva["label"]
        return {"ok": True, "confirmado": reserva}

    return {"ok": False, "erro": "tool desconhecida"}


# ── Prompt ────────────────────────────────────────────────────────────────────

def _montar_system_prompt(escritorio: str, ctx: _Contexto) -> str:
    areas = _CONFIG["areas"]
    area_unica = areas[0]["id"] if len(areas) == 1 else None
    partes = [
        f"Você é o assistente virtual de recepção do escritório {escritorio}, atendendo pelo WhatsApp.",
        "Você NÃO é advogado e NUNCA deve dar a entender que é uma pessoa ou um advogado. Se perguntarem, "
        "deixe claro que é um atendimento inicial automatizado do escritório.",
        "",
        "FLUXO (conduza como uma conversa natural, não como formulário — uma ou duas perguntas por vez):",
        "1. Acolhimento: cumprimente, se apresente, pergunte brevemente o que a pessoa precisa.",
    ]
    if area_unica:
        partes.append(f"2. Qualificação: o escritório atende só a área {area_unica} — colete as informações pendentes listadas abaixo, aos poucos.")
        partes.append("3. Agendamento: com tudo coletado, ofereça os horários disponíveis e confirme a escolha.")
    else:
        areas_lista = ", ".join(f"{a['id']} ({a['label']})" for a in areas)
        partes.append(f"2. Triagem: identifique a área do direito entre: {areas_lista}. Ao identificar, chame "
                       "salvar_dado_lead(campo='area', valor=<id da área, ex: 'trabalhista'>).")
        partes.append("3. Qualificação: colete as informações pendentes listadas abaixo, aos poucos.")
        partes.append("4. Agendamento: com tudo coletado, ofereça os horários disponíveis e confirme a escolha.")

    partes += ["", f"ETAPA ATUAL: {ctx.etapa}"]
    if ctx.area:
        partes.append(f"ÁREA JÁ IDENTIFICADA: {ctx.area}")
    if ctx.dados:
        partes.append(f"JÁ COLETADO — NÃO PERGUNTE DE NOVO NENHUM DESTES: {json.dumps(ctx.dados, ensure_ascii=False)}")

    pendentes = _campos_pendentes(ctx.dados, ctx.area)
    if ctx.area and pendentes:
        lista = "\n".join(f"- {q['campo']}: {q['pergunta']}" for q in pendentes)
        partes.append(
            f"AINDA FALTA COLETAR (pergunte 1 ou 2 por vez, não a lista toda de uma vez):\n{lista}\n\n"
            "ANTES DE PERGUNTAR QUALQUER COISA: releia a ÚLTIMA MENSAGEM do lead (a mais recente do "
            "histórico). Se ela já responde algum dos campos acima — mesmo que de forma indireta ou "
            "misturada com outro assunto — chame salvar_dado_lead PRA CADA CAMPO respondido ANTES de "
            "formular sua resposta, e só então pergunte o que realmente ainda falta. NUNCA repita uma "
            "pergunta sobre um campo que já está em 'JÁ COLETADO' ou que a última mensagem já respondeu."
        )

    if ctx.etapa == "agendamento":
        slots = scheduling.get_available_slots(ctx.area)
        lista = "\n".join(f"- {s['id']}: {s['label']} ({s['tipo']})" for s in slots) or "(nenhum horário livre no momento — avise a pessoa e ofereça retornar em breve)"
        partes.append(f"HORÁRIOS DISPONÍVEIS PRA OFERECER:\n{lista}")
        partes.append("Quando a pessoa escolher, chame agendar_horario(horario_escolhido=<id exato acima>).")

    if ctx.etapa == "finalizado" and ctx.horario_agendado:
        partes.append(
            f"AGENDAMENTO JÁ CONFIRMADO para {ctx.horario_agendado}. Se a pessoa perguntar se está "
            "confirmado, ou perguntar detalhes sobre a reunião, apenas reafirme esse horário em "
            "linguagem natural (ex: dia da semana, horário). NÃO chame agendar_horario de novo — o "
            "agendamento já existe. Responda outras dúvidas normalmente, sem dar aconselhamento jurídico."
        )

    partes += [
        "",
        "REGRAS ABSOLUTAS:",
        "- NUNCA dê aconselhamento jurídico: nada de opinião sobre chance de ganhar a causa, prazo de "
        "prescrição específico, valor de honorários fechado, ou qualquer orientação jurídica de mérito. "
        "Isso é papel do advogado, na reunião. Se perguntarem, diga que será tratado na reunião.",
        "- Se perceber urgência real (prisão iminente, prazo processual vencendo em dias, violência em "
        "curso, risco à integridade de alguém), chame sinalizar_urgencia(motivo) imediatamente — mesmo "
        "no meio da qualificação — e tranquilize a pessoa dizendo que um advogado vai priorizar o caso.",
        "- Mensagens curtas (é WhatsApp, não e-mail). Tom profissional e cordial. Evite parágrafos longos.",
        "- Chame salvar_dado_lead assim que a pessoa informar algo da lista de campos.",
        "- JAMAIS pergunte de novo algo que já está em 'JÁ COLETADO' ou que a pessoa acabou de responder "
        "na última mensagem — isso irrita o lead e passa impressão de desorganização. Releia o que já foi "
        "dito antes de perguntar qualquer coisa.",
        "- Chame avancar_etapa quando achar que a etapa atual está completa — o sistema avisa se faltar algo.",
        "- Ao confirmar um agendamento, resuma os dados coletados e avise que um advogado vai atendê-la(o) "
        "naquele horário.",
    ]
    return "\n".join(partes)


def _historico_para_openai(historico: list[dict], mensagem_atual: str) -> list[dict]:
    msgs = []
    for h in historico[-20:]:
        role = "assistant" if h.get("remetente") == "bot" else "user"
        msgs.append({"role": role, "content": h["conteudo"]})
    msgs.append({"role": "user", "content": mensagem_atual})
    return msgs


# ── Orquestração ──────────────────────────────────────────────────────────────

async def processar_mensagem_lead(lead: dict, mensagem: str, historico: list[dict], escritorio: str) -> dict:
    """Roda o motor de conversa pra uma mensagem recebida.

    Retorna: {"resposta": str, "updates": dict, "urgencia_motivo": str|None, "agendado_label": str|None}
    `updates` já vem pronto pra persistir via atualizar_lead(lead_id, updates).
    """
    ctx = _Contexto(lead)
    _auto_avancar(ctx, teve_historico=bool(historico))
    historico_msgs = _historico_para_openai(historico, mensagem)

    resposta_texto = "Desculpa, tive um problema técnico agora — pode repetir sua última mensagem?"
    ultima_msg_assistente: dict | None = None

    try:
        async with httpx.AsyncClient(timeout=25) as client:
            for _ in range(5):  # limite de idas-e-vindas de tool use por mensagem recebida
                system = _montar_system_prompt(escritorio, ctx)
                payload = {
                    "model": _MODEL,
                    "temperature": 0.3,
                    "max_tokens": 600,
                    "tools": TOOLS,
                    "tool_choice": "auto",
                    "messages": [{"role": "system", "content": system}] + historico_msgs,
                }
                r = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    json=payload,
                    headers={"Authorization": f"Bearer {OPENAI_KEY}"},
                )
                data = r.json()
                if "error" in data:
                    print(f"[lead-engine] erro da OpenAI: {data['error']}")
                    break

                msg = data["choices"][0]["message"]
                ultima_msg_assistente = msg
                tool_calls = msg.get("tool_calls") or []

                if not tool_calls:
                    resposta_texto = (msg.get("content") or "").strip() or resposta_texto
                    break

                # o modelo chamou uma ou mais tools — executa cada uma e devolve o resultado
                historico_msgs.append({"role": "assistant", "content": msg.get("content"), "tool_calls": tool_calls})
                for tc in tool_calls:
                    nome_tool = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"].get("arguments") or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    resultado = _executar_tool(nome_tool, args, ctx)
                    historico_msgs.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": json.dumps(resultado, ensure_ascii=False),
                    })
                _auto_avancar(ctx, teve_historico=True)
            else:
                # esgotou o limite de iterações sem terminar em texto — ainda tenta responder algo
                if ultima_msg_assistente and ultima_msg_assistente.get("content"):
                    resposta_texto = ultima_msg_assistente["content"].strip()

    except Exception as e:
        print(f"[lead-engine] erro no motor de conversa: {e}")

    return {
        "resposta": resposta_texto,
        "updates": ctx.updates,
        "urgencia_motivo": ctx.urgencia_motivo,
        "agendado_label": ctx.agendado_label,
    }
