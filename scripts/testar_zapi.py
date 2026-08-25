"""
Script de teste da integração Z-API — dispara um sendText real e confere status.

Uso:
    python scripts/testar_zapi.py                     -> só checa status da instância
    python scripts/testar_zapi.py 5582999998888        -> checa status + manda texto de teste
    python scripts/testar_zapi.py 5582999998888 "oi"   -> checa status + manda mensagem custom

Roda a partir da raiz do projeto (usa o .env local via app/config.py).
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")  # evita UnicodeEncodeError no console do Windows

from app.services import zapi_service  # noqa: E402


async def main():
    print("== status da instância Z-API ==")
    try:
        status = await zapi_service.get_status()
        print(status)
        if status.get("connected") is False:
            print("⚠️  Instância não está conectada — escaneie o QR Code no painel da Z-API.")
    except zapi_service.ZAPIError as e:
        print(f"❌ Erro ao consultar status: {e}")
        return

    if len(sys.argv) < 2:
        print("\n(nenhum telefone passado — só o status foi checado. "
              "Passe um número como argumento pra testar o envio de texto.)")
        return

    telefone = sys.argv[1]
    mensagem = sys.argv[2] if len(sys.argv) > 2 else "Teste de integração Z-API ✅"

    print(f"\n== enviando texto de teste para {telefone} ==")
    try:
        resultado = await zapi_service.send_text(telefone, mensagem)
        print("✅ Enviado:", resultado)
    except zapi_service.ZAPIError as e:
        print(f"❌ Erro ao enviar: {e}")


if __name__ == "__main__":
    asyncio.run(main())
