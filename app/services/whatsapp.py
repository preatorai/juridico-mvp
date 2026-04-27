import httpx
from app.config import EVOLUTION_URL, EVOLUTION_TOKEN, SPURNOW_KEY, SPURNOW_PHONE


async def enviar_whatsapp(telefone: str, mensagem: str):
    nums = "".join(c for c in telefone if c.isdigit())
    fone = nums if nums.startswith("55") else "55" + nums
    print(f"[whatsapp] enviando para: {fone}")
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            EVOLUTION_URL,
            json={"phone": fone, "message": mensagem},
            headers={"Client-Token": EVOLUTION_TOKEN},
        )
    data = r.json()
    if data.get("error"):
        raise Exception(f"Z-API: {data['error']}")
    print(f"[whatsapp] Z-API resposta: {r.status_code}")


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
