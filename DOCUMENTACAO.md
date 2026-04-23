# Documentação Completa — Praetor AI (Jurídico MVP)

> Gerado automaticamente via análise de código-fonte.  
> Atualizado em: abril de 2026

---

## 1. Visão Geral

**Praetor AI** é um sistema SaaS de gestão jurídica que combina:

- Monitoramento automático de processos em 40+ tribunais brasileiros
- Chatbot WhatsApp para clientes (responde dúvidas sobre o processo)
- Assistente de IA para advogados (contexto completo + rascunhos de mensagens)
- Agenda de prazos com alertas automáticos via WhatsApp
- Histórico de mensagens com clientes

**Stack principal:**

| Camada | Tecnologia |
|--------|-----------|
| Backend | Node.js + Express 5 |
| Banco de dados | Supabase (PostgreSQL) |
| IA | OpenAI GPT-4o-mini |
| WhatsApp | Z-API |
| Dados processuais | Codilo API |
| Scraping (fallback) | Axios + Cheerio |
| Deploy | Render.com |

---

## 2. Estrutura de Arquivos

```
juridico-mvp/
├── index.js          # Servidor Express principal (~825 linhas)
├── codilo.js         # Integração com a API Codilo (~344 linhas)
├── scraper.js        # Scraper web como fallback (~342 linhas)
├── index.html        # Dashboard principal (tema preto e dourado)
├── dashboard.html    # Dashboard alternativo (tema claro)
├── site/index.html   # Landing page
├── package.json      # Dependências do projeto
├── render.yaml       # Configuração de deploy no Render
├── .env              # Variáveis de ambiente (não versionado)
└── .gitignore
```

---

## 3. Arquivo: `index.js` — Servidor Principal

### 3.1 Inicialização

1. Carrega variáveis de ambiente via `dotenv`
2. Inicia Express com middlewares `cors()` e `express.json()`
3. Cria cliente Supabase (URL + chave do serviço)
4. Registra todos os 20 endpoints
5. Inicia servidor na porta **3000**
6. Configura dois cron jobs:
   - `0 8 * * *` — Alertas diários de prazos às 8h
   - `*/10 * * * *` — Ping próprio para manter Render ativo

### 3.2 Detecção de Tribunal

**Função:** `detectarTribunal(numero)`

Analisa o número CNJ (formato `0000000-00.AAAA.S.TT.OOOO`) para identificar o tribunal:

- `S = 8` → Tribunal de Justiça Estadual (TJ)
- `S = 4` → Tribunal Regional Federal (TRF)
- `S = 5` → Tribunal Regional do Trabalho (TRT)
- `S = 6` → Tribunal Regional Eleitoral (TRE)

Exemplos: `8.02` → TJAL · `8.26` → TJSP · `4.03` → TRF3

---

## 4. Endpoints da API (20 no total)

### 4.1 Autenticação

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/auth/cadastro` | Cadastra novo usuário (nome, email, senha, escritório) |
| POST | `/auth/login` | Autentica usuário; retorna objeto com dados e configurações |

### 4.2 Processos

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/processos` | Lista todos os processos do usuário (`?usuario_id=...`) |
| POST | `/processos` | Cadastra novo processo (número, cliente, telefone) |
| GET | `/processos/:numero/detalhes` | Retorna capa, partes e movimentações com explicações de IA |
| POST | `/processos/explicar` | Gera explicações de IA para array de movimentações |

### 4.3 Movimentações

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/movimentacoes` | Últimas 20 movimentações entre todos os processos do usuário |

### 4.4 Prazos / Agenda

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/prazos` | Lista prazos não vistos por urgência; sincroniza em background |
| POST | `/prazos/sincronizar` | Força sincronização de prazos de todos os processos |
| POST | `/prazos/:id/visto` | Marca prazo como visto |

### 4.5 Mensagens WhatsApp

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/mensagens/conversas` | Lista conversas únicas (última mensagem por telefone) |
| GET | `/mensagens/conversa` | Histórico completo de um telefone específico |
| POST | `/mensagens/enviar` | Advogado envia mensagem ao cliente via Z-API |

### 4.6 Assistente IA (Advogado)

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/chat-advogado` | Resposta em streaming SSE; gera rascunhos de mensagem para clientes |

