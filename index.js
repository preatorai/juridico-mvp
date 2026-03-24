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

// ========================= AUTH =========================

// CADASTRO
app.post('/auth/cadastro', async (req, res) => {
  try {
    const { nome, email, senha, escritorio } = req.body;

    if (!nome || !email || !senha || !escritorio) {
      return res.status(400).json({ erro: 'Preencha todos os campos.' });
    }

    const { data: existe } = await supabase
      .from('usuarios')
      .select('id')
      .eq('email', email)
      .single();

    if (existe) {
      return res.status(400).json({ erro: 'Email ja cadastrado.' });
    }

    const { error } = await supabase
      .from('usuarios')
      .insert({ nome, email, senha, escritorio });

    if (error) {
      return res.status(400).json({ erro: error.message });
    }

    res.json({ sucesso: true });

  } catch (err) {
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// LOGIN
app.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;

  const { data, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('email', email)
    .eq('senha', senha)
    .single();

  if (error || !data) {
    return res.status(401).json({ erro: 'Email ou senha incorretos.' });
  }

  res.json({
    sucesso: true,
    usuario: {
      id: data.id,
      nome: data.nome,
      email: data.email,
      escritorio: data.escritorio
    }
  });
});

// ========================= PROCESSOS =========================

app.post('/processos', async (req, res) => {
  const { numero_processo, nome_cliente, telefone_cliente, usuario_id } = req.body;

  if (!usuario_id) {
    return res.status(400).json({ erro: 'usuario_id obrigatorio' });
  }

  const { error } = await supabase
    .from('processos')
    .insert({ numero_processo, nome_cliente, telefone_cliente, usuario_id });

  if (error) return res.status(400).json({ erro: error.message });

  res.json({ sucesso: true });
});

app.get('/processos', async (req, res) => {
  const usuario_id = req.query.usuario_id;

  const { data } = await supabase
    .from('processos')
    .select('*')
    .eq('usuario_id', usuario_id);

  res.json(data);
});

// ========================= WEBHOOK =========================

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (!body || body.fromMe) return res.sendStatus(200);

    let telefone = (body.phone || body.from || '')
      .replace('@c.us', '')
      .replace('@s.whatsapp.net', '')
      .replace(/\D/g, '')
      .replace(/^55/, '');

    const mensagem = body.text?.message || body.message || body.body;

    if (!telefone || !mensagem) return res.sendStatus(200);

    const { data: processos } = await supabase
      .from('processos')
      .select('*')
      .eq('telefone_cliente', telefone);

    if (!processos?.length) {
      await enviarWhatsApp(telefone, 'Ola! Nao encontrei seu cadastro.');
      return res.sendStatus(200);
    }

    const resposta = await gerarRespostaChatbot(
      mensagem,
      processos[0].nome_cliente,
      processos
    );

    await enviarWhatsApp(telefone, resposta);

    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(200);
  }
});

// ========================= IA =========================

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

// ========================= KEEP ALIVE =========================

cron.schedule('*/5 * * * *', async () => {
  try {
    await axios.get('https://juridico-mvp.onrender.com');
    console.log('Ping ativo');
  } catch {}
});

// ========================= START =========================

app.get('/', (req, res) => res.send('Sistema juridico rodando!'));

app.listen(3000, () => console.log('Servidor rodando'));