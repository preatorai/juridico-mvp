"""
Follow-up automático — se o lead parar de responder por algumas horas
(FOLLOWUP_HORAS no .env, padrão 6h), manda uma mensagem retomando a
conversa. Só faz isso UMA vez por lead (follow_up_enviado); se a pessoa
responder de novo, o webhook zera essa flag (ver _tratar_lead em webhook.py).

Só dispara em horário comercial (ver FOLLOWUP_HORA_INICIO/FIM no .env) —
fora disso a funcao nao faz nada; o lead continua elegivel e e pego no
proximo ciclo dentro do horario.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.config import FOLLOWUP_HORAS, FOLLOWUP_HORA_INICIO, FOLLOWUP_HORA_FIM, IA_ATIVA
from app.database import supabase
from app.services import zapi_service
from app.services.lead_engine import salvar_mensagem_lead

_FUSO_BR = ZoneInfo("America/Sao_Paulo")


def _em_horario_comercial() -> bool:
    agora = datetime.now(_FUSO_BR)
    if agora.weekday() == 6:  # domingo
        return False
    return FOLLOWUP_HORA_INICIO <= agora.hour < FOLLOWUP_HORA_FIM


def _mensagem_followup(nome: str | None) -> str:
    saudacao = f"Oi, {nome.split()[0]}!" if nome else "Oi!"
    return (
        f"{saudacao} Passando aqui só pra saber se ainda posso te ajudar com o seu caso. "
        "Quando quiser continuar, é só me responder por aqui 🙂"
    )


async def enviar_followups_pendentes():
    """Roda periodicamente (ver app/main.py). Busca leads parados há mais de
    FOLLOWUP_HORAS, manda uma mensagem de retomada, e marca follow_up_enviado."""
    if not IA_ATIVA:
        return
    if not _em_horario_comercial():
        return

    limite = (datetime.now(timezone.utc) - timedelta(hours=FOLLOWUP_HORAS)).isoformat()
    try:
        res = supabase.from_("leads").select("id,telefone,nome,usuario_id") \
            .not_.in_("status", ["fechado", "perdido"]) \
            .neq("etapa", "finalizado") \
            .eq("follow_up_enviado", False) \
            .lt("atualizado_em", limite) \
            .execute()
    except Exception as e:
        print(f"[followup] erro ao buscar leads pendentes: {e}")
        return

    leads = res.data or []
    if not leads:
        return

    print(f"[followup] {len(leads)} lead(s) pra retomar")
    for lead in leads:
        texto = _mensagem_followup(lead.get("nome"))
        try:
            await zapi_service.send_text(lead["telefone"], texto)
        except zapi_service.ZAPIError as e:
            print(f"[followup] erro ao enviar pra {lead['telefone']}: {e}")
            continue

        salvar_mensagem_lead(lead["id"], "bot", texto)
        try:
            supabase.from_("leads").update({
                "follow_up_enviado": True,
                "atualizado_em": datetime.now(timezone.utc).isoformat(),
            }).eq("id", lead["id"]).execute()
        except Exception as e:
            print(f"[followup] erro ao marcar follow_up_enviado ({lead['id']}): {e}")
