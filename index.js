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
const TRIBUNAL = process.env.TRIBUNAL || 'tjal';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();
app.use(cors());
app.use(express.json());

const TRIBUNAIS = {
  '8.01': 'tjac', '8.02': 'tjal', '8.03': 'tjap', '8.04': 'tjam',
  '8.05': 'tjba', '8.06': 'tjce', '8.07': 'tjdft', '8.08': 'tjes',
  '8.09': 'tjgo', '8.10': 'tjma', '8.11': 'tjmt', '8.12': 'tjms',
  '8.13': 'tjmg', '8.14': 'tjpa', '8.15': 'tjpb', '8.16': 'tjpr',
  '8.17': 'tjpe', '8.18': 'tjpi', '8.19': 'tjrj', '8.20': 'tjrn',
  '8.21': 'tjrs', '8.22': 'tjro', '8.23': 'tjrr', '8.24': 'tjsc',
  '8.25': 'tjse', '8.26': 'tjsp', '8.27': 'tjto',
  '4.01': 'trf1', '4.02': 'trf2', '4.03': 'trf3', '4.04': 'trf4', '4.05': 'trf5',
  '5.01': 'trt1', '5.02': 'trt2', '5.03': 'trt3', '5.04': 'trt4',
  '5.05': 'trt5', '5.06': 'trt6', '5.07': 'trt7', '5.08': 'trt8',
  '5.09': 'trt9', '5.10': 'trt10', '5.11': 'trt11', '5.12': 'trt12',
  '5.13': 'trt13', '5.14': 'trt14', '5.15': 'trt15', '5.16': 'trt16',
  '5.17': 'trt17', '5.18': 'trt18', '5.19': 'trt19', '5.20': 'trt20',
  '5.21': 'trt21', '5.22': 'trt22', '5.23': 'trt23', '5.24': 'trt24'
};

function detectarTribunal(numeroProcesso) {
  const partes = numeroProcesso.replace(/\s/g, '').split('.');
  if (partes.length >= 4) {
    const codigo = partes[2] + '.' + partes[3].substring(0, 2);
    if (TRIBUNAIS[codigo]) return TRIBUNAIS[codigo];
  }
  return 'tjal';
}

async function buscarMovimentacoes(numeroProcesso) {
  try {
    const tribunal = detectarTribunal(numeroProcesso);
    const res = await axios.post(
      'https://api-publica.datajud.cnj.jus.br/api_publica_' + tribunal + '/_search',
      { query: { match: { numeroProcesso } } },
      { headers: { Authorization: DATAJUD_KEY } }
    );
    const hits = res.data && res.data.hits && res.data.hits.hits || [];
    if (!hits.length) return [];
    return (hits[0]._source && hits[0]._source.movimentos || []).map(function(m) { return m.nome; }).filter(Boolean);
  } catch (err) {
    console.error('Erro DataJud:', err.message);
    return [];
  }
}

async function gerarResumo(movimentacao) {
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Voce e um assistente juridico. Resuma em linguagem simples, maximo 3 linhas. Movimentacao: ' + movimentacao }]
    },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
  );
  return res.data.choices[0].message.content;
}

async function gerarRespostaChatbot(mensagemCliente, nomeCliente, processos) {
  const listaProcessos = processos.map(function(p) { return 'Processo: ' + p.numero_processo; }).join('\n');
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Voce e um assistente juridico virtual de um escritorio de advocacia. Responda de forma simples e educada. Cliente: ' + nomeCliente + '. Processos:\n' + listaProcessos + '\n\nSe perguntarem sobre detalhes especificos que voce nao tem, diga para entrar em contato com o escritorio.' },
        { role: 'user', content: mensagemCliente }
      ]
    },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
  );
  return res.data.choices[0].message.content;
}

async function jaFoiEnviada(processoId, descricao) {
  const { data } = await supabase.from('movimentacoes').select('id').eq('processo_id', processoId).eq('descricao', descricao).single();
  return !!data;
}

async function enviarWhatsApp(telefone, mensagem) {
  await axios.post(
    EVOLUTION_URL,
    { phone: '55' + telefone, message: mensagem },
    { headers: { 'Client-Token': EVOLUTION_CLIENT_TOKEN } }
  );
}

async function salvarMovimentacao(processoId, descricao, resumo) {
  await supabase.from('movimentacoes').insert({ processo_id: processoId, descricao: descricao, resumo_ia: resumo, relevante: true, enviado_whatsapp: true });
}

