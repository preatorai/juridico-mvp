"""
Notificação do advogado humano — handoff de lead qualificado/agendado ou urgente.

Hoje manda uma mensagem de WhatsApp pro número do advogado (via zapi_service).
Pra evoluir pra e-mail/Slack depois, troque só o corpo de `_notificar` — quem
chama (lead_engine.py) não muda.
"""
from app.config import ADVOGADO_HANDOFF_TELEFONE
from app.services import zapi_service
from app.database import supabase


def _telefone_advogado(usuario_id: str) -> str | None:
    """Usa o telefone cadastrado do escritório (usuarios.telefone); se vazio,
    cai no ADVOGADO_HANDOFF_TELEFONE do .env como fallback."""
    try:
        res = supabase.from_("usuarios").select("telefone").eq("id", usuario_id).single().execute()
        tel = (res.data or {}).get("telefone")
        if tel:
            return tel
    except Exception as e:
        print(f"[handoff] erro ao buscar telefone do advogado: {e}")
    return ADVOGADO_HANDOFF_TELEFONE or None


async def _notificar(usuario_id: str, texto: str):
    telefone = _telefone_advogado(usuario_id)
    if not telefone:
        print(f"[handoff] sem telefone de advogado configurado — mensagem não enviada:\n{texto}")
        return
    try:
        await zapi_service.send_text(telefone, texto)
    except zapi_service.ZAPIError as e:
        print(f"[handoff] erro ao notificar advogado: {e}")


def _resumo_dados(nome: str | None, telefone_lead: str, area: str | None, dados: dict) -> str:
    linhas = [f"Nome: {nome or '—'}", f"WhatsApp: {telefone_lead}", f"Área: {area or '—'}"]
    for campo, valor in (dados or {}).items():
        linhas.append(f"{campo}: {valor}")
    return "\n".join(linhas)


async def notificar_qualificado_agendado(usuario_id: str, nome: str | None, telefone_lead: str,
                                          area: str | None, dados: dict, horario_label: str | None):
    texto = (
        "📅 *Novo lead agendado*\n\n"
        + _resumo_dados(nome, telefone_lead, area, dados)
        + (f"\n\nHorário: {horario_label}" if horario_label else "")
    )
    await _notificar(usuario_id, texto)


async def notificar_urgente(usuario_id: str, nome: str | None, telefone_lead: str,
                             area: str | None, dados: dict, motivo: str):
    texto = (
        "🚨 *URGENTE — atenção imediata*\n\n"
        f"Motivo: {motivo}\n\n"
        + _resumo_dados(nome, telefone_lead, area, dados)
    )
    await _notificar(usuario_id, texto)
