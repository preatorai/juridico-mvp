"""
Simula uma conversa completa com o atendente virtual, sem precisar do
WhatsApp/Z-API — usa Claude + Supabase de verdade (mesmo .env do projeto),
mas nunca dispara notificação real de handoff (só imprime na tela).

Uso:
    python scripts/simular_conversa.py [telefone_de_teste]

Digite as mensagens como se fosse o lead. Ctrl+C pra sair.
Um lead de teste é criado (ou reaproveitado) com o telefone informado —
por padrão um número claramente fake, pra não colidir com lead real.
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from app.database import supabase  # noqa: E402
from app.services import lead_engine  # noqa: E402


async def main():
    telefone = sys.argv[1] if len(sys.argv) > 1 else "5599999990000"

    usuarios = supabase.from_("usuarios").select("id,escritorio").limit(1).execute()
    if not usuarios.data:
        print("Nenhum usuário cadastrado no banco — crie uma conta primeiro (POST /auth/cadastro).")
        return
    usuario_id = usuarios.data[0]["id"]
    escritorio = usuarios.data[0].get("escritorio", "escritório de teste")

    lead = lead_engine.buscar_ou_criar_lead(telefone, usuario_id)
    if not lead:
        print("Não consegui criar/buscar o lead de teste — confira a conexão com o Supabase.")
        return

    print(f"== simulando conversa | telefone {telefone} | escritório {escritorio} ==")
    print(f"(etapa atual: {lead.get('etapa')}, área: {lead.get('area')})")
    print("Digite como se fosse o lead. Ctrl+C pra sair.\n")

    while True:
        try:
            mensagem = input("você> ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nencerrado.")
            break
        if not mensagem:
            continue

        lead_engine.salvar_mensagem_lead(lead["id"], "cliente", mensagem)
        historico = lead_engine.buscar_historico_lead(lead["id"])
        resultado = await lead_engine.processar_mensagem_lead(lead, mensagem, historico, escritorio)

        if resultado["updates"]:
            lead_engine.atualizar_lead(lead["id"], resultado["updates"])
            lead.update(resultado["updates"])

        lead_engine.salvar_mensagem_lead(lead["id"], "bot", resultado["resposta"])

        print(f"bot  > {resultado['resposta']}")
        if resultado["urgencia_motivo"]:
            print(f"       [handoff urgente seria disparado: {resultado['urgencia_motivo']}]")
        if resultado["agendado_label"]:
            print(f"       [handoff de agendamento seria disparado: {resultado['agendado_label']}]")
        print(f"       (etapa={lead.get('etapa')} area={lead.get('area')} dados={lead.get('dados')})\n")


if __name__ == "__main__":
    asyncio.run(main())
