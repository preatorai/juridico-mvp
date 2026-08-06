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

class MensagemEnviarBody(BaseModel):
    usuario_id: str
    telefone: str
    conteudo: str
    nome_cliente: Optional[str] = "Cliente"