### 4.7 Perfil do Usuário

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/perfil/telefone` | Atualiza telefone do advogado |
| POST | `/perfil/escritorio` | Atualiza nome do escritório |
| POST | `/perfil/config` | Atualiza telefone, horário de alerta, tipos de alerta, OAB, estado e escritório em lote |
| POST | `/perfil/senha` | Troca de senha (valida senha atual) |

### 4.8 Outros

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | `/testar-whatsapp` | Envia mensagem de teste via Z-API |
| POST | `/webhook` | Recebe mensagens de clientes via Z-API; aciona chatbot |
| GET | `/` | Health check — retorna "Sistema juridico rodando!" |

---

## 5. Banco de Dados (Supabase / PostgreSQL)

### Tabela `usuarios`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID | Chave primária |
| nome | TEXT | Nome do advogado |
| email | TEXT UNIQUE | Login |
| senha | TEXT | Senha (texto puro — ver seção de segurança) |
| escritorio | TEXT | Nome do escritório |
| telefone | TEXT | WhatsApp do advogado para alertas |
| oab | TEXT | Número OAB |
| estado | TEXT | UF (ex.: AL, SP) |
| horario_alerta | TEXT | Hora dos alertas (padrão: 08:00) |
| tipos_alerta | TEXT | Categorias separadas por vírgula: urgente,semana,normal |
| criado_em | TIMESTAMP | Data de cadastro |

### Tabela `processos`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID | Chave primária |
| usuario_id | UUID FK | Advogado dono |
| numero_processo | TEXT | Número CNJ do processo |
| nome_cliente | TEXT | Nome do cliente |
| telefone_cliente | TEXT | WhatsApp do cliente |
| criado_em | TIMESTAMP | Data de cadastro |

### Tabela `movimentacoes`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID | Chave primária |
| processo_id | INT FK | Processo relacionado |
| descricao | TEXT | Nome da movimentação |
| resumo_ia | TEXT | Explicação gerada pela IA |
| relevante | BOOLEAN | Sinalização de importância |
| enviado_whatsapp | BOOLEAN | Se já foi notificado |
| detectado_em | TIMESTAMP | Quando foi detectado |

### Tabela `prazos`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID | Chave primária |
| processo_id | INT FK | Processo relacionado |
| usuario_id | INT FK | Advogado |
| numero_processo | TEXT | Número CNJ |
| nome_cliente | TEXT | Nome do cliente |
| descricao | TEXT | Descrição do prazo |
| data_movimentacao | TEXT | Data DD/MM/AAAA |
| urgencia | TEXT | urgente / esta_semana / normal |
| visto | BOOLEAN | Se foi visto |
| criado_em | TIMESTAMP | Quando foi detectado |

### Tabela `mensagens`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | UUID | Chave primária |
| usuario_id | INT FK | Advogado |
| telefone | TEXT | Telefone do cliente |
| nome_cliente | TEXT | Nome do cliente |
| remetente | TEXT | cliente / bot / advogado |
| conteudo | TEXT | Corpo da mensagem |
| criado_em | TIMESTAMP | Horário da mensagem |

### Tabela `cache_movimentos`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| numero_processo | TEXT PK | Número CNJ |
| movimentos | JSON | Array de movimentações cacheadas |
| atualizado_em | TIMESTAMP | Última atualização (TTL: 24h) |

---

## 6. Módulo: `codilo.js` — Consulta Processual

Integra com a API Codilo para obter dados de processos em 40+ tribunais.

**Fluxo:**
1. Autentica via OAuth 2.0 (client_credentials); token reutilizado até expirar
2. Envia POST `/request` com número CNJ e tipo de consulta (`principal`, `unificada`, `recursal`)
3. Faz polling em GET `/request/{id}` a cada 800ms (máx. 15 tentativas ≈ 12s)
4. Extrai: capa do processo, partes, movimentações com datas
5. Fallback para `autorequest` se consulta específica falhar

**Tribunais suportados:** TJ (todos os estados), TRF 1-6, TRT, TRE, STJ, STF, TJDFT e outros.

---

## 7. Módulo: `scraper.js` — Scraper Web (Fallback)

Usado quando a API Codilo não retorna resultado.

- Usa **Axios** para requisições HTTP e **Cheerio** para parsing HTML
- Suporta: PJe, ESAJ, TJMG, TRE e portais similares
- Normaliza números CNJ antes de consultar
- Retorna array de `{nome, data}` de movimentações

---

## 8. Sistema de Cache em Camadas

O sistema usa duas camadas de cache para minimizar chamadas externas:

| Camada | Armazenamento | TTL | Uso |
|--------|--------------|-----|-----|
| L1 (memória) | `Map _cacheMovs` | 10 minutos | Consultas frequentes na mesma sessão |
| L2 (banco) | Tabela `cache_movimentos` | 24 horas | Persiste entre reinicializações |
| L3 (origem) | Codilo API ou scraper | — | Fallback quando cache expira |

---

## 9. Integração OpenAI (GPT-4o-mini)

Dois contextos de uso:

### 9.1 Chatbot para Clientes (Webhook WhatsApp)
- Recebe mensagem do cliente via Z-API
- Busca movimentações recentes do processo
- Chama OpenAI com system prompt do escritório + contexto do processo
- Responde diretamente ao cliente via WhatsApp
- Temperature: 0.2 (respostas precisas e consistentes)

### 9.2 Assistente para Advogados (`/chat-advogado`)
- Carrega todos os processos do advogado + movimentações
- Responde em **streaming SSE** (tokens aparecem em tempo real na tela)
- Detecta intenção de enviar mensagem ao cliente
- Gera 3–5 rascunhos de mensagem prontos para envio
- Advogado pode editar e enviar com um clique

---

## 10. Integração Z-API (WhatsApp)

**Função:** `enviarWhatsApp(telefone, mensagem)`

- Endpoint: `POST /send-text` com header `Client-Token`
- Normalização automática: remove caracteres não-numéricos, adiciona prefixo `55`, completa DDD + número
- Usos:
  - Boas-vindas ao cadastrar processo
  - Alertas diários de prazos para o advogado
  - Respostas do chatbot para clientes
  - Mensagens enviadas pelo advogado via dashboard

---

## 11. Detecção de Prazos

**Função:** `detectarPrazos(movimentacoes, processoId, usuarioId)`

Analisa movimentações buscando palavras-chave como:

> prazo · audiência · decisão · sentença · intimação · despacho · julgamento · citação · penhora · leilão

**Classificação de urgência:**

| Nível | Critério |
|-------|---------|
| `urgente` | Palavras: audiência, sentença, decisão, penhora, leilão |
| `esta_semana` | Movimentação dos últimos 7 dias |
| `normal` | Demais casos |

**Alerta diário (cron `0 8 * * *`):**
- Busca todos os usuários com prazos não vistos
- Formata mensagem com emojis (🔴 urgente, 🟡 semana)
- Envia via Z-API para o telefone do advogado

---

## 12. Frontend: `index.html` (Tema Preto e Dourado)

Dashboard principal com as seguintes telas (SPA via JavaScript):

| Tela | Recursos |
|------|---------|
| **Dashboard** | Métricas (processos, mensagens, clientes), atividade recente |
| **Processos** | Tabela de todos os processos monitorados |
| **Cadastrar** | Formulário para novo processo (detecta tribunal automaticamente) |
| **Assistente IA** | Lista de processos (esquerda) + chat com streaming (direita) |
| **Agenda** | Calendário mensal com prazos coloridos por urgência + painel de detalhes |
| **Mensagens** | Histórico de conversas com clientes (polling a cada 3s) |
| **Configurações** | Alertas WhatsApp, OAB, estado, escritório, troca de senha |

**Autenticação:** Objeto do usuário salvo em `sessionStorage`.

**Streaming:** SSE (`EventSource`) para o assistente IA.

---

## 13. Frontend: `dashboard.html` (Tema Claro)

Versão simplificada do dashboard com:
- Dashboard, Processos, Cadastrar, Mensagens
- Sem Agenda, sem Assistente IA
- Autenticação via `localStorage`
- Esquema de cores azul claro

---

## 14. Variáveis de Ambiente

| Variável | Serviço | Descrição |
|----------|---------|-----------|
| `SUPABASE_URL` | Supabase | URL do projeto |
| `SUPABASE_KEY` | Supabase | Chave service role (acesso total) |
| `OPENAI_KEY` | OpenAI | Chave de API |
| `EVOLUTION_URL` | Z-API | Endpoint de envio de mensagens |
| `EVOLUTION_INSTANCE` | Z-API | ID da instância |
| `EVOLUTION_KEY` | Z-API | Token da instância |
| `EVOLUTION_CLIENT_TOKEN` | Z-API | Client-Token do header |
| `CODILO_ID` | Codilo | OAuth Client ID |
| `CODILO_SECRET` | Codilo | OAuth Client Secret |
| `TRIBUNAL` | — | Tribunal padrão (fallback) |
| `DATAJUD_KEY` | DataJud | Chave reservada (não usado ainda) |

---

## 15. Fluxos Principais

### 15.1 Cadastro de Processo
```
Advogado preenche formulário
  → POST /processos
    → detectarTribunal() extrai tribunal do CNJ
    → Salva em tabela processos
    → Envia WhatsApp de boas-vindas ao cliente
  → Frontend atualiza tabela
