const axios = require('axios');

const CODILO_ID     = process.env.CODILO_ID;
const CODILO_SECRET = process.env.CODILO_SECRET;

let _token       = null;
let _tokenExpira = 0;

const MAPA_TRIBUNAL = {
  tjsp: { platform: 'esaj', search: 'tjsp' },
  tjba: { platform: 'esaj', search: 'tjba' },
  tjce: { platform: 'esaj', search: 'tjce' },
  tjsc: { platform: 'esaj', search: 'tjsc' },
  tjms: { platform: 'esaj', search: 'tjms' },
  tjal: { platform: 'esaj', search: 'tjal' },
  tjam: { platform: 'pje',  search: 'tjam' },
  tjap: { platform: 'pje',  search: 'tjap' },
  tjdft:{ platform: 'pje',  search: 'tjdft'},
  tjes: { platform: 'pje',  search: 'tjes' },
  tjgo: { platform: 'pje',  search: 'tjgo' },
  tjma: { platform: 'pje',  search: 'tjma' },
  tjmt: { platform: 'pje',  search: 'tjmt' },
  tjpa: { platform: 'pje',  search: 'tjpa' },
  tjpb: { platform: 'pje',  search: 'tjpb' },
  tjpe: { platform: 'pje',  search: 'tjpe' },
  tjpi: { platform: 'pje',  search: 'tjpi' },
  tjpr: { platform: 'pje',  search: 'tjpr' },
  tjrj: { platform: 'pje',  search: 'tjrj' },
  tjrn: { platform: 'pje',  search: 'tjrn' },
  tjro: { platform: 'pje',  search: 'tjro' },
  tjrr: { platform: 'pje',  search: 'tjrr' },
  tjrs: { platform: 'pje',  search: 'tjrs' },
  tjse: { platform: 'pje',  search: 'tjse' },
  tjto: { platform: 'pje',  search: 'tjto' },
  tjac: { platform: 'pje',  search: 'tjac' },
  trt1:  { platform: 'pje-jt-merged', search: 'trt1'  },
  trt2:  { platform: 'pje-jt-merged', search: 'trt2'  },
  trt3:  { platform: 'pje-jt-merged', search: 'trt3'  },
  trt4:  { platform: 'pje-jt-merged', search: 'trt4'  },
  trt5:  { platform: 'pje-jt-merged', search: 'trt5'  },
  trt6:  { platform: 'pje-jt-merged', search: 'trt6'  },
  trt7:  { platform: 'pje-jt-merged', search: 'trt7'  },
  trt8:  { platform: 'pje-jt-merged', search: 'trt8'  },
  trt9:  { platform: 'pje-jt-merged', search: 'trt9'  },
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

async function getToken(forceRefresh = false) {
  if (!forceRefresh && _token && Date.now() < _tokenExpira) return _token;
  const r = await axios.post('https://auth.codilo.com.br/oauth/token', {
    grant_type: 'client_credentials', id: CODILO_ID, secret: CODILO_SECRET
  }, { timeout: 10000 });
  _token       = r.data.access_token;
  _tokenExpira = Date.now() + (r.data.expires_in - 60) * 1000;
  console.log('[codilo] token renovado');
  return _token;
}

function formatarCNJ(numero) {
  const d = numero.replace(/\D/g, '');
  if (d.length !== 20) return numero;
  return `${d.slice(0,7)}-${d.slice(7,9)}.${d.slice(9,13)}.${d.slice(13,14)}.${d.slice(14,16)}.${d.slice(16,20)}`;
}

function formatarData(dataStr) {
  if (!dataStr) return '—';
  try { return new Date(dataStr).toLocaleDateString('pt-BR'); } catch (e) { return dataStr; }
}

// Polling genérico — usado por todos os fluxos
async function polling(requestId, completo = false) {
  const inicio = Date.now();
  const MAX    = 10;
  let erros500 = 0;

  for (let i = 0; i < MAX; i++) {
    await new Promise(r => setTimeout(r, 800));
    try {
      const token = await getToken();
      const r = await axios.get(`https://api.consulta.codilo.com.br/v1/request/${requestId}`, {
        headers: { Authorization: 'Bearer ' + token }, timeout: 8000
      });

      const status = (r.data.requested?.status || '').toLowerCase();
      console.log(`[codilo] polling ${i + 1}/${MAX} status=${status} (${Date.now() - inicio}ms)`);

      if (['pending','pendente','processing','processando'].includes(status)) continue;
      if (['error','erro'].includes(status)) { console.log('[codilo] tribunal retornou erro'); return null; }

      const data = r.data.data;
      if (!data || (Array.isArray(data) && !data.length)) { console.log('[codilo] sem dados'); return null; }

      console.log(`[codilo] ✅ dados em ${i + 1} tentativas (${Date.now() - inicio}ms)`);
      return completo ? extrairDadosCompletos(data) : extrairMovimentacoes(data);

    } catch (e) {
      const s = e.response?.status;
      if (s === 401) { await getToken(true); continue; }
      if (s === 400 || s === 403 || s === 404) { console.log(`[codilo] erro definitivo ${s}`); return null; }
      erros500++;
      console.log(`[codilo] erro temporário ${s || 'rede'} (${erros500}x)`);
      if (erros500 >= 3) { console.log('[codilo] muitos erros 500, desistindo'); return null; }
    }
  }
  console.log(`[codilo] timeout após ${MAX} tentativas`);
  return null;
}

// Submete uma query e aguarda resultado
async function submitQuery(cnj, platform, search, query, completo) {
  try {
    const token = await getToken();
    const r = await axios.post('https://api.consulta.codilo.com.br/v1/request', {
      source: 'courts', platform, search, query,
      param: { key: 'cnj', value: cnj }, callbacks: []
    }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 15000 });

    if (r.data.success && r.data.data?.id) {
      return await polling(r.data.data.id, completo);
    }
  } catch (e) {
    if (e.response?.status !== 400) // 400 = query inválida para esse tribunal, ignora silenciosamente
      console.log(`[codilo] submitQuery erro ${e.response?.status}: ${e.message}`);
  }
  return null;
}

