require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

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
  '8.01':'tjac','8.02':'tjal','8.03':'tjap','8.04':'tjam','8.05':'tjba',
  '8.06':'tjce','8.07':'tjdft','8.08':'tjes','8.09':'tjgo','8.10':'tjma',
  '8.11':'tjmt','8.12':'tjms','8.13':'tjmg','8.14':'tjpa','8.15':'tjpb',
  '8.16':'tjpr','8.17':'tjpe','8.18':'tjpi','8.19':'tjrj','8.20':'tjrn',
  '8.21':'tjrs','8.22':'tjro','8.23':'tjrr','8.24':'tjsc','8.25':'tjse',
  '8.26':'tjsp','8.27':'tjto','4.01':'trf1','4.02':'trf2','4.03':'trf3',
  '4.04':'trf4','4.05':'trf5','5.01':'trt1','5.02':'trt2','5.03':'trt3',
  '5.04':'trt4','5.05':'trt5','5.06':'trt6','5.07':'trt7','5.08':'trt8',
  '5.09':'trt9','5.10':'trt10','5.11':'trt11','5.12':'trt12','5.13':'trt13',
  '5.14':'trt14','5.15':'trt15','5.16':'trt16','5.17':'trt17','5.18':'trt18',
  '5.19':'trt19','5.20':'trt20','5.21':'trt21','5.22':'trt22','5.23':'trt23',
  '5.24':'trt24'
};

function detectarTribunal(numeroProcesso) {
  const partes = numeroProcesso.replace(/\s/g,'').split('.');
  if (partes.length >= 4) {
    const codigo = partes[2] + '.' + partes[3].substring(0,2);
    if (TRIBUNAIS[codigo]) return TRIBUNAIS[codigo];
  }
  return 'tjal';
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
  try {
    const tribunal = detectarTribunal(numeroProcesso);
    // Remove pontos, traços e espaços para buscar no DataJud
    const numeroLimpo = numeroProcesso.replace(/[.\-\s]/g, '');
    console.log('Buscando processo:', numeroLimpo, 'no tribunal:', tribunal);

    const res = await axios.post(
      'https://api-publica.datajud.cnj.jus.br/api_publica_' + tribunal + '/_search',
      {
        query: {
          bool: {
            should: [
              { match: { numeroProcesso: numeroProcesso } },
              { wildcard: { numeroProcesso: numeroLimpo + '*' } },
              { wildcard: { numeroProcesso: '*' + numeroLimpo.substring(0, 13) + '*' } }
            ]
          }
        },
        size: 1
      },
      { headers: { Authorization: DATAJUD_KEY } }
    );

    const hits = (res.data && res.data.hits && res.data.hits.hits) || [];
    console.log('Hits encontrados:', hits.length);
    if (!hits.length) return [];

    const movimentos = (hits[0]._source && hits[0]._source.movimentos) || [];
    console.log('Movimentos encontrados:', movimentos.length);

    // Ordena por data e pega os 5 mais recentes
    const movimentosOrdenados = movimentos
      .filter(m => m.nome && m.dataHora)
      .sort((a, b) => new Date(b.dataHora) - new Date(a.dataHora))
      .slice(0, 5);

    return movimentosOrdenados.map(m => ({
      nome: m.nome,
      data: new Date(m.dataHora).toLocaleDateString('pt-BR')
    }));
  } catch (err) {
    console.error('Erro DataJud:', err.message);
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
  console.log('Enviando para:', '55' + telefone);
  const res = await axios.post(
    EVOLUTION_URL,
    { phone: '55' + telefone, message: mensagem },
    { headers: { 'Client-Token': EVOLUTION_CLIENT_TOKEN } }
  );
  console.log('Z-API:', JSON.stringify(res.data));
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
  res.json({ sucesso: true, usuario: { id: data.id, nome: data.nome, email: data.email, escritorio: data.escritorio } });
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

// Chat do advogado com a IA sobre seus processos
app.post('/chat-advogado', async (req, res) => {
  const { usuario_id, pergunta } = req.body;
  if (!usuario_id || !pergunta) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  try {
    const { data: processos } = await supabase.from('processos').select('*').eq('usuario_id', usuario_id);
    if (!processos || !processos.length) return res.json({ resposta: 'Nenhum processo cadastrado ainda.' });

    let contexto = 'Processos do escritório:\n';
    for (const p of processos) {
      contexto += '\nProcesso ' + p.numero_processo + ' — Cliente: ' + p.nome_cliente + '\n';
      const movs = await buscarMovimentacoes(p.numero_processo);
      if (movs.length) {
        contexto += 'Últimas movimentações:\n';
        movs.forEach(m => { contexto += '- ' + m.nome + ' (' + m.data + ')\n'; });
      } else {
        contexto += 'Sem movimentações recentes.\n';
      }
    }

    const resposta = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Você é um assistente jurídico especializado para advogados. Ao responder, seja EXTREMAMENTE detalhado e completo. Para cada movimentação, explique: o que significa juridicamente, qual o impacto no processo, quais os próximos passos prováveis e o que o advogado deve fazer. Não resuma — desenvolva cada ponto com profundidade. Use linguagem profissional mas acessível. Se houver múltiplos processos ou movimentações, trate cada um separadamente com títulos.\n\n' + contexto },
          { role: 'user', content: pergunta }
        ]
      },
      { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
    );
    res.json({ resposta: resposta.data.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ erro: err.message });
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
    await enviarWhatsApp(telefone, conteudo);
    await salvarMensagem(usuario_id, telefone, nome_cliente || 'Cliente', 'advogado', conteudo);
    res.json({ sucesso: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

cron.schedule('0 */6 * * *', verificarProcessos);

app.listen(3000, () => console.log('Servidor rodando em http://localhost:3000'));