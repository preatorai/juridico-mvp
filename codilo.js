const axios = require('axios');

const CODILO_ID = process.env.CODILO_ID;
const CODILO_SECRET = process.env.CODILO_SECRET;

let _token = null;
let _tokenExpira = 0;

// Mapeamento tribunal CNJ → plataforma e search da Codilo
const MAPA_TRIBUNAL = {
  // TJs ESAJ
  tjsp: { platform: 'esaj', search: 'tjsp' },
  tjba: { platform: 'esaj', search: 'tjba' },
  tjce: { platform: 'esaj', search: 'tjce' },
  tjsc: { platform: 'esaj', search: 'tjsc' },
  tjms: { platform: 'esaj', search: 'tjms' },
  tjal: { platform: 'esaj', search: 'tjal' },

  // TJs PJe
  tjam: { platform: 'pje', search: 'tjam' },
  tjap: { platform: 'pje', search: 'tjap' },
  tjdft: { platform: 'pje', search: 'tjdft' },
  tjes: { platform: 'pje', search: 'tjes' },
  tjgo: { platform: 'pje', search: 'tjgo' },
  tjma: { platform: 'pje', search: 'tjma' },
  tjmt: { platform: 'pje', search: 'tjmt' },
  tjpa: { platform: 'pje', search: 'tjpa' },
  tjpb: { platform: 'pje', search: 'tjpb' },
  tjpe: { platform: 'pje', search: 'tjpe' },
  tjpi: { platform: 'pje', search: 'tjpi' },
  tjpr: { platform: 'pje', search: 'tjpr' },
  tjrj: { platform: 'pje', search: 'tjrj' },
  tjrn: { platform: 'pje', search: 'tjrn' },
  tjro: { platform: 'pje', search: 'tjro' },
  tjrr: { platform: 'pje', search: 'tjrr' },
  tjrs: { platform: 'pje', search: 'tjrs' },
  tjse: { platform: 'pje', search: 'tjse' },
  tjto: { platform: 'pje', search: 'tjto' },
  tjac: { platform: 'pje', search: 'tjac' },

  // TRTs PJe
  trt1:  { platform: 'pje-jt-merged', search: 'trt1' },
  trt2:  { platform: 'pje-jt-merged', search: 'trt2' },
  trt3:  { platform: 'pje-jt-merged', search: 'trt3' },
  trt4:  { platform: 'pje-jt-merged', search: 'trt4' },
  trt5:  { platform: 'pje-jt-merged', search: 'trt5' },
  trt6:  { platform: 'pje-jt-merged', search: 'trt6' },
  trt7:  { platform: 'pje-jt-merged', search: 'trt7' },
  trt8:  { platform: 'pje-jt-merged', search: 'trt8' },
  trt9:  { platform: 'pje-jt-merged', search: 'trt9' },
  trt10: { platform: 'pje-jt-merged', search: 'trt10' },
  trt11: { platform: 'pje-jt-merged', search: 'trt11' },
  trt12: { platform: 'pje-jt-merged', search: 'trt12' },
  trt13: { platform: 'pje-jt-merged', search: 'trt13' },
  trt14: { platform: 'pje-jt-merged', search: 'trt14' },
  trt15: { platform: 'pje-jt-merged', search: 'trt15' },
  trt16: { platform: 'pje-jt-merged', search: 'trt16' },
  trt17: { platform: 'pje-jt-merged', search: 'trt17' },
  trt18: { platform: 'pje-jt-merged', search: 'trt18' },
  trt19: { platform: 'pje-jt-merged', search: 'trt19' },
  trt20: { platform: 'pje-jt-merged', search: 'trt20' },
  trt21: { platform: 'pje-jt-merged', search: 'trt21' },
  trt22: { platform: 'pje-jt-merged', search: 'trt22' },
  trt23: { platform: 'pje-jt-merged', search: 'trt23' },
  trt24: { platform: 'pje-jt-merged', search: 'trt24' },

  // TREs
  'tre-al': { platform: 'pje', search: 'tre-al' },
  'tre-sp': { platform: 'pje', search: 'tre-sp' },
  'tre-rj': { platform: 'pje', search: 'tre-rj' },
  'tre-mg': { platform: 'pje', search: 'tre-mg' },
  'tre-rs': { platform: 'pje', search: 'tre-rs' },
  'tre-pr': { platform: 'pje', search: 'tre-pr' },
  'tre-ba': { platform: 'pje', search: 'tre-ba' },
  'tre-sc': { platform: 'pje', search: 'tre-sc' },
  'tre-pe': { platform: 'pje', search: 'tre-pe' },
  'tre-ce': { platform: 'pje', search: 'tre-ce' },
  'tre-go': { platform: 'pje', search: 'tre-go' },
  'tre-pa': { platform: 'pje', search: 'tre-pa' },
  'tre-ma': { platform: 'pje', search: 'tre-ma' },
  'tre-es': { platform: 'pje', search: 'tre-es' },
  'tre-pb': { platform: 'pje', search: 'tre-pb' },
  'tre-rn': { platform: 'pje', search: 'tre-rn' },
  'tre-mt': { platform: 'pje', search: 'tre-mt' },
  'tre-ms': { platform: 'pje', search: 'tre-ms' },
  'tre-pi': { platform: 'pje', search: 'tre-pi' },
  'tre-ro': { platform: 'pje', search: 'tre-ro' },
  'tre-to': { platform: 'pje', search: 'tre-to' },
  'tre-ac': { platform: 'pje', search: 'tre-ac' },
  'tre-am': { platform: 'pje', search: 'tre-am' },
  'tre-ap': { platform: 'pje', search: 'tre-ap' },
  'tre-df': { platform: 'pje', search: 'tre-df' },
  'tre-rr': { platform: 'pje', search: 'tre-rr' },
  'tre-se': { platform: 'pje', search: 'tre-se' },
};