// Autorequest — tenta detectar o tribunal automaticamente
async function autoRequest(cnj, completo) {
  try {
    const token = await getToken();
    const r = await axios.post('https://api.consulta.codilo.com.br/v1/autorequest', {
      key: 'cnj', value: cnj, callbacks: []
    }, { headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, timeout: 15000 });

    if (r.data.success && r.data.data?.id) {
      return await polling(r.data.data.id, completo);
    }
  } catch (e) {
    console.log('[codilo] autorequest erro:', e.response?.status, e.message);
  }
  return null;
}

// Cadeia completa de tentativas para um processo
async function buscar(numeroProcesso, tribunal, completo) {
  const cnj = formatarCNJ(numeroProcesso);
  const cfg = MAPA_TRIBUNAL[tribunal];
  const vazio = completo ? null : [];

  console.log(`[codilo] buscando ${cnj} | tribunal=${tribunal} | completo=${completo}`);

  if (cfg) {
    // 1. Plataforma mapeada — principal e recursal
    for (const query of ['principal', 'recursal']) {
      const res = await submitQuery(cnj, cfg.platform, cfg.search, query, completo);
      if (res && (completo ? res.movimentacoes?.length : res.length)) {
        console.log(`[codilo] ✅ encontrado via ${cfg.platform}/${query}`);
        return res;
      }
    }

    // 2. Se era ESAJ, tenta PJe (alguns TJs operam nos dois sistemas)
    if (cfg.platform === 'esaj') {
      for (const query of ['principal', 'recursal']) {
        const res = await submitQuery(cnj, 'pje', cfg.search, query, completo);
        if (res && (completo ? res.movimentacoes?.length : res.length)) {
          console.log(`[codilo] ✅ encontrado via pje fallback/${query}`);
          return res;
        }
      }
    }
  }

  // 3. Autorequest — Codilo detecta o tribunal automaticamente
  console.log('[codilo] tentando autorequest...');
  const res = await autoRequest(cnj, completo);
  if (res && (completo ? res.movimentacoes?.length : res.length)) {
    console.log('[codilo] ✅ encontrado via autorequest');
    return res;
  }

  console.log('[codilo] nenhuma fonte retornou dados para', cnj);
  return vazio;
}

function extrairDadosCompletos(data) {
  const items = Array.isArray(data) ? data : [data];
  const item  = items[0] || {};

  const capa = {};
  if (item.cover && Array.isArray(item.cover)) {
    item.cover.forEach(c => { if (c.description && (c.value || c.valor)) capa[c.description] = c.value || c.valor; });
  }
  if (item.properties) {
    const p = item.properties;
    if (p.class)   capa['Classe']       = capa['Classe']       || p.class;
    if (p.subject) capa['Assunto']      = capa['Assunto']      || p.subject;
    if (p.judge)   capa['Juiz']         = capa['Juiz']         || p.judge;
    if (p.startAt) capa['Distribuição'] = capa['Distribuição'] || formatarData(p.startAt);
  }

  const partes = (item.people || []).map(p => ({
    polo: p.pole === 'active' ? 'Ativo' : p.pole === 'passive' ? 'Passivo' : p.pole,
    tipo: p.description || '',
    nome: p.name || '',
    advogados: (p.advogados || p.lawyers || []).map(a => a.name).filter(Boolean)
  }));

  const steps = [];
  for (const it of items) {
    if (it.steps && Array.isArray(it.steps)) steps.push(...it.steps);
  }
  console.log('[codilo] steps encontrados:', steps.length);
  if (steps.length === 0) console.log('[codilo] estrutura raw:', JSON.stringify(items[0]).substring(0, 500));

  const movimentacoes = steps
    .filter(s => s.title || s.description)
    .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0))
    .map(s => ({ nome: s.title || s.description || 'Movimentação', data: formatarData(s.timestamp) }));

  return { capa, partes, movimentacoes };
}

function extrairMovimentacoes(data) {
  return extrairDadosCompletos(data).movimentacoes || [];
}

async function consultarProcesso(numeroProcesso, tribunal) {
  return buscar(numeroProcesso, tribunal, false);
}

async function consultarProcessoCompleto(numeroProcesso, tribunal) {
  return buscar(numeroProcesso, tribunal, true);
}

module.exports = { consultarProcesso, consultarProcessoCompleto };
