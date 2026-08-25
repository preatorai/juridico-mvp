"""
Integração com a Z-API (API não-oficial do WhatsApp).
Documentação oficial: https://developer.z-api.io

Todas as credenciais vêm de variável de ambiente (nunca hardcoded) —
ver app/config.py: ZAPI_INSTANCE_ID, ZAPI_TOKEN, ZAPI_BASE_URL, ZAPI_CLIENT_TOKEN.
"""
import httpx
from app.config import ZAPI_BASE_URL, ZAPI_CLIENT_TOKEN


class ZAPIError(Exception):
    """Erro ao comunicar com a Z-API — falha de rede ou resposta de erro da API."""


def _normalizar_telefone(telefone: str) -> str:
    nums = "".join(c for c in (telefone or "") if c.isdigit())
    return nums if nums.startswith("55") else "55" + nums


def _headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if ZAPI_CLIENT_TOKEN:
        headers["Client-Token"] = ZAPI_CLIENT_TOKEN
    return headers


async def _post(endpoint: str, payload: dict) -> dict:
    if not ZAPI_BASE_URL:
        raise ZAPIError("ZAPI_BASE_URL não configurada (.env).")
    url = f"{ZAPI_BASE_URL.rstrip('/')}/{endpoint}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(url, json=payload, headers=_headers())
    except httpx.RequestError as e:
        raise ZAPIError(f"Falha de rede ao chamar Z-API ({endpoint}): {e}") from e

    try:
        data = r.json()
    except ValueError:
        data = {}

    if r.status_code != 200 or data.get("error"):
        raise ZAPIError(
            f"Z-API retornou erro em '{endpoint}' (HTTP {r.status_code}): "
            f"{data.get('error') or data or r.text}"
        )
    return data


async def send_text(phone: str, message: str) -> dict:
    """Envia mensagem de texto. POST /send-text"""
    fone = _normalizar_telefone(phone)
    print(f"[zapi] send_text -> {fone}")
    return await _post("send-text", {"phone": fone, "message": message})


async def send_image(phone: str, image_url: str, caption: str = "") -> dict:
    """Envia imagem (URL ou base64). POST /send-image"""
    fone = _normalizar_telefone(phone)
    payload = {"phone": fone, "image": image_url}
    if caption:
        payload["caption"] = caption
    print(f"[zapi] send_image -> {fone}")
    return await _post("send-image", payload)


async def send_document(phone: str, doc_url: str, file_name: str) -> dict:
    """Envia documento (URL ou base64). POST /send-document/{extensao}"""
    fone = _normalizar_telefone(phone)
    extensao = (file_name.rsplit(".", 1)[-1] if file_name and "." in file_name else "pdf").lower()
    payload = {"phone": fone, "document": doc_url, "fileName": file_name}
    print(f"[zapi] send_document -> {fone} ({extensao})")
    return await _post(f"send-document/{extensao}", payload)


async def get_status() -> dict:
    """Verifica se a instância está conectada. GET /status"""
    if not ZAPI_BASE_URL:
        raise ZAPIError("ZAPI_BASE_URL não configurada (.env).")
    url = f"{ZAPI_BASE_URL.rstrip('/')}/status"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers=_headers())
    except httpx.RequestError as e:
        raise ZAPIError(f"Falha de rede ao consultar status da Z-API: {e}") from e

    try:
        data = r.json()
    except ValueError:
        data = {}

    if r.status_code != 200:
        raise ZAPIError(f"Z-API retornou erro ao consultar status (HTTP {r.status_code}): {data or r.text}")
    return data
