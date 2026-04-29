import os
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL        = os.environ["SUPABASE_URL"]
SUPABASE_KEY        = os.environ["SUPABASE_KEY"]
OPENAI_KEY          = os.environ["OPENAI_KEY"]
EVOLUTION_URL       = os.environ.get("EVOLUTION_URL", "")
EVOLUTION_TOKEN     = os.environ.get("EVOLUTION_CLIENT_TOKEN", "")
SPURNOW_KEY         = os.environ.get("SPURNOW_KEY", "")
SPURNOW_PHONE       = os.environ.get("SPURNOW_PHONE", "")
SPURNOW_SECRET      = os.environ.get("SPURNOW_SECRET", "")
CODILO_ID           = os.environ.get("CODILO_ID", "")
CODILO_SECRET       = os.environ.get("CODILO_SECRET", "")
DEPLOY_SECRET       = os.environ.get("DEPLOY_SECRET", "")
