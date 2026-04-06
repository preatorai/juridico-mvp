const axios = require('axios');
const cheerio = require('cheerio');

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': 'application/json, text/html, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9'
  }
});

// Mapeamento tribunal → sistema e URL base
const CONFIG = {
  // TRTs — todos usam PJe
  trt1:  { sistema: 'pje', url: 'https://pje.trt1.jus.br' },
  trt2:  { sistema: 'pje', url: 'https://pje.trt2.jus.br' },
  trt3:  { sistema: 'pje', url: 'https://pje.trt3.jus.br' },
  trt4:  { sistema: 'pje', url: 'https://pje.trt4.jus.br' },
  trt5:  { sistema: 'pje', url: 'https://pje.trt5.jus.br' },
  trt6:  { sistema: 'pje', url: 'https://pje.trt6.jus.br' },
  trt7:  { sistema: 'pje', url: 'https://pje.trt7.jus.br' },
  trt8:  { sistema: 'pje', url: 'https://pje.trt8.jus.br' },
  trt9:  { sistema: 'pje', url: 'https://pje.trt9.jus.br' },
  trt10: { sistema: 'pje', url: 'https://pje.trt10.jus.br' },
  trt11: { sistema: 'pje', url: 'https://pje.trt11.jus.br' },
  trt12: { sistema: 'pje', url: 'https://pje.trt12.jus.br' },
  trt13: { sistema: 'pje', url: 'https://pje.trt13.jus.br' },
  trt14: { sistema: 'pje', url: 'https://pje.trt14.jus.br' },
  trt15: { sistema: 'pje', url: 'https://pje.trt15.jus.br' },
  trt16: { sistema: 'pje', url: 'https://pje.trt16.jus.br' },
  trt17: { sistema: 'pje', url: 'https://pje.trt17.jus.br' },
  trt18: { sistema: 'pje', url: 'https://pje.trt18.jus.br' },
  trt19: { sistema: 'pje', url: 'https://pje.trt19.jus.br' },
  trt20: { sistema: 'pje', url: 'https://pje.trt20.jus.br' },
  trt21: { sistema: 'pje', url: 'https://pje.trt21.jus.br' },
  trt22: { sistema: 'pje', url: 'https://pje.trt22.jus.br' },
  trt23: { sistema: 'pje', url: 'https://pje.trt23.jus.br' },
  trt24: { sistema: 'pje', url: 'https://pje.trt24.jus.br' },

  // TREs — portal TSE unificado
  'tre-ac': { sistema: 'tre', uf: 'AC' },
  'tre-al': { sistema: 'tre', uf: 'AL' },
  'tre-am': { sistema: 'tre', uf: 'AM' },
  'tre-ap': { sistema: 'tre', uf: 'AP' },
  'tre-ba': { sistema: 'tre', uf: 'BA' },
  'tre-ce': { sistema: 'tre', uf: 'CE' },
  'tre-df': { sistema: 'tre', uf: 'DF' },
  'tre-es': { sistema: 'tre', uf: 'ES' },
  'tre-go': { sistema: 'tre', uf: 'GO' },
  'tre-ma': { sistema: 'tre', uf: 'MA' },
  'tre-mg': { sistema: 'tre', uf: 'MG' },
  'tre-ms': { sistema: 'tre', uf: 'MS' },
  'tre-mt': { sistema: 'tre', uf: 'MT' },
  'tre-pa': { sistema: 'tre', uf: 'PA' },
  'tre-pb': { sistema: 'tre', uf: 'PB' },
  'tre-pe': { sistema: 'tre', uf: 'PE' },
  'tre-pi': { sistema: 'tre', uf: 'PI' },
  'tre-pr': { sistema: 'tre', uf: 'PR' },
  'tre-rj': { sistema: 'tre', uf: 'RJ' },
  'tre-rn': { sistema: 'tre', uf: 'RN' },
  'tre-ro': { sistema: 'tre', uf: 'RO' },
  'tre-rr': { sistema: 'tre', uf: 'RR' },
  'tre-rs': { sistema: 'tre', uf: 'RS' },
  'tre-sc': { sistema: 'tre', uf: 'SC' },
  'tre-se': { sistema: 'tre', uf: 'SE' },
  'tre-sp': { sistema: 'tre', uf: 'SP' },
  'tre-to': { sistema: 'tre', uf: 'TO' },

  // TJs — PJe (maioria dos estados)
  tjac: { sistema: 'pje', url: 'https://pje.tjac.jus.br' },
  tjal: { sistema: 'pje', url: 'https://pje.tjal.jus.br' },
  tjam: { sistema: 'pje', url: 'https://pje.tjam.jus.br' },
  tjap: { sistema: 'pje', url: 'https://pje.tjap.jus.br' },
  tjce: { sistema: 'esaj', url: 'https://esaj.tjce.jus.br' },
  tjdft: { sistema: 'pje', url: 'https://pje.tjdft.jus.br' },
  tjes: { sistema: 'pje', url: 'https://pje.tjes.jus.br' },
  tjgo: { sistema: 'pje', url: 'https://pje.tjgo.jus.br' },
  tjma: { sistema: 'pje', url: 'https://pje.tjma.jus.br' },
  tjmg: { sistema: 'tjmg', url: 'https://processo.tjmg.jus.br' },
  tjms: { sistema: 'esaj', url: 'https://esaj.tjms.jus.br' },
  tjmt: { sistema: 'pje', url: 'https://pje.tjmt.jus.br' },
  tjpa: { sistema: 'pje', url: 'https://pje.tjpa.jus.br' },
  tjpb: { sistema: 'pje', url: 'https://pje.tjpb.jus.br' },
  tjpe: { sistema: 'pje', url: 'https://pje.tjpe.jus.br' },
  tjpi: { sistema: 'pje', url: 'https://pje.tjpi.jus.br' },
  tjpr: { sistema: 'pje', url: 'https://pje.tjpr.jus.br' },
  tjrj: { sistema: 'pje', url: 'https://pje.tjrj.jus.br' },
  tjrn: { sistema: 'pje', url: 'https://pje.tjrn.jus.br' },
  tjro: { sistema: 'pje', url: 'https://pje.tjro.jus.br' },
  tjrr: { sistema: 'pje', url: 'https://pje.tjrr.jus.br' },
  tjrs: { sistema: 'pje', url: 'https://pje.tjrs.jus.br' },
  tjba: { sistema: 'esaj', url: 'https://esaj.tjba.jus.br' },
  tjsc: { sistema: 'esaj', url: 'https://esaj.tjsc.jus.br' },
  tjse: { sistema: 'pje', url: 'https://pje.tjse.jus.br' },
  tjsp: { sistema: 'esaj', url: 'https://esaj.tjsp.jus.br' },
  tjto: { sistema: 'pje', url: 'https://pje.tjto.jus.br' },
};

