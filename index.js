require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { consultarProcesso, consultarProcessoCompleto } = require('./codilo');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_CLIENT_TOKEN = process.env.EVOLUTION_CLIENT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
app.use(cors());
app.use(express.json());

const TRIBUNAIS = {
  // STF e STJ
  '1.00':'stf',
  '3.00':'stj',
  // TRFs — Justiça Federal (1ª e 2ª instância)
  '4.01':'trf1','4.02':'trf2','4.03':'trf3','4.04':'trf4','4.05':'trf5',
  // TRTs — Justiça do Trabalho
  '5.00':'tst',
  '5.01':'trt1','5.02':'trt2','5.03':'trt3','5.04':'trt4','5.05':'trt5',
  '5.06':'trt6','5.07':'trt7','5.08':'trt8','5.09':'trt9','5.10':'trt10',
  '5.11':'trt11','5.12':'trt12','5.13':'trt13','5.14':'trt14','5.15':'trt15',
  '5.16':'trt16','5.17':'trt17','5.18':'trt18','5.19':'trt19','5.20':'trt20',
  '5.21':'trt21','5.22':'trt22','5.23':'trt23','5.24':'trt24',
  // TREs — Justiça Eleitoral
  '6.00':'tse',
  '6.01':'tre-ac','6.02':'tre-al','6.03':'tre-ap','6.04':'tre-am',
  '6.05':'tre-ba','6.06':'tre-ce','6.07':'tre-df','6.08':'tre-es',
  '6.09':'tre-go','6.10':'tre-ma','6.11':'tre-mt','6.12':'tre-ms',
  '6.13':'tre-mg','6.14':'tre-pa','6.15':'tre-pb','6.16':'tre-pr',
  '6.17':'tre-pe','6.18':'tre-pi','6.19':'tre-rj','6.20':'tre-rn',
  '6.21':'tre-rs','6.22':'tre-ro','6.23':'tre-rr','6.24':'tre-sc',
  '6.25':'tre-se','6.26':'tre-sp','6.27':'tre-to',
  // Justiça Militar
  '7.00':'stm',
  '9.01':'tjmmg','9.03':'tjmrs','9.04':'tjmsc','9.07':'tjmsp',
  // TJs — Justiça Estadual (1ª e 2ª instância)
  '8.01':'tjac','8.02':'tjal','8.03':'tjap','8.04':'tjam','8.05':'tjba',
  '8.06':'tjce','8.07':'tjdft','8.08':'tjes','8.09':'tjgo','8.10':'tjma',
  '8.11':'tjmt','8.12':'tjms','8.13':'tjmg','8.14':'tjpa','8.15':'tjpb',
  '8.16':'tjpr','8.17':'tjpe','8.18':'tjpi','8.19':'tjrj','8.20':'tjrn',
  '8.21':'tjrs','8.22':'tjro','8.23':'tjrr','8.24':'tjsc','8.25':'tjse',
  '8.26':'tjsp','8.27':'tjto'
};

function detectarTribunal(numeroProcesso) {
  const partes = numeroProcesso.replace(/\s/g,'').split('.');
  if (partes.length >= 4) {
    const codigo = partes[2] + '.' + partes[3].substring(0,2);
    if (TRIBUNAIS[codigo]) return TRIBUNAIS[codigo];
  }
  return 'tjal';
}

// Cache de movimentações — memória (rápido) + Supabase (persiste entre restarts)
const _cacheMovs = new Map();
const CACHE_TTL_MEM = 10 * 60 * 1000;   // 10 min em memória
const CACHE_TTL_DB  = 24 * 60 * 60 * 1000; // 24h no banco

function salvarCache(numeroProcesso, movs) {
  _cacheMovs.set(numeroProcesso, { movs, ts: Date.now() });
  (async () => {
    await supabase.from('cache_movimentos').upsert({
      numero_processo: numeroProcesso,
      movimentos: movs,
      atualizado_em: new Date().toISOString()
    }, { onConflict: 'numero_processo' });
  })().catch(() => {});
}

function atualizarCacheBackground(numeroProcesso) {
  (async () => {
    const movs = await buscarMovimentacoes(numeroProcesso);
    if (movs && movs.length > 0) salvarCache(numeroProcesso, movs);
  })().catch(() => {});
}

