import httpx
from app.config import SPURNOW_KEY, SPURNOW_PHONE
from app.services import zapi_service


async def enviar_whatsapp(telefone: str, mensagem: str):
    """Envia texto via Z-API. Mantido como wrapper fino sobre zapi_service
    para não quebrar quem já importa `enviar_whatsapp` (webhook.py, mensagens.py)."""
    await zapi_service.send_text(telefone, mensagem)


async def enviar_whatsapp_spurnow(telefone: str, mensagem: str):
    nums = "".join(c for c in telefone if c.isdigit())
    fone = nums if nums.startswith("55") else "55" + nums
    print(f"[spurnow] enviando para: {fone}")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            "https://api.spurnow.com/send-message",
            json={
                "to": fone,
                "channel": "whatsapp",
                "content": {"type": "text", "text": {"body": mensagem}},
                "options": {"from": SPURNOW_PHONE},
            },
            headers={"Authorization": f"Bearer {SPURNOW_KEY}"},
        )
    print(f"[spurnow] resposta: {r.status_code}")