```

### 15.2 Cliente Envia Mensagem WhatsApp
```
Cliente manda WhatsApp
  → Z-API dispara POST /webhook
    → jaProcessada() checa duplicatas
    → Busca processos do cliente pelo telefone
    → Busca movimentações (cache L1 → L2 → Codilo)
    → gerarRespostaChatbot() chama OpenAI
    → Resposta salva em mensagens
    → Enviada via Z-API ao cliente
  → Dashboard atualiza via polling
```

### 15.3 Advogado Usa Assistente IA
```
Advogado digita pergunta
  → POST /chat-advogado (SSE stream)
    → Carrega todos os processos do advogado
    → Para cada processo: busca movimentações (cache)
    → Detecta intenção de mensagem ao cliente
    → OpenAI gera resposta / rascunhos
    → Tokens chegam em tempo real via SSE
  → Advogado edita rascunho → Clica Enviar
    → POST /mensagens/enviar
      → Z-API entrega ao cliente
      → Salva em mensagens
```

### 15.4 Alerta de Prazos (Diário)
```
Cron 0 8 * * *
  → enviarAlertaPrazos()
    → Busca todos os usuários
    → Para cada usuário: prazos urgentes e desta semana
    → Formata mensagem com emojis
    → Envia via Z-API para telefone do advogado
