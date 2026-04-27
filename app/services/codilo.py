import asyncio
import time
import httpx
from app.config import CODILO_ID, CODILO_SECRET
from app.database import supabase

_token: str = ""
_token_expira: float = 0
_cache_mem: dict = {}

MAPA_TRIBUNAL = {
    "tjsp": {"platform": "esaj",           "search": "tjsp"},
    "tjba": {"platform": "esaj",           "search": "tjba"},
    "tjce": {"platform": "esaj",           "search": "tjce"},
    "tjsc": {"platform": "esaj",           "search": "tjsc"},
    "tjms": {"platform": "esaj",           "search": "tjms"},
    "tjal": {"platform": "esaj",           "search": "tjal"},
    "tjam": {"platform": "pje",            "search": "tjam"},
    "tjrj": {"platform": "pje",            "search": "tjrj"},
    "tjmg": {"platform": "pje",            "search": "tjmg"},
    "tjpr": {"platform": "pje",            "search": "tjpr"},
    "tjrs": {"platform": "pje",            "search": "tjrs"},
    **{f"trt{i}": {"platform": "pje-jt-merged", "search": f"trt{i}"} for i in range(1, 25)},
}

TRIBUNAIS = {
    "1.00": "stf", "3.00": "stj",
    "4.01": "trf1", "4.02": "trf2", "4.03": "trf3", "4.04": "trf4", "4.05": "trf5",
    "5.00": "tst",
    **{f"5.{str(i).zfill(2)}": f"trt{i}" for i in range(1, 25)},
    "6.00": "tse",
    **{f"6.{str(i).zfill(2)}": f"tre" for i in range(1, 28)},
    "8.01": "tjac", "8.02": "tjal", "8.03": "tjap", "8.04": "tjam", "8.05": "tjba",
    "8.06": "tjce", "8.07": "tjdft", "8.08": "tjes", "8.09": "tjgo", "8.10": "tjma",
    "8.11": "tjmt", "8.12": "tjms", "8.13": "tjmg", "8.14": "tjpa", "8.15": "tjpb",
    "8.16": "tjpr", "8.17": "tjpe", "8.18": "tjpi", "8.19": "tjrj", "8.20": "tjrn",
    "8.21": "tjrs", "8.22": "tjro", "8.23": "tjrr", "8.24": "tjsc", "8.25": "tjse",
    "8.26": "tjsp", "8.27": "tjto",
}


def normalizar_cnj(numero: str) -> str:
    digits = "".join(c for c in (numero or "") if c.isdigit())
    if len(digits) == 20:
        return f"{digits[:7]}-{digits[7:9]}.{digits[9:13]}.{digits[13:14]}.{digits[14:16]}.{digits[16:20]}"
    return numero.strip()


def detectar_tribunal(numero: str) -> str | None:
    partes = numero.replace(" ", "").split(".")
    if len(partes) >= 4:
        codigo = partes[2] + "." + partes[3][:2]
        return TRIBUNAIS.get(codigo)
    return None


def formatar_data(data_str: str) -> str:
    if not data_str:
        return "—"
    try:
        from datetime import datetime
        return datetime.fromisoformat(data_str).strftime("%d/%m/%Y")
    except Exception:
        return data_str


async def get_token(force: bool = False) -> str:
    global _token, _token_expira
    if not force and _token and time.time() < _token_expira:
        return _token
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post("https://auth.codilo.com.br/oauth/token", json={
            "grant_type": "client_credentials", "id": CODILO_ID, "secret": CODILO_SECRET
        })
        r.raise_for_status()
        data = r.json()
        _token = data["access_token"]
        _token_expira = time.time() + int(data["expires_in"]) - 60
        print("[codilo] token renovado")
        return _token


def extrair_movimentacoes(data) -> list:
    items = data if isinstance(data, list) else [data]
    steps = []
    for it in items:
        if not isinstance(it, dict):
            continue
        if isinstance(it.get("steps"), list):
            steps.extend(it["steps"])
    return [
        {"nome": s.get("title") or s.get("description") or "Movimentação",
         "data": formatar_data(s.get("timestamp"))}
        for s in sorted(steps, key=lambda x: x.get("timestamp") or "", reverse=True)
        if s.get("title") or s.get("description")
    ]


async def polling(request_id: str) -> list | None:
    MAX = 35
    erros500 = 0
    for i in range(MAX):
        espera = 0.3 if i < 3 else (0.7 if i < 8 else 1.3)
        await asyncio.sleep(espera)
        try:
            token = await get_token()
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(
                    f"https://api.consulta.codilo.com.br/v1/request/{request_id}",
                    headers={"Authorization": f"Bearer {token}"}
                )
            status = (r.json().get("requested") or {}).get("status", "").lower()
            print(f"[codilo] polling {i+1}/{MAX} status={status}")
            if status in ("pending", "pendente", "processing", "processando"):
                continue
            if status in ("error", "erro"):
                return None
            data = r.json().get("data")
            if not data or (isinstance(data, list) and not data):
                return None
            movs = extrair_movimentacoes(data)
            print(f"[codilo] OK {len(movs)} movimentacoes")
            return movs
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                await get_token(force=True)
                continue
            if e.response.status_code in (400, 403, 404):
                return None
            erros500 += 1
            if erros500 >= 3:
                return None
    return None