// Formata número CNJ: NNNNNNN-DD.AAAA.J.TT.OOOO
function formatarCNJ(numero) {
  const d = numero.replace(/\D/g, '');
  if (d.length !== 20) return numero;
  return `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}`;
}

// PJe — API pública REST
async function buscarPJe(numero, baseUrl) {
  const cnj = formatarCNJ(numero);
  const tentativas = [
    // PJe 2.x API
    () => http.get(`${baseUrl}/pjekz/api/publico/processo/${encodeURIComponent(cnj)}`),
    // PJe 1.x API
    () => http.get(`${baseUrl}/pje/api/publico/processo/${encodeURIComponent(cnj)}`),
    // Consulta pública HTML
    () => http.get(`${baseUrl}/consultaprocessual/pages/consultas/listProcessos.seam`, {
      params: { fPP_numProcesso_inputNumProcesso: cnj },
      headers: { 'Accept': 'text/html' }
    }),
  ];

  for (const tentativa of tentativas) {
    try {
      const res = await tentativa();
      const movs = extrairMovimentosPJe(res.data);
      if (movs.length > 0) return movs;
    } catch (e) {
      continue;
    }
  }
  return [];
}

function extrairMovimentosPJe(data) {
  // Resposta JSON da API REST do PJe
  if (data && typeof data === 'object') {
    const movimentos = data.movimentos || data.listaMovimentos || data.hits || [];
    if (Array.isArray(movimentos) && movimentos.length > 0) {
      return movimentos
        .filter(m => m.nome || m.descricao || m.movimento)
        .sort((a, b) => new Date(b.dataHora || b.data || 0) - new Date(a.dataHora || a.data || 0))
        .slice(0, 5)
        .map(m => ({
          nome: m.nome || m.descricao || m.movimento || 'Movimentação',
          data: formatarData(m.dataHora || m.data || m.dataMovimento)
        }));
    }
    // Alguns retornam processo com movimentos dentro
    const processo = data.processo || data.dadosProcesso || data;
    if (processo && processo.movimentos) {
      return extrairMovimentosPJe({ movimentos: processo.movimentos });
    }
  }
  // Resposta HTML — tenta cheerio
  if (typeof data === 'string' && data.includes('html')) {
    return extrairMovimentosHTML(data);
  }
  return [];
}

