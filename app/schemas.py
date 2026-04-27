from pydantic import BaseModel
from typing import Optional

class CadastroBody(BaseModel):
    nome: str
    email: str
    senha: str
    escritorio: str

class LoginBody(BaseModel):
    email: str
    senha: str

class ProcessoBody(BaseModel):
    numero_processo: str
    nome_cliente: str
    telefone_cliente: str
    usuario_id: str

class TelefoneBody(BaseModel):
    usuario_id: str
    telefone: str

class EscritorioBody(BaseModel):
    usuario_id: str
    escritorio: str

class PerfilConfigBody(BaseModel):
    usuario_id: str
    telefone: Optional[str] = None
    horario_alerta: Optional[str] = None
    tipos_alerta: Optional[str] = None
    escritorio: Optional[str] = None
    oab: Optional[str] = None
    estado: Optional[str] = None

class SenhaBody(BaseModel):
    usuario_id: str
    senha_atual: str
    senha_nova: str

class ChatBody(BaseModel):
    usuario_id: str
    pergunta: str
    processo_id: Optional[str] = None

class MensagemEnviarBody(BaseModel):
    usuario_id: str
    telefone: str
    conteudo: str
    nome_cliente: Optional[str] = "Cliente"

class PrazoSincBody(BaseModel):
    usuario_id: str