async def submit_query(cnj: str, platform: str, search: str, query: str) -> list | None:
    try:
        token = await get_token()
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                "https://api.consulta.codilo.com.br/v1/request",
                json={"source": "courts", "platform": platform, "search": search,
                      "query": query, "param": {"key": "cnj", "value": cnj}, "callbacks": []},
                headers={"Authorization": f"Bearer {token}"}
            )
        if r.json().get("success") and r.json().get("data", {}).get("id"):
            return await polling(r.json()["data"]["id"])
    except Exception as e:
        print(f"[codilo] submitQuery erro: {e}")
    return None


async def auto_request(cnj: str) -> list | None:
    try:
        token = await get_token()
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                "https://api.consulta.codilo.com.br/v1/autorequest",
                json={"key": "cnj", "value": cnj, "callbacks": []},
                headers={"Authorization": f"Bearer {token}"}
            )
        if r.json().get("success") and r.json().get("data", {}).get("id"):
            return await polling(r.json()["data"]["id"])
    except Exception as e:
        print(f"[codilo] autorequest erro: {e}")
    return None


async def primeiro_com_dados(coros: list) -> list | None:
    tasks = [asyncio.create_task(c) for c in coros]
    result = None
    pending = set(tasks)
    while pending:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            res = t.result()
            if res and len(res) > 0:
                result = res
                for p in pending:
                    p.cancel()
                return result
    return None


async def buscar_codilo(numero: str) -> list:
    cnj = normalizar_cnj(numero)
    tribunal = detectar_tribunal(cnj)
    cfg = MAPA_TRIBUNAL.get(tribunal) if tribunal else None
    print(f"[codilo] buscando {cnj} | tribunal={tribunal}")

    if cfg:
        res = await primeiro_com_dados([
            submit_query(cnj, cfg["platform"], cfg["search"], "principal"),
            submit_query(cnj, cfg["platform"], cfg["search"], "recursal"),
        ])
        if res:
            return res
        if cfg["platform"] == "esaj":
            res = await primeiro_com_dados([
                submit_query(cnj, "pje", cfg["search"], "principal"),
                submit_query(cnj, "pje", cfg["search"], "recursal"),
            ])
            if res:
                return res

    res = await auto_request(cnj)
    return res or []


async def salvar_cache(numero: str, movs: list):
    from datetime import datetime, timezone
    chave = normalizar_cnj(numero)
    _cache_mem[chave] = {"movs": movs, "ts": time.time()}
    try:
        upd = supabase.from_("cache_movimentos").update({
            "movimentos": movs, "atualizado_em": datetime.now(timezone.utc).isoformat()
        }).eq("numero_processo", chave).execute()
        if not upd.data:
            supabase.from_("cache_movimentos").insert({
                "numero_processo": chave, "movimentos": movs,
                "atualizado_em": datetime.now(timezone.utc).isoformat()
            }).execute()
            print(f"[cache-db] inserido: {chave} ({len(movs)} movs)")
        else:
            print(f"[cache-db] atualizado: {chave} ({len(movs)} movs)")
    except Exception as e:
        print(f"[cache-db] erro: {e}")


async def buscar_movimentacoes_cache(numero: str) -> list:
    chave = normalizar_cnj(numero)
    agora = time.time()
    CACHE_MEM = 5 * 60
    CACHE_DB  = 10 * 60

    mem = _cache_mem.get(chave)
    if mem and mem["movs"] and agora - mem["ts"] < CACHE_MEM:
        return mem["movs"]

    try:
        row = supabase.from_("cache_movimentos").select("movimentos,atualizado_em").eq("numero_processo", chave).execute()
        if row.data and isinstance(row.data[0].get("movimentos"), list) and row.data[0]["movimentos"]:
            _cache_mem[chave] = {"movs": row.data[0]["movimentos"], "ts": agora}
            idade = agora - time.mktime(time.strptime(row.data[0]["atualizado_em"][:19], "%Y-%m-%dT%H:%M:%S"))
            asyncio.create_task(_refresh_bg(chave))  # sempre atualiza em background
            return row.data[0]["movimentos"]
    except Exception:
        pass

    movs = await buscar_codilo(chave)
    if movs:
        await salvar_cache(chave, movs)
        return movs
    return []


async def _refresh_bg(chave: str):
    movs = await buscar_codilo(chave)
    if movs:
        await salvar_cache(chave, movs)


async def pre_aquecer_cache():
    await asyncio.sleep(5)
    try:
        res = supabase.from_("processos").select("numero_processo").execute()
        if not res.data:
            return
        unicos = list({normalizar_cnj(p["numero_processo"]) for p in res.data})
        print(f"[startup] aquecendo {len(unicos)} processos...")
        for num in unicos:
            try:
                row = supabase.from_("cache_movimentos").select("atualizado_em").eq("numero_processo", num).execute()
                if row.data:
                    idade = time.time() - time.mktime(time.strptime(row.data[0]["atualizado_em"][:19], "%Y-%m-%dT%H:%M:%S"))
                    if idade < 30 * 60:
                        print(f"[startup] {num} cache ok")
                        continue
                movs = await buscar_codilo(num)
                if movs:
                    await salvar_cache(num, movs)
                    print(f"[startup] OK {num} - {len(movs)} movs")
            except Exception as e:
                print(f"[startup] erro {num}: {e}")
        print("[startup] aquecimento concluído")
    except Exception as e:
        print(f"[startup] erro geral: {e}")
