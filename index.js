require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { buscarPorTribunal } = require('./scraper');
const { consultarProcesso } = require('./codilo');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENAI_KEY = process.env.OPENAI_KEY;
const DATAJUD_KEY = process.env.DATAJUD_KEY;
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

// Cache de movimentações — evita re-buscar a cada pergunta
const _cacheMovs = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos
async function buscarMovimentacoesCache(numeroProcesso) {
  const agora = Date.now();
  const cached = _cacheMovs.get(numeroProcesso);
  if (cached && agora - cached.ts < CACHE_TTL) {
    console.log('[cache] usando cache para', numeroProcesso);
    return cached.movs;
  }
  const movs = await buscarMovimentacoes(numeroProcesso);
  _cacheMovs.set(numeroProcesso, { movs, ts: agora });
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

function formatarCNJ(numero) {
  // Remove tudo que não é dígito
  const d = numero.replace(/\D/g, '');
  if (d.length !== 20) return null;
  // NNNNNNN-DD.AAAA.J.TT.OOOO
  return d.slice(0,7) + '-' + d.slice(7,9) + '.' + d.slice(9,13) + '.' + d.slice(13,14) + '.' + d.slice(14,16) + '.' + d.slice(16,20);
}

async function buscarMovimentacoes(numeroProcesso) {
  const tribunal = detectarTribunal(numeroProcesso);
  console.log('Buscando processo:', numeroProcesso, 'no tribunal:', tribunal);

  // 1. Codilo (fonte primária — cobre TJs, TRTs, TREs)
  if (process.env.CODILO_ID && process.env.CODILO_SECRET) {
    try {
      const movs = await consultarProcesso(numeroProcesso, tribunal);
      if (movs && movs.length > 0) {
        console.log('[codilo] movimentos encontrados:', movs.length);
        return movs;
      }
    } catch (err) {
      console.error('[codilo] erro:', err.message);
    }
  }

  // 2. Scraper direto (fallback secundário)
  try {
    const movs = await buscarPorTribunal(numeroProcesso, tribunal);
    if (movs && movs.length > 0) {
      console.log('[scraper] movimentos encontrados:', movs.length);
      return movs;
    }
  } catch (err) {
    console.error('[scraper] erro:', err.message);
  }

  // 3. DataJud como último fallback
  console.log('[datajud] scraper sem resultado, tentando DataJud...');
  const numeroCNJ = formatarCNJ(numeroProcesso.replace(/\D/g, '')) || numeroProcesso;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const res = await axios.post(
        'https://api-publica.datajud.cnj.jus.br/api_publica_' + tribunal + '/_search',
        {
          query: {
            bool: {
              should: [
                { term: { 'numeroProcesso.keyword': numeroCNJ } },
                { match: { numeroProcesso: numeroCNJ } },
                { match: { numeroProcesso: numeroProcesso } }
              ],
              minimum_should_match: 1
            }
          },
          size: 1
        },
        { headers: { Authorization: DATAJUD_KEY }, timeout: 20000 }
      );
      const hits = (res.data && res.data.hits && res.data.hits.hits) || [];
      if (!hits.length) return [];
      const movimentos = (hits[0]._source && hits[0]._source.movimentos) || [];
      console.log('[datajud] movimentos encontrados:', movimentos.length);
      return movimentos
        .filter(m => m.nome && m.dataHora)
        .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora))
        .map(m => ({ nome: m.nome, data: new Date(m.dataHora).toLocaleDateString('pt-BR') }));
    } catch (err) {
      console.error('[datajud] tentativa ' + tentativa + ':', err.message);
      if (tentativa < 3) await new Promise(r => setTimeout(r, 5000 * tentativa));
    }
  }
  return [];
}

async function gerarResumo(movimentacao) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Voce e um assistente juridico. Resuma em linguagem simples, maximo 3 linhas. Movimentacao: ' + movimentacao }] },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
  );
  return res.data.choices[0].message.content;
}