async function getToken() {
  if (_token && Date.now() < _tokenExpira) return _token;
  console.log('[codilo] obtendo token | ID:', CODILO_ID ? CODILO_ID.substring(0,6) + '...' : 'NAO DEFINIDO');
  try {
    const r = await axios.post('https://auth.codilo.com.br/oauth/token', {
      grant_type: 'client_credentials',
      id: CODILO_ID,
      secret: CODILO_SECRET
    }, { timeout: 10000 });
    _token = r.data.access_token;
    _tokenExpira = Date.now() + (r.data.expires_in - 60) * 1000;
    console.log('[codilo] token obtido com sucesso');
    return _token;
  } catch (e) {
    console.log('[codilo] erro ao obter token:', e.response?.status, JSON.stringify(e.response?.data), e.message);
    throw e;
  }
}

function formatarCNJ(numero) {
  const d = numero.replace(/\D/g, '');
  if (d.length !== 20) return numero;
  return `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}`;
}

async function consultarProcesso(numeroProcesso, tribunal) {
  const token = await getToken();
  const cnj = formatarCNJ(numeroProcesso);
  const cfg = MAPA_TRIBUNAL[tribunal];

  if (!cfg) {
    console.log('[codilo] tribunal não mapeado:', tribunal, '— usando consulta automática');
    return consultarAutomatico(numeroProcesso);
  }

  console.log(`[codilo] consultando ${tribunal} (${cfg.platform}) → ${cnj}`);

  // Tenta 1º grau, se não tentar 2º grau
  for (const query of ['principal', 'unificada', 'recursal']) {
    try {
      const r = await axios.post('https://api.consulta.codilo.com.br/v1/request', {
        source: 'courts',
        platform: cfg.platform,
        search: cfg.search,
        query,
        param: { key: 'cnj', value: cnj },
        callbacks: []
      }, {
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        timeout: 15000
      });

      if (r.data.success && r.data.data?.id) {
        const requestId = r.data.data.id;
        console.log('[codilo] requestId:', requestId, 'status:', r.data.data.status);
        return aguardarResultado(requestId, token);
      }
    } catch (e) {
      console.log('[codilo] erro query', query, ':', e.response?.status, e.message, JSON.stringify(e.response?.data));
      continue;
    }
  }
  return [];
}

async function consultarAutomatico(numeroProcesso) {
  const token = await getToken();
  const cnj = formatarCNJ(numeroProcesso);
  console.log('[codilo] consulta automática →', cnj);

  try {
    const r = await axios.post('https://api.consulta.codilo.com.br/v1/autorequest', {
      key: 'cnj',
      value: cnj,
      callbacks: []
    }, {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 15000
    });

    if (r.data.success && r.data.data?.id) {
      return aguardarResultado(r.data.data.id, token);
    }
  } catch (e) {
    console.log('[codilo] erro automático:', e.response?.status, e.message);
  }
  return [];
}

async function aguardarResultado(requestId, token, tentativas = 0) {
  if (tentativas > 20) {
    console.log('[codilo] timeout aguardando resultado');
    return [];
  }

  await new Promise(r => setTimeout(r, 2000));

  try {
    const r = await axios.get(`https://api.consulta.codilo.com.br/v1/request/${requestId}`, {
      headers: { Authorization: 'Bearer ' + token },
      timeout: 10000
    });

    // Status fica em r.data.requested.status, não em r.data.data
    const requested = r.data.requested;
    const status = (requested?.status || '').toLowerCase();

    if (status === 'pending' || status === 'pendente' || status === 'processing' || status === 'processando') {
      console.log('[codilo] aguardando... tentativa', tentativas + 1);
      return aguardarResultado(requestId, token, tentativas + 1);
    }

    if (status === 'error' || status === 'erro') {
      console.log('[codilo] erro na consulta, status:', requested?.status);
      return [];
    }

    const data = r.data.data;
    if (!data || (Array.isArray(data) && !data.length)) {
      console.log('[codilo] processo não encontrado');
      return [];
    }

    return extrairDadosCompletos(data);
  } catch (e) {
    console.log('[codilo] erro ao buscar resultado:', e.message);
    return [];
  }
}

