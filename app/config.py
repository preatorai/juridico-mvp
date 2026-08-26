import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL        = os.environ["SUPABASE_URL"]
SUPABASE_KEY        = os.environ["SUPABASE_KEY"]
OPENAI_KEY          = os.environ["OPENAI_KEY"]
ZAPI_INSTANCE_ID    = os.environ.get("ZAPI_INSTANCE_ID", "")
ZAPI_TOKEN          = os.environ.get("ZAPI_TOKEN", "")
ZAPI_BASE_URL       = os.environ.get("ZAPI_BASE_URL", "")
ZAPI_CLIENT_TOKEN   = os.environ.get("ZAPI_CLIENT_TOKEN", "")
ZAPI_WEBHOOK_SECRET = os.environ.get("ZAPI_WEBHOOK_SECRET", "")
SPURNOW_KEY         = os.environ.get("SPURNOW_KEY", "")
SPURNOW_PHONE       = os.environ.get("SPURNOW_PHONE", "")
SPURNOW_SECRET      = os.environ.get("SPURNOW_SECRET", "")
DEPLOY_SECRET       = os.environ.get("DEPLOY_SECRET", "")

ADVOGADO_HANDOFF_TELEFONE = os.environ.get("ADVOGADO_HANDOFF_TELEFONE", "")

# Conta dona do numero de WhatsApp conectado hoje na Z-API (so existe uma
# instancia compartilhada por enquanto — quando cada escritorio tiver seu
# proprio numero, isso vira uma tabela em vez de uma env var).
WHATSAPP_USUARIO_EMAIL = os.environ.get("WHATSAPP_USUARIO_EMAIL", "")

FOLLOWUP_HORAS = float(os.environ.get("FOLLOWUP_HORAS", "6"))
FOLLOWUP_HORA_INICIO = int(os.environ.get("FOLLOWUP_HORA_INICIO", "8"))   # horario comercial (fuso America/Sao_Paulo)
FOLLOWUP_HORA_FIM    = int(os.environ.get("FOLLOWUP_HORA_FIM", "19"))