async function buscarMovimentacoesCache(numeroProcesso) {
  const agora = Date.now();

  // 1. Cache em memória
  const mem = _cacheMovs.get(numeroProcesso);
  if (mem && agora - mem.ts < CACHE_TTL_MEM) {
    console.log(`[cache-mem] ✅ hit: ${numeroProcesso}`);
    return mem.movs;
  }

  // 2. Cache no banco (persiste entre restarts do servidor)
  try {
    const { data: row } = await supabase.from('cache_movimentos')
      .select('movimentos, atualizado_em')
      .eq('numero_processo', numeroProcesso)
      .single();

    if (row && row.movimentos) {
      const idade = agora - new Date(row.atualizado_em).getTime();
      const movs  = row.movimentos;
      _cacheMovs.set(numeroProcesso, { movs, ts: agora });

      if (idade < CACHE_TTL_DB) {
        console.log(`[cache-db] ✅ hit: ${numeroProcesso} (${Math.round(idade/1000/60)}min)`);
        return movs;
      }

      // Cache expirado — retorna imediatamente e atualiza em background
      console.log(`[cache-db] expirado (${Math.round(idade/1000/60)}min) — retornando cache e atualizando em background`);
      atualizarCacheBackground(numeroProcesso);
      return movs;
    }
  } catch (_) {}

  // 3. Primeira vez — busca na Codilo (sem cache disponível)
  console.log(`[cache] miss total: ${numeroProcesso}, buscando na Codilo...`);
  const t1 = Date.now();
  const movs = await buscarMovimentacoes(numeroProcesso);
  console.log(`[codilo] busca total: ${Date.now() - t1}ms — ${movs?.length ?? 0} movimentações`);
  if (movs && movs.length > 0) salvarCache(numeroProcesso, movs);
  return movs;
}

// Deduplicação de mensagens recebidas via webhook
// Z-API pode reenviar a mesma mensagem em caso de timeout/retry
const _mensagensProcessadas = new Set();
function jaProcessada(msgId) {
  if (!msgId) return false;
  if (_mensagensProcessadas.has(msgId)) return true;
  _mensagensProcessadas.add(msgId);
  // Evita vazamento de memória: descarta entradas antigas quando passa de 2000
  if (_mensagensProcessadas.size > 2000) {
    const primeira = _mensagensProcessadas.values().next().value;
    _mensagensProcessadas.delete(primeira);
  }
  return false;
}

function normalizarTelefone(raw) {
  let tel = (raw || '').replace('@c.us','').replace('@s.whatsapp.net','').replace(/\D/g,'').replace(/^55/,'');
  if (tel.length === 10) tel = tel.substring(0,2) + '9' + tel.substring(2);
  return tel;
}


async function buscarMovimentacoes(numeroProcesso) {
  const tribunal = detectarTribunal(numeroProcesso);
  console.log('Buscando processo:', numeroProcesso, 'no tribunal:', tribunal);
  try {
    const movs = await consultarProcesso(numeroProcesso, tribunal);
    console.log('[codilo] movimentos encontrados:', movs?.length ?? 0);
    return movs || [];
  } catch (err) {
    console.error('[codilo] erro:', err.message);
    return [];
  }
}

async function gerarResumo(movimentacao) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Voce e um assistente juridico. Resuma em linguagem simples, maximo 3 linhas. Movimentacao: ' + movimentacao }] },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
  );
  return res.data.choices[0].message.content;
}

function mensagemPerguntaSobreProcesso(msg) {
  return /processo|moviment|prazo|audiên|decisão|sentença|recurso|andament|atualiz|aconteceu|novidade|status|o que|como (está|tá|ficou)|teve|tem|última|ultimo|recente|passou|ocorreu|andou|julgamento|despacho|intimação|citação/i.test(msg);
}

async function gerarRespostaChatbot(mensagem, nome, processos, escritorio) {
  let infoProcessos = '';

  // Só consulta Codilo se cliente perguntou sobre o processo — senão usa cache ou responde sem dados
  const precisaDados = mensagemPerguntaSobreProcesso(mensagem);

  for (const processo of processos) {
    infoProcessos += '\nProcesso — cliente: ' + processo.nome_cliente + ':\n';
    if (precisaDados) {
      const movs = await buscarMovimentacoesCache(processo.numero_processo);
      if (movs && movs.length > 0) {
        infoProcessos += 'Últimas 3 movimentações (apresente cada uma em 1 frase curta e simples, sem juridiquês):\n';
        movs.slice(0, 3).forEach(m => {
          infoProcessos += '- ' + m.nome + ' (' + m.data + ')\n';
        });
      } else {
        infoProcessos += 'Sem movimentações registradas — processo aguardando movimentação do tribunal.\n';
      }
    }
  }

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 400,
      timeout: 20000,
      messages: [
        {
          role: 'system',
          content: `PROIBIÇÃO ABSOLUTA E INQUEBRÁVEL: NUNCA, em hipótese alguma, diga ao cliente para entrar em contato com o advogado, ligar para o escritório, agendar consulta, buscar atendimento presencial, ou qualquer frase que redirecione o cliente para fora deste chat. Frases como "entre em contato com seu advogado", "consulte o escritório", "fale com o advogado responsável", "agende uma consulta", "procure orientação jurídica presencial" são ESTRITAMENTE PROIBIDAS. Se você disser qualquer variação disso, estará falhando na sua função.

Você é Lex, assistente jurídico virtual do escritório ${escritorio || 'de advocacia'}, atendendo o cliente ${nome}. Você tem conhecimento completo do direito brasileiro e responde TODAS as dúvidas você mesmo, sem redirecionar para ninguém.

REGRAS:
- NUNCA peça número de processo, CPF ou qualquer dado — o cliente já está identificado
- Respostas CURTAS e DIRETAS — máximo 3 frases no total
- Linguagem simples e acolhedora — sem juridiquês
- Quando perguntar sobre o processo: liste as 3 últimas movimentações, cada uma em 1 frase curta e simples, depois diga em 1 frase o que isso significa
- Para dúvidas jurídicas: responda com precisão em no máximo 2 frases
- Se não houver movimentações: diga em 1 frase que o processo segue em andamento aguardando o tribunal

SEU CONHECIMENTO ABRANGE: Direito Civil, Trabalhista, Criminal, Tributário, Previdenciário, de Família, do Consumidor, Administrativo e Constitucional. CPC, CLT, CC, CP, CDC e toda a legislação brasileira vigente.

PROCESSOS DO CLIENTE ${nome.toUpperCase()}:
${infoProcessos || 'Nenhuma movimentação registrada no momento — processo em andamento normal aguardando próxima movimentação do tribunal.'}`
        },
        { role: 'user', content: mensagem }
      ]
    },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY }, timeout: 20000 }
  );
  return res.data.choices[0].message.content;
}