async function verificarProcessos() {
  console.log('Verificando processos...');
  const { data: processos } = await supabase.from('processos').select('*');
  if (!processos || !processos.length) { console.log('Nenhum processo cadastrado.'); return; }
  for (const processo of processos) {
    try {
      const movimentacoes = await buscarMovimentacoes(processo.numero_processo);
      for (const mov of movimentacoes) {
        const jaEnviou = await jaFoiEnviada(processo.id, mov);
        if (jaEnviou) continue;
        const resumo = await gerarResumo(mov);
        const mensagem = 'Ola, ' + processo.nome_cliente + '!\n\nSeu processo teve uma atualizacao:\n' + resumo + '\n\nDuvidas? Fale com o escritorio.';
        await enviarWhatsApp(processo.telefone_cliente, mensagem);
        await salvarMovimentacao(processo.id, mov, resumo);
        console.log('Enviado para ' + processo.nome_cliente);
      }
    } catch (err) {
      console.error('Erro: ' + err.message);
    }
  }
  console.log('Verificacao concluida.');
}

app.get('/', function(req, res) { res.send('Sistema juridico rodando!'); });

app.post('/auth/cadastro', async function(req, res) {
  const { nome, email, senha, escritorio } = req.body;
  if (!nome || !email || !senha || !escritorio) return res.status(400).json({ erro: 'Preencha todos os campos.' });
  const { data: existe } = await supabase.from('usuarios').select('id').eq('email', email).single();
  if (existe) return res.status(400).json({ erro: 'Email ja cadastrado.' });
  const { error } = await supabase.from('usuarios').insert({ nome, email, senha, escritorio });
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

app.post('/auth/login', async function(req, res) {
  const { email, senha } = req.body;
  const { data, error } = await supabase.from('usuarios').select('*').eq('email', email).eq('senha', senha).single();
  if (error || !data) return res.status(401).json({ erro: 'Email ou senha incorretos.' });
  res.json({ sucesso: true, usuario: { id: data.id, nome: data.nome, email: data.email, escritorio: data.escritorio } });
});

app.post('/processos', async function(req, res) {
  const { numero_processo, nome_cliente, telefone_cliente, usuario_id } = req.body;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatorio.' });
  const { data, error } = await supabase.from('processos').insert({ numero_processo, nome_cliente, telefone_cliente, usuario_id });
  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true, data });
});

app.get('/processos', async function(req, res) {
  const usuario_id = req.query.usuario_id;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatorio.' });
  const { data } = await supabase.from('processos').select('*').eq('usuario_id', usuario_id);
  res.json(data);
});

app.get('/movimentacoes', async function(req, res) {
  const usuario_id = req.query.usuario_id;
  if (!usuario_id) return res.json([]);
  const { data: processos } = await supabase.from('processos').select('id').eq('usuario_id', usuario_id);
  if (!processos || !processos.length) return res.json([]);
  const ids = processos.map(function(p) { return p.id; });
  const { data } = await supabase.from('movimentacoes').select('*, processos(nome_cliente, numero_processo)').in('processo_id', ids).order('detectado_em', { ascending: false }).limit(20);
  res.json(data);
});

app.post('/verificar', async function(req, res) {
  verificarProcessos();
  res.json({ sucesso: true, mensagem: 'Verificacao iniciada!' });
});

app.post('/testar-whatsapp', async function(req, res) {
  const { telefone, nome } = req.body;
  try {
    await enviarWhatsApp(telefone, 'Ola, ' + nome + '! Seu processo teve uma atualizacao. Entre em contato com o escritorio para mais detalhes.');
    res.json({ sucesso: true, mensagem: 'WhatsApp enviado!' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/webhook', async function(req, res) {
  try {
    const body = req.body;
    console.log('Webhook recebido:', JSON.stringify(body));
    if (!body || body.fromMe) return res.sendStatus(200);
    
    const telefone = (body.phone || body.from || '')
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/\D/g, '')
      .replace(/^55/, '');
    
    const mensagem = body.text && body.text.message ? body.text.message : body.message || body.body || null;
    
    console.log('Telefone:', telefone, 'Mensagem:', mensagem);
    
    if (!telefone || !mensagem) return res.sendStatus(200);
    
    const { data: processos } = await supabase.from('processos').select('*').eq('telefone_cliente', telefone);
    
    console.log('Processos encontrados:', processos ? processos.length : 0);
    
    if (!processos || !processos.length) {
      await enviarWhatsApp(telefone, 'Ola! Nao encontrei seu cadastro. Entre em contato com o escritorio.');
      return res.sendStatus(200);
    }
    
    const nomeCliente = processos[0].nome_cliente;
    const resposta = await gerarRespostaChatbot(mensagem, nomeCliente, processos);
    await enviarWhatsApp(telefone, resposta);
    console.log('Resposta enviada para ' + nomeCliente);
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook:', err.message);
    res.sendStatus(200);
  }
});

cron.schedule('0 */6 * * *', verificarProcessos);

app.listen(3000, function() {
  console.log('Servidor rodando em http://localhost:3000');
});