// ESAJ — TJSP, TJBA, TJCE, TJSC, TJMS
async function buscarESAJ(numero, baseUrl) {
  const cnj = formatarCNJ(numero);
  const numLimpo = numero.replace(/\D/g, '');

  const tentativas = [
    // 1ª instância
    () => http.get(`${baseUrl}/cpopg/show.do`, {
      params: { processo: { codigo: cnj }, 'dados.pesquisar': 'Pesquisar' },
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    }),
    // 2ª instância
    () => http.get(`${baseUrl}/cposg/show.do`, {
      params: { processo: { codigo: cnj } },
      headers: { 'Accept': 'text/html' }
    }),
    // Busca direta por número
    () => http.post(`${baseUrl}/cpopg/search.do`, new URLSearchParams({
      conversationId: '',
      'dados.numeroDoProcesso': cnj,
      'dados.pesquisar': 'Pesquisar'
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }),
  ];

  for (const tentativa of tentativas) {
    try {
      const res = await tentativa();
      const movs = extrairMovimentosHTML(res.data);
      if (movs.length > 0) return movs;
    } catch (e) {
      continue;
    }
  }
  return [];
}

// TJMG — sistema próprio
async function buscarTJMG(numero) {
  const cnj = formatarCNJ(numero);
  try {
    const res = await http.get('https://processo.tjmg.jus.br/cpopg/show.do', {
      params: { 'dados.numeroDoProcesso': cnj },
      headers: { 'Accept': 'text/html' }
    });
    return extrairMovimentosHTML(res.data);
  } catch (e) {
    return [];
  }
}

// TREs — portal TSE unificado
async function buscarTRE(numero, uf) {
  const cnj = formatarCNJ(numero);
  const numLimpo = numero.replace(/\D/g, '');
  const ufLower = uf.toLowerCase();

  const tentativas = [
    // API pública TSE
    () => http.get(`https://api-sgp.tse.jus.br/processo/public/${encodeURIComponent(cnj)}`),
    // Portal do TRE estadual
    () => http.get(`https://www.tre-${ufLower}.jus.br/servicos-judiciais/servicos-judiciais/consulta-de-processos`, {
      params: { numero: cnj },
      headers: { 'Accept': 'text/html' }
    }),
    // PJe TRE (alguns usam)
    () => http.get(`https://pje.tre-${ufLower}.jus.br/pjekz/api/publico/processo/${encodeURIComponent(cnj)}`),
  ];

  for (const tentativa of tentativas) {
    try {
      const res = await tentativa();
      const movs = typeof res.data === 'object'
        ? extrairMovimentosPJe(res.data)
        : extrairMovimentosHTML(res.data);
      if (movs.length > 0) return movs;
    } catch (e) {
      continue;
    }
  }
  return [];
}

// Extrai movimentações de HTML genérico via cheerio
function extrairMovimentosHTML(html) {
  if (!html || typeof html !== 'string') return [];
  try {
    const $ = cheerio.load(html);
    const movs = [];

    // Padrão ESAJ: tabela com classe #tabelaTodasMovimentacoes
    $('#tabelaTodasMovimentacoes tr, .containerMovimentacao, .movimentacao').each((i, el) => {
      if (i >= 5) return false;
      const tds = $(el).find('td');
      if (tds.length >= 2) {
        const data = $(tds[0]).text().trim();
        const nome = $(tds[tds.length - 1]).text().trim().replace(/\s+/g, ' ').slice(0, 200);
        if (nome && data) movs.push({ nome, data: formatarDataBR(data) });
      }
    });

    if (movs.length > 0) return movs;

    // Padrão PJe HTML: divs com classe de movimentação
    $('.rich-table-row, .row-mov, [class*="moviment"]').each((i, el) => {
      if (i >= 5) return false;
      const texto = $(el).text().trim().replace(/\s+/g, ' ');
      if (texto.length > 10) movs.push({ nome: texto.slice(0, 200), data: extrairData(texto) });
    });

    return movs;
  } catch (e) {
    return [];
  }
}

function formatarData(dataStr) {
  if (!dataStr) return '—';
  try {
    return new Date(dataStr).toLocaleDateString('pt-BR');
  } catch (e) {
    return dataStr;
  }
}

function formatarDataBR(texto) {
  // Já está no formato DD/MM/AAAA
  if (/\d{2}\/\d{2}\/\d{4}/.test(texto)) return texto.match(/\d{2}\/\d{2}\/\d{4}/)[0];
  return formatarData(texto);
}

function extrairData(texto) {
  const m = texto.match(/(\d{2}\/\d{2}\/\d{4})/);
  return m ? m[1] : '—';
}

// Ponto de entrada principal
async function buscarPorTribunal(numeroProcesso, tribunal) {
  const cfg = CONFIG[tribunal];
  if (!cfg) {
    console.log('[scraper] tribunal não mapeado:', tribunal);
    return [];
  }

  console.log(`[scraper] ${tribunal} (${cfg.sistema}) → ${numeroProcesso}`);

  try {
    switch (cfg.sistema) {
      case 'pje':  return await buscarPJe(numeroProcesso, cfg.url);
      case 'esaj': return await buscarESAJ(numeroProcesso, cfg.url);
      case 'tre':  return await buscarTRE(numeroProcesso, cfg.uf);
      case 'tjmg': return await buscarTJMG(numeroProcesso);
      default:     return [];
    }
  } catch (err) {
    console.error(`[scraper] erro ${tribunal}:`, err.message);
    return [];
  }
}

module.exports = { buscarPorTribunal };
