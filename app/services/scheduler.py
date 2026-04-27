import asyncio
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from app.database import supabase
from app.services.whatsapp import enviar_whatsapp

scheduler = AsyncIOScheduler()


async def enviar_alerta_prazos():
    print("[agenda] enviando alertas de prazo...")
    try:
        usuarios = supabase.from_("usuarios").select("*").execute().data or []
        for usuario in usuarios:
            if not usuario.get("telefone"):
                continue
            try:
                prazos_res = (
                    supabase.from_("prazos").select("*")
                    .eq("usuario_id", usuario["id"])
                    .eq("visto", False)
                    .in_("urgencia", ["urgente", "esta_semana"])
                    .order("urgencia", desc=False)
                    .execute()
                )
                prazos = prazos_res.data or []
                if not prazos:
                    continue

                urgentes = [p for p in prazos if p["urgencia"] == "urgente"]
                semana = [p for p in prazos if p["urgencia"] == "esta_semana"]

                msg = "⚖️ *Praetor AI — Agenda do dia*\n\n"
                if urgentes:
                    msg += "🔴 *ATENÇÃO IMEDIATA*\n"
                    for p in urgentes:
                        msg += f"• {p['descricao']} — {p['nome_cliente']}\n  Proc. {p['numero_processo']}\n  Data: {p['data_movimentacao']}\n\n"
                if semana:
                    msg += "🟡 *ESTA SEMANA*\n"
                    for p in semana:
                        msg += f"• {p['descricao']} — {p['nome_cliente']}\n  Proc. {p['numero_processo']}\n  Data: {p['data_movimentacao']}\n\n"
                msg += "_Acesse o Praetor AI para detalhes._"

                await enviar_whatsapp(usuario["telefone"], msg)
                print(f"[agenda] alerta enviado para {usuario['nome']}")
            except Exception as e:
                print(f"[agenda] {e}")
    except Exception as e:
        print(f"[agenda] erro geral: {e}")


def start_scheduler():
    scheduler.add_job(enviar_alerta_prazos, "cron", hour=8, minute=0)
    scheduler.start()
    print("[scheduler] iniciado")