async function salvarMensagem(usuario_id, telefone, nome_cliente, remetente, conteudo) {
  await supabase.from('mensagens').insert({ usuario_id, telefone, nome_cliente, remetente, conteudo });
}

async function jaFoiEnviada(processoId, descricao) {
  const { data } = await supabase.from('movimentacoes').select('id').eq('processo_id', processoId).eq('descricao', descricao).single();
  return !!data;
}

async function enviarWhatsApp(telefone, mensagem) {
  // Normaliza telefone: remove tudo que não é número e garante prefixo 55
  const nums = telefone.replace(/\D/g, '');
  const fone = nums.startsWith('55') ? nums : '55' + nums;
  console.log('Enviando para:', fone);
  const res = await axios.post(
    EVOLUTION_URL,
    { phone: fone, message: mensagem },
    { headers: { 'Client-Token': EVOLUTION_CLIENT_TOKEN } }
  );
  console.log('Z-API resposta:', JSON.stringify(res.data));
  if (res.data && res.data.error) {
    throw new Error('Z-API: ' + res.data.error);
  }
}

async function salvarMovimentacao(processoId, descricao, resumo) {
  await supabase.from('movimentacoes').insert({ processo_id: processoId, descricao, resumo_ia: resumo, relevante: true, enviado_whatsapp: true });
}

async function enviarBoasVindas(processo, escritorio) {
  const mensagem = 'Ola, ' + processo.nome_cliente + '! 👋\n\n' +
    'Seu processo foi cadastrado no sistema do escritório *' + escritorio + '*.\n\n' +
    '✅ A partir de agora você receberá atualizações automáticas sempre que houver movimentação no seu processo.\n\n' +
    '💬 Qualquer dúvida é só me perguntar aqui mesmo!\n\n' +
    '_Sistema Praetor AI_';
  await enviarWhatsApp(processo.telefone_cliente, mensagem);
}


app.get('/', (req, res) => res.send('Sistema juridico rodando!'));

app.get('/processos/:numero/detalhes', async (req, res) => {
  const numero = decodeURIComponent(req.params.numero);
  const tribunal = detectarTribunal(numero);
  try {
    const dados = await consultarProcessoCompleto(numero, tribunal);
    if (!dados) return res.json({ capa: {}, partes: [], movimentacoes: [] });

    // Tenta filtrar pelos últimos 3 anos; se não sobrar nada, usa todas as movimentações
    const anosVisiveis = [0, 1, 2, 3, 4].map(n => String(new Date().getFullYear() - n));
    const filtradas = dados.movimentacoes.filter(m => m.data && anosVisiveis.some(a => m.data.includes('/' + a)));
    dados.movimentacoes = filtradas.length > 0 ? filtradas : dados.movimentacoes;

    // Gera explicações para as movimentações
    const unicos = [...new Set(dados.movimentacoes.map(m => m.nome))].slice(0, 25);
    let explicacoes = {};
    try {
      const resp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          max_tokens: 1200,
          messages: [
            { role: 'system', content: 'Você é um assistente jurídico brasileiro. Para cada movimentação listada, escreva um parágrafo de 2 a 3 frases explicando o que significa e qual o impacto para o processo, em linguagem simples para leigos. Responda APENAS em JSON válido: {"nome da movimentação": "explicação"}. Nada fora do JSON.' },
            { role: 'user', content: unicos.join('\n') }
          ]
        },
        { headers: { Authorization: 'Bearer ' + OPENAI_KEY }, timeout: 15000 }
      );
      const match = resp.data.choices[0].message.content.match(/\{[\s\S]*\}/);
      if (match) explicacoes = JSON.parse(match[0]);
    } catch (e) {
      console.error('[explicar]', e.message);
    }

    res.json({
      capa: dados.capa,
      partes: dados.partes,
      movimentacoes: dados.movimentacoes.map(m => ({ ...m, resumo: explicacoes[m.nome] || '' }))
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/processos/explicar', async (req, res) => {
  const { movimentos } = req.body;
  if (!movimentos || !movimentos.length) return res.json({});
  const unicos = [...new Set(movimentos)].slice(0, 25);
  try {
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        max_tokens: 600,
        messages: [
          { role: 'system', content: 'Você é um assistente jurídico brasileiro. Para cada movimentação processual listada, escreva UMA frase curta (máximo 12 palavras) explicando o que significa em linguagem simples para leigos. Responda APENAS em JSON válido no formato: {"nome exato da movimentação": "explicação simples"}. Não inclua nada fora do JSON.' },
          { role: 'user', content: unicos.join('\n') }
        ]
      },
      { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
    );
    const content = resp.data.choices[0].message.content;
    const match = content.match(/\{[\s\S]*\}/);
    res.json(match ? JSON.parse(match[0]) : {});
  } catch (e) {
    console.error('[explicar]', e.message);
    res.json({});
  }
});

