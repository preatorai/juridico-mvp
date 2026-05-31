import time
import hashlib
import hmac
import os
from collections import defaultdict

# ── Password hashing ──────────────────────────────────────────────────────────
try:
    from passlib.context import CryptContext
    _ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

    def hash_senha(senha: str) -> str:
        return _ctx.hash(senha)

    def verificar_senha(senha: str, hashed: str) -> bool:
        if _e_hash_bcrypt(hashed):
            return _ctx.verify(senha, hashed)
        return hmac.compare_digest(senha, hashed)  # legacy plain text

    def _e_hash_bcrypt(valor: str) -> bool:
        return valor.startswith("$2b$") or valor.startswith("$2a$")

except ImportError:
    # fallback: SHA-256 se passlib não estiver instalado
    def hash_senha(senha: str) -> str:
        return "sha256:" + hashlib.sha256(senha.encode()).hexdigest()

    def verificar_senha(senha: str, hashed: str) -> bool:
        if hashed.startswith("sha256:"):
            return hmac.compare_digest(
                "sha256:" + hashlib.sha256(senha.encode()).hexdigest(),
                hashed
            )
        return hmac.compare_digest(senha, hashed)

    def _e_hash_bcrypt(valor: str) -> bool:
        return False


# ── Rate limiting (in-memory, por IP) ────────────────────────────────────────
_tentativas: dict = defaultdict(list)
JANELA = 60        # segundos
MAX_TENTATIVAS = 8  # por janela


def checar_rate_limit(ip: str) -> bool:
    """Retorna True se o IP está bloqueado."""
    agora = time.time()
    _tentativas[ip] = [t for t in _tentativas[ip] if agora - t < JANELA]
    _tentativas[ip].append(agora)
    return len(_tentativas[ip]) > MAX_TENTATIVAS


def limpar_rate_limit(ip: str):
    _tentativas.pop(ip, None)