async function gerarRespostaChatbot(mensagem, nome, processos, escritorio) {
  let infoProcessos = '';
  for (const processo of processos) {
    const movs = await buscarMovimentacoes(processo.numero_processo);
    infoProcessos += '\nProcesso ' + processo.numero_processo + ':\n';
    if (movs.length > 0) {
      infoProcessos += 'Ultimas movimentacoes:\n';
      movs.forEach(m => {
        infoProcessos += '- ' + m.nome + ' (' + m.data + ')\n';
      });
    } else {
      infoProcessos += 'Sem movimentacoes encontradas no momento.\n';
    }
  }

  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Voce e um assistente juridico virtual do escritorio ' + (escritorio || 'de advocacia') + '. Responda de forma simples, clara e educada em portugues. Cliente: ' + nome + '.\n\nInformacoes dos processos:\n' + infoProcessos + '\n\nIMPORTANTE: Use as informacoes acima para responder de forma detalhada sobre as movimentacoes. Explique cada movimentacao em linguagem simples para o cliente entender. Se nao houver movimentacoes, diga para entrar em contato com o escritorio.'
        },
        { role: 'user', content: mensagem }
      ]
    },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
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

const PALAVRAS_PRAZO = ['prazo','audiência','audiencia','decisão','decisao','sentença','sentenca','intimação','intimacao','despacho','julgamento','recurso','citação','citacao','mandado','penhora','bloqueio'];

function movimentacaoImportante(nome) {
  const n = nome.toLowerCase();
  return PALAVRAS_PRAZO.some(p => n.includes(p));
}

async function alertarAdvogado(processo, mov, resumo) {
  try {
    const { data: usuario } = await supabase.from('usuarios').select('telefone, escritorio, nome').eq('id', processo.usuario_id).single();
    if (!usuario || !usuario.telefone) return;
    const msg = '⚖️ *Alerta Praetor AI*\n\n' +
      '📋 *Processo:* ' + processo.numero_processo + '\n' +
      '👤 *Cliente:* ' + processo.nome_cliente + '\n' +
      '📅 *Data:* ' + mov.data + '\n\n' +
      '🔔 *Movimentação:* ' + mov.nome + '\n\n' +
      '📝 *Resumo:* ' + resumo + '\n\n' +
      '_Acesse o Praetor AI para mais detalhes._';
    await enviarWhatsApp(usuario.telefone, msg);
    console.log('Alerta enviado ao advogado para processo ' + processo.numero_processo);
  } catch (err) {
    console.error('Erro ao alertar advogado:', err.message);
  }
}

async function verificarProcessos() {
  console.log('Verificando processos...');
  const { data: processos } = await supabase.from('processos').select('*');
  if (!processos || !processos.length) { console.log('Nenhum processo.'); return; }
  for (const processo of processos) {
    try {
      const movs = await buscarMovimentacoes(processo.numero_processo);
      for (const mov of movs) {
        if (await jaFoiEnviada(processo.id, mov.nome)) continue;
        const resumo = await gerarResumo(mov.nome);
        const msg = 'Ola, ' + processo.nome_cliente + '!\n\nSeu processo teve uma atualizacao em ' + mov.data + ':\n\n' + resumo + '\n\nDuvidas? Fale com o escritorio.';
        await enviarWhatsApp(processo.telefone_cliente, msg);
        await salvarMovimentacao(processo.id, mov.nome, resumo);
        console.log('Enviado para ' + processo.nome_cliente);
        // Alerta ao advogado se for movimentação importante
        if (movimentacaoImportante(mov.nome)) {
          await alertarAdvogado(processo, mov, resumo);
        }
      }
    } catch (err) { console.error('Erro:', err.message); }
  }
  console.log('Verificacao concluida.');
}

app.get('/', (req, res) => res.send('Sistema juridico rodando!'));

app.post('/auth/cadastro', async (req, res) => {
  const { nome, email, senha, escritorio } = req.body;
  if (!nome || !email || !senha || !escritorio) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  const { data: existe } = await supabase.from('usuarios').select('id').eq('email', email).single();
  if (existe) return res.status(400).json({ erro: 'Email ja cadastrado.' });
  const { error } = await supabase.from('usuarios').insert({ nome, email, senha, escritorio });
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  const { data, error } = await supabase.from('usuarios').select('*').eq('email', email).eq('senha', senha).single();
  if (error || !data) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
  res.json({ sucesso: true, usuario: { id: data.id, nome: data.nome, email: data.email, escritorio: data.escritorio, telefone: data.telefone || '' } });
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
  const { data } = await supabase.from('processos').select('*').eq('usuario_id', usuario_id);
  res.json(data);
});

