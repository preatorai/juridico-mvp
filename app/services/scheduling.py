"""
Interface de agendamento — hoje mockada com horários fixos (app/data/horarios_mock.json).

Pra plugar Google Calendar, Calendly, etc no futuro: reimplemente
`get_available_slots` e `book_slot` mantendo a mesma assinatura e o
mesmo formato de retorno. Nada no motor de conversa (lead_engine.py)
precisa mudar.
"""
import json
import os
from datetime import datetime, timezone

_ARQUIVO_HORARIOS = os.path.join(os.path.dirname(__file__), "..", "data", "horarios_mock.json")

_reservas: dict[str, dict] = {}  # slot_id -> {lead_id, telefone} — só em memória, reinicia com o servidor


def _carregar_horarios() -> list[dict]:
    with open(_ARQUIVO_HORARIOS, encoding="utf-8") as f:
        return json.load(f)["horarios"]


def get_available_slots(area: str | None = None) -> list[dict]:
    """Retorna os horários disponíveis (ainda não reservados).

    `area` é aceito pra manter a assinatura pronta pra quando a integração
    real filtrar horários por advogado/especialidade — o mock ignora esse
    parâmetro e devolve a mesma lista pra qualquer área.
    """
    todos = _carregar_horarios()
    return [h for h in todos if h["id"] not in _reservas]


def book_slot(lead_id: str, telefone: str, slot_id: str) -> dict:
    """Reserva um horário. Levanta ValueError se o horário não existir
    ou já estiver ocupado."""
    disponiveis = {h["id"]: h for h in get_available_slots()}
    if slot_id not in disponiveis:
        raise ValueError(f"Horário '{slot_id}' indisponível ou inexistente.")
    _reservas[slot_id] = {"lead_id": lead_id, "telefone": telefone, "reservado_em": datetime.now(timezone.utc).isoformat()}
    slot = disponiveis[slot_id]
    return {"id": slot_id, "label": slot["label"], "tipo": slot["tipo"], "inicio": slot_id}
