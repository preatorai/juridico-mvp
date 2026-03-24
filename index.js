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
  '8.01': 'tjac','8.02': 'tjal','8.03': 'tjap','8.04': 'tjam',
  '8.05': 'tjba','8.06': 'tjce','8.07': 'tjdft','8.08': 'tjes',
  '8.09': 'tjgo','8.10': 'tjma','8.11': 'tjmt','8.12': 'tjms',
  '8.13': 'tjmg','8.14': 'tjpa','8.15': 'tjpb','8.16': 'tjpr',
  '8.17': 'tjpe','8.18': 'tjpi','8.19': 'tjrj','8.20': 'tjrn',
  '8.21': 'tjrs','8.22': 'tjro','8.23': 'tjrr','8.24': 'tjsc',
  '8.25': 'tjse','8.26': 'tjsp','8.27': 'tjto',
  '4.01': 'trf1','4.02': 'trf2','4.03': 'trf3','4.04': 'trf4','4.05': 'trf5',
  '5.01': 'trt1','5.02': 'trt2','5.03': 'trt3','5.04': 'trt4',
  '5.05': 'trt5','5.06': 'trt6','5.07': 'trt7','5.08': 'trt8',
  '5.09': 'trt9','5.10': 'trt10','5.11': 'trt11','5.12': 'trt12',
  '5.13': 'trt13','5.14': 'trt14','5.15': 'trt15','5.16': 'trt16',
  '5.17': 'trt17','5.18': 'trt18','5.19': 'trt19','5.20': 'trt20',
  '5.21': 'trt21','5.22': 'trt22','5.23': 'trt23','5.24': 'trt24'
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
    const hits = res.data?.hits?.hits || [];
    if (!hits.length) return [];
    return hits[0]._source.movimentos.map(m => m.nome).filter(Boolean);
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
      messages: [{ role: 'user', content: 'Resuma em até 3 linhas: ' + movimentacao }]
    },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
  );
  return res.data.choices[0].message.content;
}

async function gerarRespostaChatbot(msg, nome, processos) {
  const lista = processos.map(p => 'Processo: ' + p.numero_processo).join('\n');
  const res = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: `Assistente juridico. Cliente: ${nome}\n${lista}` },
        { role: 'user', content: msg }
      ]
    },
    { headers: { Authorization: 'Bearer ' + OPENAI_KEY } }
  );
  return res.data.choices[0].message.content;
}

async function enviarWhatsApp(telefone, mensagem) {
  await axios.post(
    EVOLUTION_URL,
    { phone: '55' + telefone, message: mensagem },
    { headers: { 'Client-Token': EVOLUTION_CLIENT_TOKEN } }
  );
}

// ========================= WEBHOOK MELHORADO =========================
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    console.log('==== WEBHOOK ====');  
    console.log(JSON.stringify(body));

    if (!body || body.fromMe) return res.sendStatus(200);

    let telefone = (body.phone || body.from || '')
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/\D/g, '')
      .replace(/^55/, '');

    const mensagem = body.text?.message || body.message || body.body;

    console.log('Telefone:', telefone);
    console.log('Mensagem:', mensagem);

    if (!telefone || !mensagem) return res.sendStatus(200);

    const { data: processos } = await supabase
      .from('processos')
      .select('*')
      .eq('telefone_cliente', telefone);

    if (!processos?.length) {
      console.log('Cliente não encontrado');
      await enviarWhatsApp(telefone, 'Ola! Nao encontrei seu cadastro.');
      return res.sendStatus(200);
    }

    const resposta = await gerarRespostaChatbot(mensagem, processos[0].nome_cliente, processos);
    await enviarWhatsApp(telefone, resposta);

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

// ========================= ANTI SLEEP =========================
cron.schedule('*/5 * * * *', async () => {
  try {
    await axios.get('https://juridico-mvp.onrender.com');
    console.log('Ping ativo');
  } catch {}
});

// ========================= ROTAS =========================
app.get('/', (req, res) => res.send('Sistema juridico rodando!'));

app.post('/processos', async (req, res) => {
  const { numero_processo, nome_cliente, telefone_cliente, usuario_id } = req.body;
  if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatorio' });

  const { data, error } = await supabase
    .from('processos')
    .insert({ numero_processo, nome_cliente, telefone_cliente, usuario_id });

  if (error) return res.status(400).json({ erro: error.message });
  res.json({ sucesso: true });
});

// ========================= START =========================
app.listen(3000, () => console.log('Servidor rodando'));