```

---

## 16. Dependências (package.json)

| Pacote | Versão | Uso |
|--------|--------|-----|
| `@supabase/supabase-js` | ^2.99.2 | ORM + cliente do banco |
| `axios` | ^1.13.6 | Requisições HTTP (Codilo, Z-API, OpenAI) |
| `cheerio` | ^1.2.0 | Parser HTML para scraper |
| `cors` | ^2.8.6 | Middleware CORS |
| `dotenv` | ^17.3.1 | Carregamento de .env |
| `express` | ^5.2.1 | Framework HTTP |
| `node-cron` | ^4.2.1 | Agendamento de tarefas |
| `puppeteer` | ^24.40.0 | Browser headless (instalado, uso futuro) |

---

## 17. Considerações de Segurança

Os itens abaixo devem ser tratados antes de uma implantação em produção com dados reais:

| Problema | Risco | Solução Recomendada |
|----------|-------|---------------------|
| Senhas em texto puro | Alto | Usar `bcrypt` para hashing |
| Sem JWT/sessão | Alto | Implementar tokens com expiração |
| CORS aberto (`cors()` sem whitelist) | Médio | Restringir origens permitidas |
| Webhook sem autenticação | Médio | Validar assinatura Z-API |
| Sem rate limiting | Médio | `express-rate-limit` nos endpoints |
| SUPABASE_KEY service role exposta | Alto | Usar Row Level Security (RLS) |
| Sem validação de entrada | Médio | Validar e sanitizar inputs |
| Custo OpenAI sem limite | Baixo | Adicionar rate limit por usuário |

---

*Fim da documentação — Praetor AI v1.0*