app.post('/auth/cadastro', async (req, res) => {
  const { nome, email, senha, escritorio } = req.body;
  if (!nome || !email || !senha || !escritorio) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  try {
    const { data: existe } = await supabase.from('usuarios').select('id').eq('email', email).single();
    if (existe) return res.status(400).json({ erro: 'Email ja cadastrado.' });
    const { error } = await supabase.from('usuarios').insert({ nome, email, senha, escritorio });
    if (error) return res.status(400).json({ erro: error.message });
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao cadastrar. Tente novamente.' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  try {
    const { data, error } = await supabase.from('usuarios').select('*').eq('email', email).eq('senha', senha).single();
    if (error || !data) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
    res.json({ sucesso: true, usuario: { id: data.id, nome: data.nome, email: data.email, escritorio: data.escritorio, telefone: data.telefone || '', oab: data.oab || '', estado: data.estado || '', horario_alerta: data.horario_alerta || '08:00', tipos_alerta: data.tipos_alerta || 'urgente,semana' } });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao fazer login. Tente novamente.' });
  }
});

app.post('/processos', async (req, res) => {
  const { numero_processo, nome_cliente, telefone_cliente, usuario_id } = req.body;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatorio.' });
  const { data, error } = await supabase.from('processos').insert({ numero_processo, nome_cliente, telefone_cliente, usuario_id });
  if (error) return res.status(400).json({ erro: error.message });

  try {
    const { data: usuario } = await supabase.from('usuarios').select('escritorio').eq('id', usuario_id).single();
    const escritorio = usuario ? usuario.escritorio : 'nosso escritorio';
    await enviarBoasVindas({ nome_cliente, telefone_cliente }, escritorio);
    console.log('Boas vindas enviadas para ' + nome_cliente);
  } catch (err) {
    console.error('Erro boas vindas:', err.message);
  }

  res.json({ sucesso: true, data });
});

app.get('/processos', async (req, res) => {
  const { usuario_id } = req.query;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatorio.' });
  try {
    const { data } = await supabase.from('processos').select('*').eq('usuario_id', usuario_id);
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar processos.' });
  }
});

app.get('/movimentacoes', async (req, res) => {
  const { usuario_id } = req.query;
  if (!usuario_id) return res.json([]);
  try {
    const { data: procs } = await supabase.from('processos').select('id').eq('usuario_id', usuario_id);
    if (!procs || !procs.length) return res.json([]);
    const ids = procs.map(p => p.id);
    const { data } = await supabase.from('movimentacoes').select('*, processos(nome_cliente, numero_processo)').in('processo_id', ids).order('detectado_em', { ascending: false }).limit(20);
    res.json(data || []);
  } catch (err) {
    res.json([]);
  }
});