app.get('/movimentacoes', async (req, res) => {
  const { usuario_id } = req.query;
  if (!usuario_id) return res.json([]);
  const { data: procs } = await supabase.from('processos').select('id').eq('usuario_id', usuario_id);
  if (!procs || !procs.length) return res.json([]);
  const ids = procs.map(p => p.id);
  const { data } = await supabase.from('movimentacoes').select('*, processos(nome_cliente, numero_processo)').in('processo_id', ids).order('detectado_em', { ascending: false }).limit(20);
  res.json(data);
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

app.post('/verificar', (req, res) => {
  verificarProcessos();
  res.json({ sucesso: true, mensagem: 'Verificacao iniciada!' });
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



    const resposta = await gerarRespostaChatbot(mensagem, processos[0].nome_cliente, processos, escritorio);
    await enviarWhatsApp(telefone, resposta);
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
  try {
    let query = supabase.from('processos').select('*').eq('usuario_id', usuario_id);
    if (processo_id) query = query.eq('id', processo_id);
    const { data: processos } = await query;
    if (!processos || !processos.length) return res.json({ resposta: 'Nenhum processo cadastrado ainda.' });

    const { data: usuario } = await supabase.from('usuarios').select('escritorio, nome').eq('id', usuario_id).single();
    const escritorio = usuario ? usuario.escritorio : 'nosso escritório';
    const nomeAdvogado = usuario ? usuario.nome : 'Advogado';

    // Busca movimentações de todos os processos em paralelo
    const resultados = await Promise.all(processos.map(async p => {
      const movs = await buscarMovimentacoesCache(p.numero_processo);
      return { ...p, movs };
    }));
    const dadosProcessos = resultados;

    // Se pergunta sobre movimentações, retorna direto sem passar pela IA
    if (perguntaSobreProcesso(pergunta) && !detectarIntencaoEnvio(pergunta)) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      for (const p of dadosProcessos) {
        let texto = '';
        if (p.movs.length) {
          p.movs.forEach(m => { texto += '- ' + m.nome + ' (' + m.data + ')\n'; });
        } else {
          texto = 'Sem movimentações registradas.';
        }
        res.write('data: ' + JSON.stringify({ token: texto }) + '\n\n');
      }
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

    const streamResp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        stream: true,
        messages: [
          { role: 'system', content: 'Você é o assistente jurídico do escritório ' + escritorio + ', auxiliando o advogado ' + nomeAdvogado + '. Apresente-se como assistente do escritório quando for a primeira mensagem.\n\nTom: profissional e acessível, como um assistente experiente de advocacia.\n\nVocê sabe:\n1. Informar movimentações dos processos com clareza\n2. Sugerir ações ao advogado com base nas movimentações\n3. Redigir mensagens de WhatsApp para clientes quando solicitado\n4. Responder dúvidas jurídicas gerais em linguagem clara\n\nRegras:\n- Nunca invente informações que não estão nos dados do processo\n- Quando houver movimentações, informe-as e sugira a ação mais adequada\n- Seja objetivo mas cordial\n- Responda sempre em português brasileiro\n\n' + contexto },
          { role: 'user', content: pergunta }
        ]
      },
      { headers: { Authorization: 'Bearer ' + OPENAI_KEY }, responseType: 'stream' }
    );

    let respostaFinal = '';
    await new Promise((resolve) => {
      streamResp.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
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
  const { data } = await supabase.from('mensagens').select('*').eq('usuario_id', usuario_id).order('criado_em', { ascending: false });
  if (!data || !data.length) return res.json([]);
  const seen = new Set();
  const conversas = [];
  for (const msg of data) {
    if (!seen.has(msg.telefone)) { seen.add(msg.telefone); conversas.push(msg); }
  }
  res.json(conversas);
});

// Histórico completo de uma conversa
app.get('/mensagens/conversa', async (req, res) => {
  const { usuario_id, telefone } = req.query;
  if (!usuario_id || !telefone) return res.json([]);
  const { data } = await supabase.from('mensagens').select('*').eq('usuario_id', usuario_id).eq('telefone', telefone).order('criado_em', { ascending: true });
  res.json(data || []);
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

cron.schedule('0 */6 * * *', verificarProcessos);

// Ping a cada 10 minutos para evitar cold start no Render
cron.schedule('*/10 * * * *', () => {
  axios.get('https://juridico-mvp.onrender.com/').catch(() => {});
});

app.listen(3000, () => console.log('Servidor rodando em http://localhost:3000'));