function extrairDadosCompletos(data) {
  const items = Array.isArray(data) ? data : [data];
  const item = items[0] || {};

  // Capa do processo
  const capa = {};
  if (item.cover && Array.isArray(item.cover)) {
    item.cover.forEach(c => { if (c.description && (c.value || c.valor)) capa[c.description] = c.value || c.valor; });
  }
  if (item.properties) {
    const p = item.properties;
    if (p.class) capa['Classe'] = capa['Classe'] || p.class;
    if (p.subject) capa['Assunto'] = capa['Assunto'] || p.subject;
    if (p.judge) capa['Juiz'] = capa['Juiz'] || p.judge;
    if (p.startAt) capa['Distribuição'] = capa['Distribuição'] || formatarData(p.startAt);
  }

  // Partes e advogados
  const partes = (item.people || []).map(p => ({
    polo: p.pole === 'active' ? 'Ativo' : p.pole === 'passive' ? 'Passivo' : p.pole,
    tipo: p.description || '',
    nome: p.name || '',
    advogados: (p.advogados || p.lawyers || []).map(a => a.name).filter(Boolean)
  }));

  // Movimentações
  const steps = [];
  for (const it of items) {
    if (it.steps && Array.isArray(it.steps)) steps.push(...it.steps);
  }
  console.log('[codilo] steps encontrados:', steps.length);

  const movimentacoes = steps
    .filter(s => s.title || s.description)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .map(s => ({ nome: s.title || s.description || 'Movimentação', data: formatarData(s.timestamp) }));

  return { capa, partes, movimentacoes };
}

function extrairMovimentacoes(data) {
  const resultado = extrairDadosCompletos(data);
  return resultado.movimentacoes || [];
}

function formatarData(dataStr) {
  if (!dataStr) return '—';
  try { return new Date(dataStr).toLocaleDateString('pt-BR'); }
  catch (e) { return dataStr; }
}

async function consultarProcessoCompleto(numeroProcesso, tribunal) {
  const token = await getToken();
  const cnj = formatarCNJ(numeroProcesso);
  const cfg = MAPA_TRIBUNAL[tribunal];

  if (!cfg) return consultarAutomaticoCompleto(numeroProcesso);

  for (const query of ['principal', 'unificada', 'recursal']) {
    try {
      const r = await axios.post('https://api.consulta.codilo.com.br/v1/request', {
        source: 'courts', platform: cfg.platform, search: cfg.search, query,
        param: { key: 'cnj', value: cnj }, callbacks: []
      }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 15000 });

      if (r.data.success && r.data.data?.id) {
        return aguardarResultadoCompleto(r.data.data.id, token);
      }
    } catch (e) {
      console.log('[codilo] erro query', query, ':', e.response?.status, e.message);
    }
  }
  return null;
}

async function consultarAutomaticoCompleto(numeroProcesso) {
  const token = await getToken();
  const cnj = formatarCNJ(numeroProcesso);
  try {
    const r = await axios.post('https://api.consulta.codilo.com.br/v1/autorequest', {
      key: 'cnj', value: cnj, callbacks: []
    }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 15000 });
    if (r.data.success && r.data.data?.id) return aguardarResultadoCompleto(r.data.data.id, token);
  } catch (e) {
    console.log('[codilo] erro automático:', e.message);
  }
  return null;
}

async function aguardarResultadoCompleto(requestId, token, tentativas = 0) {
  if (tentativas > 20) return null;
  await new Promise(r => setTimeout(r, 2000));
  try {
    const r = await axios.get(`https://api.consulta.codilo.com.br/v1/request/${requestId}`, {
      headers: { Authorization: 'Bearer ' + token }, timeout: 10000
    });
    const requested = r.data.requested;
    const status = (requested?.status || '').toLowerCase();
    if (status === 'pending' || status === 'pendente') return aguardarResultadoCompleto(requestId, token, tentativas + 1);
    if (status === 'error' || status === 'erro') return null;
    const data = r.data.data;
    if (!data || (Array.isArray(data) && !data.length)) return null;
    return extrairDadosCompletos(data);
  } catch (e) {
    return null;
  }
}

module.exports = { consultarProcesso, consultarProcessoCompleto };