app.post('/perfil/telefone', async (req, res) => {
  const { usuario_id, telefone } = req.body;
  if (!usuario_id || !telefone) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  const { error } = await supabase.from('usuarios').update({ telefone }).eq('id', usuario_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/perfil/escritorio', async (req, res) => {
  const { usuario_id, escritorio } = req.body;
  if (!usuario_id || !escritorio) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  const { error } = await supabase.from('usuarios').update({ escritorio }).eq('id', usuario_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/perfil/config', async (req, res) => {
  const { usuario_id, telefone, horario_alerta, tipos_alerta, escritorio, oab, estado } = req.body;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatório.' });
  const campos = {};
  if (telefone !== undefined) campos.telefone = telefone;
  if (horario_alerta !== undefined) campos.horario_alerta = horario_alerta;
  if (tipos_alerta !== undefined) campos.tipos_alerta = tipos_alerta;
  if (escritorio !== undefined) campos.escritorio = escritorio;
  if (oab !== undefined) campos.oab = oab;
  if (estado !== undefined) campos.estado = estado;
  if (!Object.keys(campos).length) return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });
  const { error } = await supabase.from('usuarios').update(campos).eq('id', usuario_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/perfil/senha', async (req, res) => {
  const { usuario_id, senha_atual, senha_nova } = req.body;
  if (!usuario_id || !senha_atual || !senha_nova) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  const { data } = await supabase.from('usuarios').select('senha').eq('id', usuario_id).single();
  if (!data || data.senha !== senha_atual) return res.status(401).json({ erro: 'Senha atual incorreta.' });
  const { error } = await supabase.from('usuarios').update({ senha: senha_nova }).eq('id', usuario_id);
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});


app.post('/testar-whatsapp', async (req, res) => {
  const { telefone, nome } = req.body;
  try {
    await enviarWhatsApp(telefone, 'Ola, ' + nome + '! Teste do sistema Praetor AI.');
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (!body || body.fromMe || body.isGroup) return res.sendStatus(200);

    // Extrai ID único da mensagem (Z-API envia messageId ou id)
    const msgId = body.messageId || body.id || (body.data && body.data.key && body.data.key.id);
    console.log('Webhook recebido | msgId:', msgId, '| campos payload:', Object.keys(body).join(', '));
    if (jaProcessada(msgId)) {
      console.log('Mensagem duplicada ignorada:', msgId);
      return res.sendStatus(200);
    }

    const telefone = normalizarTelefone(body.phone || body.from);
    const mensagem = (body.text && body.text.message) ||
                     (body.texto && body.texto.mensagem) ||
                     body.message || body.body || null;

    console.log('Tel:', telefone, '| Msg:', mensagem);
    if (!telefone || !mensagem) return res.sendStatus(200);

    const { data: processos } = await supabase.from('processos').select('*').eq('telefone_cliente', telefone);
    console.log('Processos:', processos ? processos.length : 0);

    if (!processos || !processos.length) {
      await enviarWhatsApp(telefone, 'Ola! Nao encontrei seu cadastro. Entre em contato com o escritorio.');
      return res.sendStatus(200);
    }

    const { data: usuario } = await supabase.from('usuarios').select('escritorio').eq('id', processos[0].usuario_id).single();
    const escritorio = usuario ? usuario.escritorio : 'nosso escritorio';

    await salvarMensagem(processos[0].usuario_id, telefone, processos[0].nome_cliente, 'cliente', mensagem);



    const tChatbot = Date.now();
    const resposta = await gerarRespostaChatbot(mensagem, processos[0].nome_cliente, processos, escritorio);
    console.log(`[webhook] ⏱ gerarRespostaChatbot: ${Date.now() - tChatbot}ms`);
    const tWpp = Date.now();
    await enviarWhatsApp(telefone, resposta);
    console.log(`[webhook] ⏱ enviarWhatsApp: ${Date.now() - tWpp}ms`);
    await salvarMensagem(processos[0].usuario_id, telefone, processos[0].nome_cliente, 'bot', resposta);
    console.log('Resposta enviada para ' + processos[0].nome_cliente);
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook:', err.message);
    res.sendStatus(200);
  }
});

// Detecta se o advogado quer enviar mensagem ao cliente
function detectarIntencaoEnvio(pergunta) {
  const p = pergunta.toLowerCase();
  return /manda|envia|notifica|avisa|comunica|fala para|fala pra|mande|envie/.test(p);
}

// Detecta se a pergunta é sobre o processo (precisa do contexto)
function perguntaSobreProcesso(pergunta) {
  const p = pergunta.toLowerCase();
  return /processo|moviment|prazo|audiên|decisão|sentença|recurso|andament|atualiz|aconteceu|novidade|status|cliente|o que|como está|como tá|teve|tem|última|ultimo|recente|passou|ocorreu|andou|sim|não|nao/.test(p);
}

// Encontra o(s) processo(s) mencionados na pergunta pelo nome do cliente
function encontrarClientesMencionados(pergunta, processos) {
  const p = pergunta.toLowerCase();
  const encontrados = processos.filter(proc =>
    proc.nome_cliente.toLowerCase().split(' ').some(parte => parte.length > 3 && p.includes(parte))
  );
  return encontrados.length ? encontrados : processos; // se não identificou, envia para todos
}

// Chat do advogado com a IA sobre seus processos
app.post('/chat-advogado', async (req, res) => {
  const { usuario_id, pergunta, processo_id } = req.body;
  if (!usuario_id || !pergunta) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  const tTotal = Date.now();
  console.log(`[chat-advogado] ▶ início | pergunta: "${pergunta.substring(0, 60)}..."`);
  try {
    let query = supabase.from('processos').select('*').eq('usuario_id', usuario_id);
    if (processo_id) query = query.eq('id', processo_id);
    const { data: processos } = await query;
    if (!processos || !processos.length) return res.json({ resposta: 'Nenhum processo cadastrado ainda.' });

    const { data: usuario } = await supabase.from('usuarios').select('escritorio, nome').eq('id', usuario_id).single();
    const escritorio = usuario ? usuario.escritorio : 'nosso escritório';
    const nomeAdvogado = usuario ? usuario.nome : 'Advogado';

    // Busca movimentações de todos os processos em paralelo
    const tMovs = Date.now();
    const resultados = await Promise.all(processos.map(async p => {
      let movs = await buscarMovimentacoesCache(p.numero_processo);
      // Se cache retornou vazio, tenta busca completa ignorando cache
      if (!movs || movs.length === 0) {
        console.log(`[chat-advogado] cache vazio para ${p.numero_processo}, tentando busca direta...`);
        movs = await buscarMovimentacoes(p.numero_processo);
      }
      return { ...p, movs: movs || [] };
    }));
    console.log(`[chat-advogado] ⏱ busca movimentações (${processos.length} processos): ${Date.now() - tMovs}ms`);
    const dadosProcessos = resultados;

    // Se pergunta sobre movimentações, passa pela IA para explicar cada dia
    if (perguntaSobreProcesso(pergunta) && !detectarIntencaoEnvio(pergunta)) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let contextoMovs = '';
      for (const p of dadosProcessos) {
        contextoMovs += 'Cliente: ' + p.nome_cliente + '\n';
        if (p.movs.length) {
          contextoMovs += 'Últimas 3 movimentações:\n';
          p.movs.slice(0, 3).forEach(m => {
            contextoMovs += '- ' + m.nome + ' (' + m.data + ')\n';
          });
        } else {
          contextoMovs += 'Sem movimentações registradas.\n';
        }
      }

      const tOpenAI = Date.now();
      console.log(`[chat-advogado] ⏱ antes OpenAI (ramo movimentações): ${Date.now() - tTotal}ms`);
      const streamResp = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o-mini',
          stream: true,
          messages: [
            { role: 'system', content: `Você é Lex, assistente jurídico especializado do escritório ${escritorio}, com domínio completo do direito brasileiro. Os processos já estão identificados abaixo — NUNCA peça número do processo ou qualquer dado de identificação.

SEU PERFIL:
- Conhecimento profundo em todas as áreas do direito brasileiro: civil, trabalhista, criminal, tributário, previdenciário, família, consumidor, administrativo e constitucional
- Domínio do CPC, CLT, CC, CP, CDC e demais legislações
- Conhecimento sobre prazos processuais, recursos cabíveis, fases do processo e procedimentos dos tribunais
- Capacidade de explicar qualquer movimentação processual de forma clara e detalhada

COMO RESPONDER:
- Respostas CURTAS e DIRETAS — máximo 3 frases no total
- NUNCA mencione o número do processo na resposta — refira-se sempre pelo nome do cliente
- NUNCA diga para verificar no portal do tribunal, no sistema, ou em qualquer lugar externo
- Quando perguntar sobre movimentações: liste as 3 últimas, cada uma em 1 frase, depois diga em 1 frase o que isso significa e qual a próxima etapa
- Se não houver movimentações: diga apenas que o processo está aguardando movimentação do tribunal
- Para dúvidas jurídicas: responda com precisão técnica de forma concisa
- Nunca invente dados processuais que não estejam nos dados abaixo

PROCESSOS IDENTIFICADOS:
${contextoMovs}` },
            { role: 'user', content: pergunta }
          ]
        },
        { headers: { Authorization: 'Bearer ' + OPENAI_KEY }, responseType: 'stream' }
      );
      console.log(`[chat-advogado] ⏱ OpenAI conectou: ${Date.now() - tOpenAI}ms`);

      await new Promise((resolve) => {
        let buf = '';
        streamResp.data.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') return;
            try {
              const token = JSON.parse(data).choices[0]?.delta?.content || '';
              if (token) res.write('data: ' + JSON.stringify({ token }) + '\n\n');
            } catch (e) {}
          }
        });
        streamResp.data.on('end', resolve);
      });

      console.log(`[chat-advogado] ✅ total: ${Date.now() - tTotal}ms`);
      res.write('data: ' + JSON.stringify({ done: true, mensagens_pendentes: [] }) + '\n\n');
      res.end();
      return;
    }

    let contexto = '';
    if (detectarIntencaoEnvio(pergunta)) {
      contexto = 'Processos do escritório:\n';
      for (const p of dadosProcessos) {
        contexto += '\nProcesso ' + p.numero_processo + ' — Cliente: ' + p.nome_cliente + '\n';
        if (p.movs.length) {
          contexto += 'Movimentações:\n';
          p.movs.forEach(m => { contexto += '- ' + m.nome + ' (' + m.data + ')\n'; });
        } else {
          contexto += 'Sem movimentações recentes.\n';
        }
      }
    }

    // Streaming SSE para o frontend
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const tOpenAI2 = Date.now();
    console.log(`[chat-advogado] ⏱ antes OpenAI (ramo geral): ${Date.now() - tTotal}ms`);
    const streamResp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'system', content: `Você é Lex, assistente jurídico especializado do escritório ${escritorio}, auxiliando o advogado ${nomeAdvogado}. Os processos já estão identificados — NUNCA peça número de processo ou qualquer dado de identificação.

SEU PERFIL:
- Conhecimento profundo em todas as áreas do direito brasileiro: civil, trabalhista, criminal, tributário, previdenciário, família, consumidor, administrativo e constitucional
- Domínio do CPC, CLT, CC, CP, CDC e demais legislações vigentes
- Conhecimento sobre prazos processuais, recursos cabíveis, fases do processo e procedimentos dos tribunais brasileiros
- Capacidade de redigir peças, notificações e mensagens profissionais

COMO RESPONDER:
- Respostas CURTAS e DIRETAS — máximo 3 frases no total
- NUNCA mencione o número do processo na resposta — refira-se sempre pelo nome do cliente
- NUNCA diga para verificar no portal do tribunal, no sistema, ou em qualquer lugar externo
- Quando perguntar sobre movimentações: liste as 3 últimas, cada uma em 1 frase, depois diga em 1 frase o que significa e qual a próxima etapa
- Se não houver movimentações: diga apenas que o processo está aguardando movimentação do tribunal
- Para dúvidas jurídicas: responda com precisão técnica de forma concisa
- Para redigir mensagens: linguagem simples e profissional
- Nunca invente dados que não estejam nos dados abaixo

${contexto}` },
          { role: 'user', content: pergunta }
        ]
      },
      { headers: { Authorization: 'Bearer ' + OPENAI_KEY }, responseType: 'stream' }
    );
    console.log(`[chat-advogado] ⏱ OpenAI conectou: ${Date.now() - tOpenAI2}ms`);

    let respostaFinal = '';
    await new Promise((resolve) => {
      let buf = '';
      streamResp.data.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            const token = JSON.parse(data).choices[0]?.delta?.content || '';
            if (token) {
              respostaFinal += token;
              res.write('data: ' + JSON.stringify({ token }) + '\n\n');
            }
          } catch (e) {}
        }
      });
      streamResp.data.on('end', resolve);
    });

    // Se pediu envio ao cliente, gera prévia
    let mensagensPendentes = [];
    if (detectarIntencaoEnvio(pergunta)) {
      const alvo = encontrarClientesMencionados(pergunta, dadosProcessos);
      for (const proc of alvo) {
        let contextoCliente = 'Processo ' + proc.numero_processo + ':\n';
        if (proc.movs && proc.movs.length) {
          proc.movs.forEach(m => { contextoCliente += '- ' + m.nome + ' (' + m.data + ')\n'; });
        } else { contextoCliente += 'Sem movimentações recentes.\n'; }
        const msgCliente = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          { model: 'gpt-4o-mini', messages: [
            { role: 'system', content: 'Você é um assistente do escritório ' + escritorio + '. Escreva uma mensagem de WhatsApp para o cliente ' + proc.nome_cliente + ' em linguagem simples e amigável. Máximo 5 linhas.' },
            { role: 'user', content: 'Novidades: ' + contextoCliente }
          ]},
          { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
        );
        mensagensPendentes.push({ nome_cliente: proc.nome_cliente, telefone_cliente: proc.telefone_cliente, mensagem: msgCliente.data.choices[0].message.content });
      }
    }

    console.log(`[chat-advogado] ✅ total: ${Date.now() - tTotal}ms`);
    res.write('data: ' + JSON.stringify({ done: true, mensagens_pendentes: mensagensPendentes }) + '\n\n');
    res.end();
  } catch (err) {
    res.write('data: ' + JSON.stringify({ erro: err.message }) + '\n\n');
    res.end();
  }
});

// Lista de conversas — último mensagem por telefone
app.get('/mensagens/conversas', async (req, res) => {
  const { usuario_id } = req.query;
  if (!usuario_id) return res.json([]);
  try {
    const { data } = await supabase.from('mensagens').select('*').eq('usuario_id', usuario_id).order('criado_em', { ascending: false });
    if (!data || !data.length) return res.json([]);
    const seen = new Set();
    const conversas = [];
    for (const msg of data) {
      if (!seen.has(msg.telefone)) { seen.add(msg.telefone); conversas.push(msg); }
    }
    res.json(conversas);
  } catch (err) {
    res.json([]);
  }
});

// Histórico completo de uma conversa
app.get('/mensagens/conversa', async (req, res) => {
  const { usuario_id, telefone } = req.query;
  if (!usuario_id || !telefone) return res.json([]);
  try {
    const { data } = await supabase.from('mensagens').select('*').eq('usuario_id', usuario_id).eq('telefone', telefone).order('criado_em', { ascending: true });
    res.json(data || []);
  } catch (err) {
    res.json([]);
  }
});

// Advogado envia mensagem pelo dashboard
app.post('/mensagens/enviar', async (req, res) => {
  const { usuario_id, telefone, conteudo, nome_cliente } = req.body;
  if (!usuario_id || !telefone || !conteudo) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  try {
    const nums = telefone.replace(/\D/g, '');
    const fone = nums.startsWith('55') ? nums : '55' + nums;
    console.log('[enviar] telefone recebido:', telefone, '→ normalizado:', fone);
    console.log('[enviar] EVOLUTION_URL:', EVOLUTION_URL);
    const zRes = await axios.post(
      EVOLUTION_URL,
      { phone: fone, message: conteudo },
      { headers: { 'Client-Token': EVOLUTION_CLIENT_TOKEN } }
    );
    console.log('[enviar] Z-API status:', zRes.status, 'body:', JSON.stringify(zRes.data));
    if (zRes.data && zRes.data.error) throw new Error('Z-API: ' + zRes.data.error);
    await salvarMensagem(usuario_id, fone, nome_cliente || 'Cliente', 'advogado', conteudo);
    res.json({ sucesso: true, zapi: zRes.data });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ─── AGENDA DE PRAZOS ────────────────────────────────────────────────────────

const PALAVRAS_PRAZO_AGENDA = ['prazo','audiência','audiencia','decisão','decisao','sentença','sentenca','intimação','intimacao','despacho','julgamento','recurso','citação','citacao','mandado','penhora','bloqueio','concluso','publicado','diário','diario'];

function detectarUrgencia(descricao, dataMovimentacao) {
  const hoje = new Date();
  const dataM = new Date(dataMovimentacao.split('/').reverse().join('-'));
  const diffDias = isNaN(dataM) ? 999 : Math.floor((hoje - dataM) / (1000 * 60 * 60 * 24));
  const desc = descricao.toLowerCase();
  if (desc.includes('audiên') || desc.includes('audienc') || desc.includes('sentença') || desc.includes('sentenca') || desc.includes('decisão') || desc.includes('decisao')) return 'urgente';
  if (diffDias <= 7) return 'esta_semana';
  return 'normal';
}

async function sincronizarPrazos(usuarioId) {
  const { data: processos } = await supabase.from('processos').select('*').eq('usuario_id', usuarioId);
  if (!processos || !processos.length) return;

  for (const proc of processos) {
    try {
      const movs = (await buscarMovimentacoesCache(proc.numero_processo)) || [];
      const importantes = movs.filter(m => {
        const n = m.nome.toLowerCase();
        return PALAVRAS_PRAZO_AGENDA.some(p => n.includes(p));
      });

      for (const mov of importantes) {
        if (!mov.data || mov.data === '—' || !mov.data.includes('/')) continue;

        const { data: existe } = await supabase.from('prazos')
          .select('id').eq('processo_id', proc.id).eq('descricao', mov.nome).eq('data_movimentacao', mov.data).single();
        if (existe) continue;

        const urgencia = detectarUrgencia(mov.nome, mov.data);
        await supabase.from('prazos').insert({
          processo_id: proc.id,
          usuario_id: usuarioId,
          numero_processo: proc.numero_processo,
          nome_cliente: proc.nome_cliente,
          descricao: mov.nome,
          data_movimentacao: mov.data,
          urgencia
        });
      }
    } catch (e) { console.error('[prazos]', e.message); }
  }
}

app.get('/prazos', async (req, res) => {
  const { usuario_id } = req.query;
  if (!usuario_id) return res.json([]);

  // Retorna prazos já salvos imediatamente
  const { data } = await supabase.from('prazos').select('*')
    .eq('usuario_id', usuario_id).eq('visto', false)
    .order('criado_em', { ascending: false });
  res.json(data || []);

  // Sincroniza em background sem bloquear a resposta
  sincronizarPrazos(usuario_id).catch(e => console.error('[prazos sync]', e.message));
});

app.post('/prazos/sincronizar', async (req, res) => {
  const { usuario_id } = req.body;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatorio' });
  try {
    await sincronizarPrazos(usuario_id);
    res.json({ sucesso: true, mensagem: 'Sincronização concluída' });
  } catch (e) {
    console.error('[prazos sync]', e.message);
    res.json({ sucesso: true, mensagem: 'Sincronização concluída com erros' });
  }
});

app.post('/prazos/:id/visto', async (req, res) => {
  const { id } = req.params;
  try {
    await supabase.from('prazos').update({ visto: true }).eq('id', id);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao marcar prazo.' });
  }
});

async function enviarAlertaPrazos() {
  console.log('[agenda] enviando alertas de prazo...');
  const { data: usuarios } = await supabase.from('usuarios').select('*');
  if (!usuarios) return;

  for (const usuario of usuarios) {
    if (!usuario.telefone) continue;
    try {
      const { data: prazos } = await supabase.from('prazos').select('*')
        .eq('usuario_id', usuario.id).eq('visto', false)
        .in('urgencia', ['urgente', 'esta_semana'])
        .order('urgencia', { ascending: true });

      if (!prazos || !prazos.length) continue;

      const urgentes = prazos.filter(p => p.urgencia === 'urgente');
      const semana = prazos.filter(p => p.urgencia === 'esta_semana');

      let msg = '⚖️ *Praetor AI — Agenda do dia*\n\n';
      if (urgentes.length) {
        msg += '🔴 *ATENÇÃO IMEDIATA*\n';
        urgentes.forEach(p => { msg += '• ' + p.descricao + ' — ' + p.nome_cliente + '\n  Proc. ' + p.numero_processo + '\n  Data: ' + p.data_movimentacao + '\n\n'; });
      }
      if (semana.length) {
        msg += '🟡 *ESTA SEMANA*\n';
        semana.forEach(p => { msg += '• ' + p.descricao + ' — ' + p.nome_cliente + '\n  Proc. ' + p.numero_processo + '\n  Data: ' + p.data_movimentacao + '\n\n'; });
      }
      msg += '_Acesse o Praetor AI para detalhes._';

      await enviarWhatsApp(usuario.telefone, msg);
      console.log('[agenda] alerta enviado para', usuario.nome);
    } catch (e) { console.error('[agenda]', e.message); }
  }
}

cron.schedule('0 8 * * *', enviarAlertaPrazos); // Alerta de prazos urgentes só para o advogado

// Ping a cada 10 minutos para evitar cold start no Render
cron.schedule('*/10 * * * *', () => {
  axios.get('https://juridico-mvp.onrender.com/').catch(() => {});
});

app.listen(3000, () => console.log('Servidor rodando em http://localhost:3000'));