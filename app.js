// app.js — Versão corrigida: Mapas sincronizados, sem pins duplicados e foco preciso
// Observações: coloque este arquivo no lugar do app.js atual e recarregue o servidor.

// --- Proteções / Motor de Áudio ---
window.playBeepSound = () => {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'square';
    osc.frequency.setValueAtTime(880, ctx.currentTime); // 880Hz (Som de alarme)
    gain.gain.setValueAtTime(0.1, ctx.currentTime); // Volume
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.15); // Duração do bipe
  } catch(e) { console.warn("Áudio bloqueado pelo navegador."); }
};

window.stopAudioAlarm = () => {
  const modal = document.getElementById('snoozeModal');
  if (modal) modal.classList.add('hidden');
};
// --- Endpoints (ajuste se necessário) ---
const API = "https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec";
const API_FLEX = "https://script.google.com/macros/s/AKfycbzDp2qs2S_MxDc_3afY1TurNKYEwfYKkk2cc4IliNxLiVaJuSKYyRqofOUMnhdFBjwNwg/exec";

// --- Estado global ---
let orders = [];
let flexOrders = [];
let currentOperator = localStorage.getItem('vesco_operator') || '';
let map, mapFlex, markerCluster, markerClusterFlex;
let renderTimer = null;
let geocodeCache = {};
let geocodeQueue = [];
let geocodeProcessing = false;
let currentMapRenderToken = 0; // Previne pins duplicados (Async Bleeding)
const GEOCODE_DELAY_MS = 1100; // delay entre requisições Nominatim

const DEBUG_DATES = (new URLSearchParams(window.location.search)).get('debug_dates') === '1';

// --- Helpers básicos ---
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 60);
}
function escapeHtml(t){ if(t === null || t === undefined) return ''; return String(t).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
function normalizeOrderNumber(n){
  if(n === null || n === undefined) return '';
  let s = String(n).trim();
  s = s.replace(/^#/, '').replace(/\s+/g, '');
  s = s.replace(/[^0-9A-Za-z\-_.]/g,'');
  return s;
}
function normalizeEcomNumber(v){
  if(v === null || v === undefined) return '';
  let s = String(v).trim();
  const digits = s.replace(/\D/g,'');
  if(digits.length >= 5) return digits;
  s = s.replace(/\s+/g, '').replace(/[^0-9A-Za-z\-_]/g,'');
  return s || '';
}
function parseNumberLoose(v){
  if(v === null || v === undefined) return NaN;
  if(typeof v === 'number') return v;
  return parseFloat(String(v).trim().replace(/\s+/g,'').replace(',', '.').replace(/[^0-9\.\-]/g, ''));
}
function _isValidLat(v){ return Number.isFinite(v) && Math.abs(v) <= 90; }
function _isValidLon(v){ return Number.isFinite(v) && Math.abs(v) <= 180; }
function _tryNormalizeNumber(v, isLat){
  if(v === null || v === undefined) return null;
  const n = parseNumberLoose(v);
  if(!Number.isFinite(n)) return null;
  if(isLat && _isValidLat(n)) return n;
  if(!isLat && _isValidLon(n)) return n;
  const divisors = [1e6, 1e7, 1e5, 1e3, 1e2];
  for(const d of divisors){
    const nv = n / d;
    if(isLat && _isValidLat(nv)) return nv;
    if(!isLat && _isValidLon(nv)) return nv;
  }
  return null;
}
function getCoords(item) {
  const laRaw = item.lat ?? item.latitude ?? item.latitude_local ?? item.lat_br ?? item.lat_local ?? item.geo_lat ?? item.latitud ?? '';
  const loRaw = item.lon ?? item.longitude ?? item.longitude_local ?? item.lon_br ?? item.lon_local ?? item.geo_lon ?? item.longitud ?? '';
  const lat = _tryNormalizeNumber(laRaw, true);
  const lon = _tryNormalizeNumber(loRaw, false);
  if(lat === null || lon === null) return null;
  return { lat: lat, lon: lon };
}

// -------------------------
// DATA: FUNÇÃO DEFINITIVA
// -------------------------

function excelSerialToDate(serial) {
  const days = Number(serial);
  if (!Number.isFinite(days)) return null;
  const epoch = new Date(Date.UTC(1899, 11, 30));
  const ms = epoch.getTime() + Math.round(days * 24 * 60 * 60 * 1000);
  const d = new Date(ms);
  return isNaN(d) ? null : d;
}

function formatToDDMMYYYY(d){
  if(!d || isNaN(d)) return '';
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function extractFirstDateLikeString(s){
  if(!s) return '';
  const str = String(s);
  const regexes = [
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/, 
    /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/,   
    /(\d{10,13})/                          
  ];
  for(const r of regexes){
    const m = str.match(r);
    if(m) return m[1];
  }
  return '';
}

function parseAnyDateValue(v){
  if(v === null || v === undefined) return null;
  if(typeof v === 'number') {
    if (v > 20000 && v < 60000) {
      const d = excelSerialToDate(v);
      if(d) return d;
    }
    if(v > 1e11) { const d = new Date(v); if(!isNaN(d)) return d; }
  }
  const s = String(v).trim();
  if(!s) return null;
  if(/^\d{10,13}$/.test(s)) {
    const n = parseInt(s,10);
    const ts = (s.length === 10) ? n*1000 : n;
    const d = new Date(ts);
    if(!isNaN(d)) return d;
  }
  if(/^\d{5,6}$/.test(s) && Number(s) > 20000 && Number(s) < 60000) {
    const d = excelSerialToDate(Number(s));
    if(d) return d;
  }
  const isoMatch = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if(isoMatch) {
    const y = Number(isoMatch[1]), m = Number(isoMatch[2]) - 1, day = Number(isoMatch[3]);
    const dd = new Date(y, m, day);
    if(!isNaN(dd)) return dd;
  }
  const brMatch = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if(brMatch) {
    let day = Number(brMatch[1]), month = Number(brMatch[2]) - 1, year = Number(brMatch[3]);
    if(year < 100) year += 2000;
    const dd = new Date(year, month, day);
    if(!isNaN(dd)) return dd;
  }
  const d2 = new Date(s);
  if(!isNaN(d2)) return d2;
  return null;
}

function extractDateDefinitive(input){
  if(input && typeof input === 'object' && !Array.isArray(input)) {
    const preferredKeys = [
      'data_prevista','data','data_previsao','data_previsão','previsao','dataentrega',
      'deliverydate','expecteddate','dateexpected','eta','scheduled','scheduledat','data_prev'
    ];
    for(const k of preferredKeys){
      for(const key in input){
        if(!Object.prototype.hasOwnProperty.call(input, key)) continue;
        if(key.toLowerCase().replace(/[^a-z0-9]/g,'').includes(k.replace(/[^a-z0-9]/g,''))) {
          const v = input[key];
          if(v !== undefined && v !== null && String(v).trim() !== '') {
            const candidate = String(v).trim();
            const substr = extractFirstDateLikeString(candidate) || candidate;
            const parsed = parseAnyDateValue(substr);
            if(parsed) return formatToDDMMYYYY(parsed);
            if(/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(candidate)) {
              const parts = candidate.split(/[\/\-]/);
              let day = parts[0].padStart(2,'0'), month = parts[1].padStart(2,'0'), year = parts[2];
              if(year.length === 2) year = '20' + year;
              return `${day}/${month}/${year}`;
            }
          }
        }
      }
    }
    for(const k in input){
      if(!Object.prototype.hasOwnProperty.call(input, k)) continue;
      const v = input[k];
      if(v === null || v === undefined) continue;
      const candidateString = String((typeof v === 'object') ? (v.value || v.text || v.date || '') : v);
      const substr = extractFirstDateLikeString(candidateString);
      if(substr) {
        const parsed = parseAnyDateValue(substr);
        if(parsed) return formatToDDMMYYYY(parsed);
      }
    }
    try {
      const all = JSON.stringify(input);
      const substr = extractFirstDateLikeString(all);
      if(substr) {
        const parsed = parseAnyDateValue(substr);
        if(parsed) return formatToDDMMYYYY(parsed);
      }
    } catch(e){}
    return '';
  }
  if(Array.isArray(input) && input.length > 0 && Array.isArray(input[0])) {
    const header = input[0].map(h => String(h || '').trim());
    const headerNorm = header.map(h => h.toLowerCase().replace(/[^a-z0-9]/g,''));
    const dateCandidates = ['dataprevista','data_prevista','data','previsao','dataentrega','deliverydate','expecteddate','eta','scheduled'];
    let idx = -1;
    for(let i=0;i<headerNorm.length;i++) if(dateCandidates.includes(headerNorm[i])) { idx = i; break; }
    if(idx === -1) {
      for(let i=0;i<headerNorm.length;i++) if(/prev|previs|entreg|delivery|date|data/.test(headerNorm[i])) { idx = i; break; }
    }
    if(idx !== -1 && input.length > 1) {
      const raw = input[1][idx];
      const substr = extractFirstDateLikeString(String(raw||''));
      const parsed = parseAnyDateValue(substr || raw);
      if(parsed) return formatToDDMMYYYY(parsed);
    }
    if(input.length > 1) {
      for(const cell of input[1]) {
        const substr = extractFirstDateLikeString(String(cell||''));
        if(substr) {
          const parsed = parseAnyDateValue(substr);
          if(parsed) return formatToDDMMYYYY(parsed);
        }
      }
    }
    return '';
  }
  const raw = input;
  let candidate = extractFirstDateLikeString(raw) || String(raw||'').trim();
  const parsed = parseAnyDateValue(candidate);
  if(parsed) return formatToDDMMYYYY(parsed);
  return '';
}

function extractDateDefinitiveWithDebug(input){
  const result = extractDateDefinitive(input);
  if(DEBUG_DATES) {
    try { console.info('DATE_EXTRACT DEBUG', { input, result }); } catch(e){}
  }
  return result;
}

// -------------------------
// Geocoding (Fila Lenta de Socorro - PLANO B)
// Só entra em ação se o Google Apps Script falhar e não mandar a coordenada.
// -------------------------
function normalizeAddressKey(addr){
  if(!addr) return '';
  return String(addr).trim().replace(/\s+/g,' ').toLowerCase();
}

function geocodeAddress(address){
  return new Promise((resolve, reject) => {
    if(!address || String(address).trim() === '') return resolve(null);
    const key = normalizeAddressKey(address);
    if(geocodeCache.hasOwnProperty(key)) return resolve(geocodeCache[key]);
    
    // Coloca na fila de espera
    geocodeQueue.push({ address, resolve, reject });
    processGeocodeQueue();
  });
}

function processGeocodeQueue(){
  if(geocodeProcessing) return;
  geocodeProcessing = true;
  
  const next = () => {
    const item = geocodeQueue.shift();
    if(!item){ geocodeProcessing = false; return; }

    const address = item.address;
    const key = normalizeAddressKey(address);
    const q = encodeURIComponent(address + ', Brasil'); // Força a busca no Brasil
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=0`;

    // Busca na internet direto pelo navegador
    fetch(url, { headers: { 'Accept-Language': 'pt-BR' } })
      .then(r => r.json())
      .then(js => {
        if(Array.isArray(js) && js.length > 0){
          const p = js[0];
          const res = { lat: parseFloat(p.lat), lon: parseFloat(p.lon) };
          geocodeCache[key] = res; // Salva na memória do navegador
          item.resolve(res);
        } else {
          geocodeCache[key] = null;
          item.resolve(null);
        }
      }).catch(err => {
        console.warn('Erro no Geocode de Socorro (Plano B)', err);
        geocodeCache[key] = null;
        item.resolve(null);
      }).finally(() => {
        // FREIO DE SEGURANÇA: Espera 1.5 segundos antes de pesquisar o próximo buraco
        setTimeout(next, 1500);
      });
  };
  next();
}

function tryGeocodeIfNeeded(item, onResolved){
  const coords = getCoords(item);
  
  // PLANO A: Se o Google Sheets já mandou a coordenada, usa na hora e não faz nada!
  if(coords){ 
    if(typeof onResolved === 'function') onResolved(coords); 
    return; 
  }
  
  // PLANO B: Se não tem coordenada, aciona o socorro para pesquisar o texto
  const addr = (item.endereco_completo || item.endereco || '').trim();
  if(!addr) { 
    if(typeof onResolved === 'function') onResolved(null); 
    return; 
  }

  const cacheKey = normalizeAddressKey(addr);
  if(geocodeCache.hasOwnProperty(cacheKey)) {
    const c = geocodeCache[cacheKey];
    if(typeof onResolved === 'function') onResolved(c ? {lat: c.lat, lon: c.lon} : null);
    return;
  }

  // Manda para a Fila Lenta
  geocodeAddress(addr).then(res => {
    if(typeof onResolved === 'function') onResolved(res ? { lat: res.lat, lon: res.lon } : null);
  });
}

// -------------------------
// Ícone, jsonp, util, findArrayInObject
// -------------------------
function createPinSVG(color='#eab308', size=28){
  const inner = Math.max(8, Math.round(size * 0.35));
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6z" fill="${color}" stroke="#ffff" stroke-width="1.2"/>
      <circle cx="12" cy="8" r="${inner/4}" fill="#fff" />
    </svg>
  `;
}
function jsonpFetch(url, cb) {
  const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
  const script = document.createElement('script');
  const timeout = setTimeout(() => {
     try { delete window[cbName]; } catch(e){}
     if (script.parentNode) script.remove();
     cb(new Error("Timeout"), null);
  }, 15000);
  window[cbName] = function(res) {
    clearTimeout(timeout);
    try { cb(null, res); } catch(e){}
    try { delete window[cbName]; } catch(e){}
    if (script.parentNode) script.remove();
  };
  const sep = url.indexOf('?') === -1 ? '?' : '&';
  script.src = `${url}${sep}callback=${cbName}`;
  script.id = cbName;
  document.head.appendChild(script);
}
function jsonpFetchPromise(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
    const script = document.createElement('script');
    let timer = null;
    function cleanup() {
      if (timer) clearTimeout(timer);
      try { delete window[cbName]; } catch(e){}
      if (script.parentNode) script.remove();
    }
    window[cbName] = function(res){
      cleanup();
      resolve({ jsonp: true, resp: res });
    };
    script.onerror = function(ev){
      cleanup();
      reject(new Error('JSONP script error'));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('JSONP timeout'));
    }, timeoutMs);
    const sep = url.indexOf('?') === -1 ? '?' : '&';
    script.src = `${url}${sep}callback=${cbName}`;
    document.head.appendChild(script);
  });
}
function findArrayInObject(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return obj;
  if (typeof obj !== 'object') return null;
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (v && typeof v === 'object') {
      for (const k2 in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k2)) continue;
        if (Array.isArray(v[k2])) return v[k2];
      }
    }
  }
  return null;
}

// -------------------------
// Normalizadores
// -------------------------
function normalizeKeyName(k){
  if(k === null || k === undefined) return '';
  return String(k).toString().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
}
function extractClientNameFromAny(obj) {
  if (!obj) return '';
  const keys = [
    'cliente_nome','cliente','destinatario','destinatário','nome','receiver','recipient',
    'customer_name','customer','client','nome_cliente','destinatario_nome','nome_destinatario',
    'consignee','to_name','ship_to_name','dest'
  ];
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return String(obj[k]).trim();
    }
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && /[A-Za-zÀ-ú]+(\s+[A-Za-zÀ-ú]+){1,4}/.test(v) && v.length < 90) {
      return v.trim();
    }
  }
  return '';
}
function extractEcomNumberFromAny(obj) {
  if (!obj) return '';
  const keys = [
    'numero_ecommerce','numero_ecom','ecom','ecom_id','order_reference','order_ref',
    'reference','referencia','reference_number','merchant_order_id','marketplace_order_id',
    'external_id','external_reference','codigo_externo','order_id','orderNumber','id'
  ];
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return normalizeEcomNumber(obj[k]);
    }
  }
  const fallbackCandidates = ['reference','referencia','order_id','codigo_externo','id'];
  for (const f of fallbackCandidates) {
    if (f in obj && obj[f]) {
      const s = String(obj[f]).trim();
      const digits = s.replace(/\D/g, '');
      if (digits.length >= 5) return digits;
      if (s.length >= 4) return s;
    }
  }
  return '';
}
function extractStoreNameFromAny(obj) {
  if (!obj) return '';
  const keys = [
    'conta','loja','store','store_name','nome_loja','account','seller','shop','marketplace','loja_nome','store_id','merchant','conta'
  ];
  for (const k of keys) {
    if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return String(obj[k]).trim();
    }
  }
  for (const k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
    const v = String(obj[k] || '');
    const m = v.match(/(loja[:\s]+[A-Za-z0-9\-\s]+)/i);
    if (m && m[1]) return m[1].replace(/loja[:\s]+/i, '').trim();
  }
  return '';
}

// -------------------------
// Carregamento dos dados
// -------------------------
function load(){
  // ERP (JSONP)
  jsonpFetch(API, function(err, resp){
    if (resp && resp.success) {
      let dadosErp = (resp.data || []).filter(o => (o.numero || o.id || o.pedido));
      orders = dadosErp.map(normalizeOrderObject);
      orders.forEach(o => {
        o.data_prevista = o.data_prevista && String(o.data_prevista).trim() ? extractDateDefinitiveWithDebug(o.data_prevista) : extractDateDefinitiveWithDebug(o);
      });
      scheduleRender();
    } else if (Array.isArray(resp)) {
      orders = (resp || []).map(normalizeOrderObject);
      orders.forEach(o => { o.data_prevista = o.data_prevista && String(o.data_prevista).trim() ? extractDateDefinitiveWithDebug(o.data_prevista) : extractDateDefinitiveWithDebug(o); });
      scheduleRender();
    } else {
      orders = [];
      scheduleRender();
    }
  });

  // FLEX
  (function fetchFlexRobust(){
    const urlBase = `${API_FLEX}?action=separacoesIndex`;
    const JSONP_TIMEOUT = 15000;

    jsonpFetchPromise(urlBase, JSONP_TIMEOUT).then(result => {
      processFlexResponse(result.resp);
    }).catch(jsonpErr => {
      fetch(urlBase, { cache: 'no-store' }).then(r => r.text()).then(txt => {
        try {
          const parsed = JSON.parse(txt);
          processFlexResponse(parsed);
        } catch(e) {
          const m = txt.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
          if (m && m[1]) {
            try {
              const parsed2 = JSON.parse(m[1]);
              processFlexResponse(parsed2);
              return;
            } catch(e2){}
          }
          try {
            const maybe = JSON.parse(txt.replace(/\n/g,''));
            processFlexResponse(maybe);
            return;
          } catch(e3){}
          flexOrders = [];
          scheduleRender();
        }
      }).catch(fetchErr => {
        flexOrders = [];
        scheduleRender();
      });
    });

    function processFlexResponse(resp){
      let dadosBrutos = findArrayInObject(resp) || (Array.isArray(resp) ? resp : null);
      if(!dadosBrutos || dadosBrutos.length === 0) {
        dadosBrutos = [];
        const q = [resp];
        while(q.length && dadosBrutos.length === 0) {
          const n = q.shift();
          for(const k in n){
            if(!Object.prototype.hasOwnProperty.call(n,k)) continue;
            const v = n[k];
            if(Array.isArray(v)) { dadosBrutos = v; break; }
            if(v && typeof v === 'object') q.push(v);
          }
        }
      }
      if(!dadosBrutos) dadosBrutos = [];

      if (Array.isArray(dadosBrutos) && dadosBrutos.length > 0 && Array.isArray(dadosBrutos[0])) {
        const headerRow = dadosBrutos[0].map(h => String(h || '').trim());
        const headerNorm = headerRow.map(h => normalizeKeyName(h || ''));
        const dataRows = dadosBrutos.slice(1);
        const possibleDateKeys = ['dataprevista','data_prevista','data','previsao','dataentrega','deliverydate','expecteddate','eta','scheduled'];
        let idxDate = -1;
        for (let i = 0; i < headerNorm.length; i++) {
          if (possibleDateKeys.includes(headerNorm[i])) { idxDate = i; break; }
        }
        if (idxDate === -1) {
          for (let i = 0; i < headerNorm.length; i++){
            if (/(prev|previs|entreg|delivery|expected|date|data)/i.test(headerNorm[i])) { idxDate = i; break; }
          }
        }
        const possibleStoreKeys = ['conta','loja','store','store_name','nome_loja','account','merchant'];
        let idxStore = -1;
        for (let i = 0; i < headerNorm.length; i++) {
          if (possibleStoreKeys.includes(headerNorm[i])) { idxStore = i; break; }
        }
        if (idxStore === -1) {
          for (let i = 0; i < headerNorm.length; i++){
            if (/(conta|loja|store|merchant|seller)/i.test(headerNorm[i])) { idxStore = i; break; }
          }
        }

        dadosBrutos = dataRows.map(row => {
          const obj = {};
          for (let i = 0; i < headerRow.length; i++) {
            const key = headerRow[i] || `col${i}`;
            obj[key] = row[i];
          }
          if (idxDate !== -1) obj['data_prevista_raw'] = row[idxDate];
          if (idxStore !== -1) obj['store_raw'] = row[idxStore];
          return obj;
        });
      }

      const normalized = dadosBrutos.map(raw => {
        const f = Object.assign({}, raw);
        f.numero = String(f.numero || f.id || f.pedido || f.order_id || f.orderNumber || f.reference || f.referencia || '').trim();
        f.cliente_nome = extractClientNameFromAny(f) || f.destinatario || f.cliente || f.nome || '';

        let candidate = null;
        if (f.data_prevista_raw !== undefined && f.data_prevista_raw !== null && String(f.data_prevista_raw).trim() !== '') candidate = f.data_prevista_raw;
        else {
          for(const key in f){
            if(!Object.prototype.hasOwnProperty.call(f,key)) continue;
            const nkey = normalizeKeyName(key);
            if(/prev|previs|data|entreg|sched|eta|delivery|expected/i.test(nkey) && String(f[key]).trim() !== '') {
              candidate = f[key];
              break;
            }
          }
        }
        f.data_prevista = candidate ? extractDateDefinitiveWithDebug(candidate) : extractDateDefinitiveWithDebug(f);

        f.numero_ecommerce = extractEcomNumberFromAny(f) || normalizeEcomNumber(f.numero_ecommerce || f.referencia || f.reference || f.id || '');
        const rawStoreCandidate = (f.store_raw !== undefined && f.store_raw !== null && String(f.store_raw).trim() !== '') ? String(f.store_raw).trim()
          : ( (f.conta !== undefined && f.conta !== null && String(f.conta).trim() !== '') ? String(f.conta).trim() : null );
        f.store_name = rawStoreCandidate || extractStoreNameFromAny(f) || (f.loja || f.store || f.merchant || f.conta || '');
        f.endereco_completo = f.endereco_completo || f.endereco || f.address || f.full_address || '';
        f.lat = f.lat || f.latitude || f.latitude_local || f.geo_lat || f.lat_br || '';
        f.lon = f.lon || f.longitude || f.longitude_local || f.geo_lon || f.lon_br || '';
        f.situacao_nome = f.situacao_nome || f.status || f.situacao || '';
        f.id = f.id || f.numero || f.pedido || (f.order_id || '');
        return f;
      });

      flexOrders = normalized;
      scheduleRender();
    }
  })();
}

function normalizeOrderObject(item) {
  const obj = Object.assign({}, item);
  obj.numero = obj.numero || obj.id || obj.pedido || obj.order_id || obj.orderNumber || obj.reference || obj.referencia || '';
  obj.numero = String(obj.numero || '').trim();
  obj.cliente_nome = String(obj.cliente_nome || obj.cliente || obj.destinatario || obj.nome || obj.receiver || obj.recipient || '').trim();
  obj.endereco_completo = obj.endereco_completo || obj.endereco || obj.address || obj.full_address || obj.address_line || '';
  obj.lat = obj.lat || obj.latitude || obj.latitude_local || obj.geo_lat || obj.lat_br || '';
  obj.lon = obj.lon || obj.longitude || obj.longitude_local || obj.geo_lon || obj.lon_br || '';
  obj.data_prevista = obj.data_prevista || obj.data_previsao || obj.previsao || obj.data_prev || obj.data_entrega || '';
  obj.status_logistica = obj.status_logistica || obj.status || obj.situacao || '';
  obj.id = obj.id || obj.numero || '';
  obj.data_prevista = obj.data_prevista && String(obj.data_prevista).trim() ? extractDateDefinitiveWithDebug(obj.data_prevista) : extractDateDefinitiveWithDebug(obj);
  return obj;
}

// -------------------------
// Plotagem de marcadores (COM CORREÇÃO DE DUPLICAÇÃO ASYNC)
// -------------------------
window.activeMainMarkers = {};
window.activeFlexMarkers = {};

let flexBoundsTimer = null;
let mainBoundsTimer = null;

function plotMapMarkers(orderList, flexList){
  if(!markerCluster || !markerClusterFlex) return;

  // INCREMENTA O TOKEN A CADA RENDER. Isso impede que uma busca demorada 
  // no Nominatim coloque um pino na tela antiga e duplique as contagens.
  currentMapRenderToken++;
  const myToken = currentMapRenderToken;

  markerCluster.clearLayers();
  markerClusterFlex.clearLayers();

  window.activeMainMarkers = {};
  window.activeFlexMarkers = {};

  // Auto-foco com debounce suave
  function debouncedFitBoundsMain() {
    clearTimeout(mainBoundsTimer);
    mainBoundsTimer = setTimeout(() => {
        if(myToken !== currentMapRenderToken) return;
        try {
            if (markerCluster.getLayers().length > 0) {
                const b = markerCluster.getBounds();
                if(b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 14 });
            }
        } catch(e){}
    }, 600);
  }

  function debouncedFitBoundsFlex() {
    clearTimeout(flexBoundsTimer);
    flexBoundsTimer = setTimeout(() => {
        if(myToken !== currentMapRenderToken) return;
        try {
            if (markerClusterFlex.getLayers().length > 0) {
                const b = markerClusterFlex.getBounds();
                if(b && b.isValid && b.isValid()) mapFlex.fitBounds(b.pad(0.12), { maxZoom: 14 });
            }
        } catch(e){}
    }, 600);
  }

  function addMainMarker(item, lat, lon){
    if (myToken !== currentMapRenderToken) return; // Async bleeding cancelado!
    
    const ecomNum = (item.numero_ecommerce || getEcomNum(item) || '').toString();
    const normNum = normalizeOrderNumber(item.numero || item.id || item.pedido || '');
    
    // Evita duplicados na mesma renderização
    if (window.activeMainMarkers[normNum]) return; 

    const popupHtml = `<div class='p-1 font-sans'><b class='text-blue-600 text-sm'>Pedido #${escapeHtml(String(item.numero || ''))}</b><br><small class='text-xs text-slate-600 font-medium'>${escapeHtml(String(item.endereco_completo || ''))}</small><br><div class='text-[13px] text-slate-800 font-semibold mt-1'>${escapeHtml(String(item.cliente_nome || ''))}</div><div class='text-xs text-slate-500 mt-1'>Data Prevista: <b>${escapeHtml(String(item.data_prevista || '—'))}</b></div><div class='text-xs text-slate-400 mt-1'>ecom: ${escapeHtml(ecomNum || '—')}</div></div>`;
    const svgHtml = createPinSVG('#004f9f', 30);
    const icon = L.divIcon({ html: svgHtml, className: '', iconSize: [30,30], iconAnchor: [15,30] });
    const m = L.marker([lat, lon], { icon }).bindPopup(popupHtml);
    
    markerCluster.addLayer(m);
    try { if(normNum) window.activeMainMarkers[normNum] = m; if(ecomNum) window.activeMainMarkers[ecomNum] = m; window.activeMainMarkers[String(item.numero || item.id || '')] = m; } catch(e){}
    debouncedFitBoundsMain();
  }

  function addFlexMarker(item, lat, lon){
    if (myToken !== currentMapRenderToken) return; // Async bleeding cancelado!

    const ecomNum = (item.numero_ecommerce || '').toString();
    const normNum = normalizeOrderNumber(item.numero || item.id || '');

    // Evita duplicados na mesma renderização
    if (window.activeFlexMarkers[normNum]) return; 

    const popupHtml = `<div class='p-1 font-sans'><b class='text-amber-500 text-sm'>Flex #${escapeHtml(String(item.numero || item.id || ''))}</b><br><small class='text-xs text-slate-600 font-medium'>${escapeHtml(String(item.endereco_completo || ''))}</small><br><div class='text-[13px] text-slate-800 font-semibold mt-1'>${escapeHtml(String(item.cliente_nome || ''))}</div><div class='text-xs text-slate-500 mt-1'>Data Prevista: <b>${escapeHtml(String(item.data_prevista || '—'))}</b></div><div class='text-xs text-slate-400 mt-1'>ecom: ${escapeHtml(ecomNum || '—')}</div><div class='text-xs text-slate-400 mt-1'>Loja: ${escapeHtml(item.store_name || '—')}</div></div>`;
    const svgHtmlFlex = createPinSVG('#eab308', 30);
    const iconFlex = L.divIcon({ html: svgHtmlFlex, className: '', iconSize: [30,30], iconAnchor: [15,30] });
    const mFlex = L.marker([lat, lon], { icon: iconFlex }).bindPopup(popupHtml);
    
    markerClusterFlex.addLayer(mFlex);
    try { if(normNum) window.activeFlexMarkers[normNum] = mFlex; if(ecomNum) window.activeFlexMarkers[ecomNum] = mFlex; window.activeFlexMarkers[String(item.numero || item.id || '')] = mFlex; } catch(e){}
    debouncedFitBoundsFlex();
  }

  for(const item of (orderList||[])){
    const coords = getCoords(item);
    if(coords){
      addMainMarker(item, coords.lat, coords.lon);
    } else {
      tryGeocodeIfNeeded(item, (c) => {
        if(c) addMainMarker(item, c.lat, c.lon);
      });
    }
  }

  for(const item of (flexList||[])){
    const coords = getCoords(item);
    if(coords){
      addFlexMarker(item, coords.lat, coords.lon);
    } else {
      tryGeocodeIfNeeded(item, (c) => {
        if(c) addFlexMarker(item, c.lat, c.lon);
      });
    }
  }
}

function getEcomNum(item){
  if(!item) return '';
  const candidates = [
    item.numero_ecommerce, item.numero_ecom, item.ecom_num, item.id_ecom,
    item.referencia, item.reference, item.ref, item.ecom, item.ecommerce_id,
    item.order_reference, item.order_ref, item.orderNumber, item.order_id, item.order,
    item.codigo_externo, item.codigo
  ];
  for(const c of candidates){
    if(c !== undefined && c !== null && String(c).trim() !== '') {
      const normalized = normalizeEcomNumber(c);
      if(normalized) return normalized;
    }
  }
  const fallback = item.numero || item.id || item.pedido || '';
  const maybe = normalizeEcomNumber(fallback);
  return maybe || '';
}

// -------------------------
// Render da UI (tabelas)
// -------------------------
function render(){
  const searchEl = document.getElementById('search');
  const searchQ = (searchEl && searchEl.value) ? searchEl.value.toLowerCase() : '';
  const tbodyFila = document.getElementById('table-fila');
  const tbodySepHoje = document.getElementById('table-separados-hoje');
  const tbodyPend = document.getElementById('table-pendencias');
  const tbodyLog = document.getElementById('table-logistica');
  const tbodyFlexCorpo = document.getElementById('table-envios-flex-corpo');
  const tbodyEntregues = document.getElementById('table-entregues');

  // 1. FILA ATIVA (ERP)
  const filaOrders = orders.filter(o => {
    const st = String(o.status_logistica || '').toLowerCase().trim();
    return (st === 'a separar' || st === 'em separação') && (String(o.numero || '').toLowerCase().includes(searchQ) || String(o.cliente_nome || '').toLowerCase().includes(searchQ));
  });

  if (tbodyFila) {
    if (filaOrders.length === 0) {
      tbodyFila.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido aguardando separação.</td></tr>`;
    } else {
      tbodyFila.innerHTML = filaOrders.map((o, idx) => {
        const id = o.id || o.numero || '';
        const statusAtual = o.status_logistica || 'A Separar';
        const statusLower = String(statusAtual).toLowerCase().trim();
        
        let badgeStyle = 'badge-strict-vermelho', dotStyle = 'dot-blink-red';
        if(statusLower.includes('em separa')) { badgeStyle = 'badge-strict-amarelo'; dotStyle = 'dot-strict-amarelo'; } 
        else if(statusLower.includes('a separar')) { badgeStyle = 'badge-strict-vermelho'; dotStyle = 'dot-blink-red'; } 
        else if(statusLower.includes('pronto')) { badgeStyle = 'badge-strict-verde'; dotStyle = 'dot-strict-verde'; } 
        else { badgeStyle = 'badge-strict-azul'; dotStyle = 'dot-strict-azul'; }
        
        const displayDataPrev = (o.data_prevista && String(o.data_prevista).trim()) ? String(o.data_prevista).trim() : '—';
        const ecomRaw = getEcomNum(o) || '';
        const ecomNorm = normalizeEcomNumber(ecomRaw);
        
        const instrucaoStr = String(o.instrucao_entrega || o.forma_pagamento || '—').toUpperCase();
        let paymentBadgeClass = "bg-slate-50 text-slate-600 border-slate-200"; 
        
        if (instrucaoStr.includes('JÁ PAGO')) {
          paymentBadgeClass = "bg-emerald-50 text-emerald-700 border-emerald-200";
        } else if (instrucaoStr.includes('CONFERIR')) {
          paymentBadgeClass = "bg-amber-50 text-amber-700 border-amber-200";
        } else if (instrucaoStr.includes('MAQUININHA')) {
          paymentBadgeClass = "bg-blue-50 text-blue-700 border-blue-200";
        } else if (instrucaoStr.includes('DINHEIRO')) {
          paymentBadgeClass = "bg-indigo-50 text-indigo-700 border-indigo-200";
        }

        return `
          <tr id="row-pedido-${escapeHtml(id)}" data-num="${escapeHtml(normalizeOrderNumber(o.numero || ''))}" data-ecom="${escapeHtml(ecomNorm)}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 transition-colors text-xs md:text-sm">
            <td class="p-3 pl-4"><span class="status-pill ${badgeStyle}"><span class="status-dot ${dotStyle}"></span><span>${escapeHtml(statusAtual)}</span></span></td>
            
            <td class="p-3 font-bold text-slate-900">#${escapeHtml(o.numero || 'S/N')}
              <div class="text-[12px] text-slate-800 font-semibold mt-1">${escapeHtml(o.cliente_nome || '')}</div>
            </td>
            
            <td class="p-3 text-center"><input type="time" class="bg-white border border-slate-200 rounded-lg px-2 py-0.5 text-center font-bold text-xs md:text-sm w-20 shadow-sm focus:border-blue-500 outline-none" value="${o.alarme || ''}" onchange="updateAlarmTimeJsonp('${escapeHtml(id)}', this.value)"></td>
            
            <td class="p-3 text-center font-mono text-[#004f9f] font-bold hidden md:table-cell">${escapeHtml(displayDataPrev)}</td>
            
            <td class="p-3 text-xs text-slate-500 max-w-xs truncate hidden lg:table-cell">${escapeHtml(o.endereco_completo || '')}</td>
            
            <td class="p-3 align-middle">
              <span class="text-[11px] font-bold px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-sm border ${paymentBadgeClass}">
                ${escapeHtml(instrucaoStr)}
              </span>
            </td>

            <td class="p-3 pr-4 align-middle text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button class="bg-amber-500 hover:bg-amber-600 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="moverParaPendenciaPrompt('${escapeHtml(id)}')">Pendência</button>
                <button class="bg-blue-600 hover:bg-blue-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="updateStatusJsonp('${escapeHtml(id)}','Em Separação')">Iniciar</button>
                <button class="bg-emerald-600 hover:bg-emerald-700 text-white px-2.5 py-1.5 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="updateStatusJsonp('${escapeHtml(id)}','Pronto p/ Entrega')">Concluir</button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }
  }

  // Separados hoje
  if (tbodySepHoje) {
    const prontosOrders = orders.filter(o => String(o.status_logistica || '').toLowerCase().trim().includes('pronto') && (String(o.numero || '').toLowerCase().includes(searchQ) || String(o.cliente_nome || '').toLowerCase().includes(searchQ)));
    tbodySepHoje.innerHTML = prontosOrders.length === 0 ? `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum registro encontrado.</td></tr>` : prontosOrders.map((o, idx) => `
      <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
        <td class="p-3 pl-4 font-bold text-slate-900">#${escapeHtml(o.numero)}</td>
        <td class="p-3 font-semibold text-slate-800">${escapeHtml(o.cliente_nome)}</td>
        <td class="p-3 text-center"><span class="text-blue-700 font-mono font-bold bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-100">${escapeHtml(o.tempo_separacao || '—')}</span></td>
        <td class="p-3 text-center"><span class="status-pill badge-strict-verde"><span class="status-dot dot-strict-verde"></span>Separado</span></td>
        <td class="p-3 pr-4 text-right"><button class="bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-700 px-3 py-1 rounded-lg font-bold text-[11px] transition-all" onclick="updateStatusJsonp('${escapeHtml(o.id)}','A Separar')"><i class="fas fa-rotate-left mr-1"></i>Refazer</button></td>
      </tr>`).join('');
  }

  // Pendências
  if (tbodyPend) {
    const pendOrders = orders.filter(o => String(o.status_logistica || '').toLowerCase().trim() === 'pendente');
    tbodyPend.innerHTML = pendOrders.length === 0 ? `<tr><td colspan="4" class="p-4 text-center text-slate-400 font-semibold">Nenhuma pendência ativa no momento.</td></tr>` : pendOrders.map((o, idx) => `
      <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} text-xs md:text-sm text-slate-700">
        <td class="p-3 pl-4 font-bold text-slate-900">#${escapeHtml(o.numero)}</td>
        <td class="p-3 font-semibold text-slate-800">${escapeHtml(o.cliente_nome)}</td>
        <td class="p-3"><span class="text-red-700 font-medium bg-red-50/60 border border-red-100 px-3 py-1 rounded-lg inline-flex items-center gap-1.5"><i class="fas fa-circle-exclamation text-xs"></i> ${escapeHtml(o.observacao_logistica || 'Falta de estoque')}</span></td>
        <td class="p-3 pr-4 text-right"><button class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-lg text-xs font-bold shadow-sm transition-all" onclick="updateStatusJsonp('${escapeHtml(o.id)}','A Separar')">Liberar</button></td>
      </tr>`).join('');
  }

  // Logística (ERP prontos)
  if (tbodyLog) {
    const prontosOrders = orders.filter(o => String(o.status_logistica || '').toLowerCase().trim().includes('pronto'));
    const logOrdersPadrao = prontosOrders.filter(o => {
      const frete = String(o.nomeformafenvio || o.nome_forma_envio || o.forma_envio || '').toLowerCase();
      return !frete.includes('flex') && !frete.includes('mercado');
    });
    tbodyLog.innerHTML = logOrdersPadrao.map((o, idx) => {
      const ecomRaw = getEcomNum(o) || '';
      const ecomNorm = normalizeEcomNumber(ecomRaw);
      const displayDataPrev = (o.data_prevista && String(o.data_prevista).trim()) ? String(o.data_prevista).trim() : '—';
      return `
      <tr id="row-pedido-${escapeHtml(o.id)}" data-num="${escapeHtml(normalizeOrderNumber(o.numero))}" data-ecom="${escapeHtml(ecomNorm)}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm cursor-pointer" onclick="focusOrderOnMap('${escapeHtml(ecomNorm || normalizeOrderNumber(o.numero))}')">
        <td class="p-3 pl-4 font-bold text-slate-900">
          <div class="flex items-center gap-1.5">
            <span>#${escapeHtml(o.numero)}</span>
            <button class="ml-2 bg-blue-50 hover:bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center transition-all border border-blue-200" title="Ver localização do pedido" onclick="event.stopPropagation(); focusOrderOnMap('${escapeHtml(ecomNorm || normalizeOrderNumber(o.numero))}')">
              <i class="fas fa-crosshairs"></i>
            </button>
          </div>
          <div class="text-[11px] text-slate-400">ecom: ${escapeHtml(ecomNorm || '—')}</div>
          <div class="text-[12px] text-slate-800 font-semibold mt-1">${escapeHtml(o.cliente_nome || '')}</div>
        </td>
        <td class="p-3 text-center font-mono font-bold text-slate-600">${escapeHtml(o.alarme || '—')}</td>
        <td class="p-3 text-center font-mono font-bold text-slate-600 hidden md:table-cell">${escapeHtml(displayDataPrev)}</td>
        <td class="p-3"><b class="text-slate-800">${escapeHtml(o.cliente_nome)}</b><div class="text-[11px] text-slate-400 mt-0.5 truncate max-w-xs hidden md:block">${escapeHtml(o.endereco_completo)}</div></td>
        <td class="p-3 bg-slate-50/40 hidden md:table-cell text-xs font-semibold text-slate-500">${escapeHtml(o.instrucao_entrega || '—')}</td>
        <td class="p-3 pr-4 text-right space-x-1 whitespace-nowrap">
          <button class="bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-600 px-2 py-1 rounded-lg font-bold text-[11px] transition-all" onclick="event.stopPropagation(); updateStatusJsonp('${escapeHtml(o.id)}','A Separar')">Estornar</button>
          <button class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="event.stopPropagation(); prepararDespachoMotorista('${escapeHtml(o.numero)}')">Despachar</button>
        </td>
      </tr>`; 
    }).join('');
  }

  // FLEX (AGORA COM BOTÃO DE FOCO)
  if (tbodyFlexCorpo) {
    const flexFiltrados = (flexOrders || []).filter(f => {
      const q = (searchQ || '').toLowerCase();
      return (
        String(f.numero || '').toLowerCase().includes(q) ||
        String(f.cliente_nome || '').toLowerCase().includes(q) ||
        String(f.endereco_completo || '').toLowerCase().includes(q) ||
        String(f.numero_ecommerce || '').toLowerCase().includes(q) ||
        String(f.store_name || '').toLowerCase().includes(q)
      );
    });

    if (!flexFiltrados || flexFiltrados.length === 0) {
      tbodyFlexCorpo.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido Flex detectado.</td></tr>`;
    } else {
      tbodyFlexCorpo.innerHTML = flexFiltrados.map((f, idx) => {
        const numeroDoc = f.numero || 'S/N';
        const numeroEcom = f.numero_ecommerce || f.referencia || '—';
        const volumesNum = f.qtd_volumes || f.volumes || f.items_count || '1';
        const clienteNome = f.cliente_nome || f.destinatario || f.cliente || '—';
        const lojaNome = f.store_name || '—';
        const addrDisplay = f.endereco_completo || '';
        const dataPrev = f.data_prevista || '—';
        const situacaoFlex = f.situacao_nome || f.situacao || '—';
        const focusId = escapeHtml(normalizeEcomNumber(numeroEcom) || normalizeOrderNumber(numeroDoc));

        return `
          <tr data-num="${escapeHtml(normalizeOrderNumber(f.numero || ''))}" data-ecom="${escapeHtml(normalizeEcomNumber(numeroEcom))}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm text-slate-700 cursor-pointer" onclick="focusFlexOnMap('${focusId}')">
            <td class="p-3 pl-4 font-bold text-slate-900">
              <div class="flex items-center gap-1.5">
                <span>#${escapeHtml(numeroDoc)}</span>
                <button class="ml-2 bg-amber-50 hover:bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center transition-all border border-amber-200" title="Ver localização no mapa" onclick="event.stopPropagation(); focusFlexOnMap('${focusId}')">
                  <i class="fas fa-crosshairs"></i>
                </button>
              </div>
              <div class="text-[11px] text-slate-400">E‑com: ${escapeHtml(numeroEcom)}</div>
            </td>
            <td class="p-3 text-center">${escapeHtml(String(volumesNum))}</td>
            <td class="p-3">
              <b class="text-slate-900">${escapeHtml(clienteNome)}</b>
              <div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(addrDisplay)}</div>
              <div class="text-[10px] text-slate-400 mt-1 font-medium">Loja: <b>${escapeHtml(lojaNome)}</b></div>
            </td>
            <td class="p-3 text-center hidden md:table-cell"><span class="font-mono text-slate-700 font-bold">${escapeHtml(dataPrev)}</span></td>
            <td class="p-3 hidden md:table-cell">${escapeHtml(situacaoFlex)}</td>
            <td class="p-3 pr-4 text-right">
              <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;">
                <button class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-xl font-bold text-[11px] shadow-sm transition-all" onclick="event.stopPropagation(); markFlexDelivered('${escapeHtml(f.id || f.numero)}','${escapeHtml(numeroDoc)}')"><i class="fas fa-check-double"></i> Entregue</button>
              </div>
            </td>
          </tr>`;
      }).join('');
    }
  }

  // Entregues
  if (tbodyEntregues) {
    const entregueOrders = orders.filter(o => String(o.status_logistica || '').toLowerCase().trim() === 'entregue' && (String(o.numero || '').toLowerCase().includes(searchQ) || String(o.cliente_nome || '').toLowerCase().includes(searchQ)));
    tbodyEntregues.innerHTML = entregueOrders.length === 0 ? `<tr><td colspan="5" class="p-4 text-center text-slate-400 font-semibold">Nenhum despacho realizado.</td></tr>` : entregueOrders.map((o, idx) => `
      <tr class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm">
        <td class="p-3 pl-4 font-black text-slate-900">#${escapeHtml(o.numero)}</td>
        <td class="p-3 font-semibold text-slate-800">${escapeHtml(o.cliente_nome)}</td>
        <td class="p-3 text-xs text-slate-500 hidden md:table-cell">${escapeHtml(o.endereco_completo)}</td>
        <td class="p-3 text-center text-emerald-700 font-mono font-bold">${escapeHtml(o.tempo_separacao || '—')}</td>
        <td class="p-3 pr-4 text-center"><span class="bg-slate-100 text-slate-600 font-bold border border-slate-200 px-3 py-1 rounded-xl text-[10px] uppercase tracking-wider inline-flex items-center gap-1"><i class="fas fa-archive text-slate-400"></i> Finalizado</span></td>
      </tr>`).join('');
  }

  // Sumários
  const sumSepararEl = document.getElementById('sum-separar');
  const sumProcessoEl = document.getElementById('sum-processo');
  const sumTotalEl = document.getElementById('sum-total');
  const sumFlexEl = document.getElementById('sum-flex-total');
  if(sumSepararEl) sumSepararEl.innerText = orders.filter(o => !o.status_logistica || String(o.status_logistica).toLowerCase().includes('a separar')).length;
  if(sumProcessoEl) sumProcessoEl.innerText = orders.filter(o => String(o.status_logistica).toLowerCase().includes('em separa')).length;
  if(sumTotalEl) sumTotalEl.innerText = orders.length;
  if(sumFlexEl) {
     const flexFiltrados = (flexOrders || []).filter(f => String(f.numero || '').trim() !== '');
     sumFlexEl.innerText = flexFiltrados.length;
  }

  document.querySelectorAll('tr[data-num]').forEach(tr => {
    const raw = tr.getAttribute('data-num') || '';
    tr.setAttribute('data-num', normalizeOrderNumber(raw));
  });
  document.querySelectorAll('tr[data-ecom]').forEach(tr => {
    const raw = tr.getAttribute('data-ecom') || '';
    tr.setAttribute('data-ecom', normalizeEcomNumber(raw));
  });

  try {
    const logOrdersForMap = (orders || []).filter(o => {
      const frete = String(o.nomeformafenvio || o.nome_forma_envio || o.forma_envio || '').toLowerCase();
      return !frete.includes('flex') && !frete.includes('mercado');
    });
    const flexFiltradosParaMapa = (flexOrders || []).filter(f => String(f.numero || '').trim() !== '');
    plotMapMarkers(logOrdersForMap, flexFiltradosParaMapa);
  } catch (e) {
    console.warn('plotMapMarkers erro', e);
  }
  // Dispara a atualização do painel do motorista
  if (typeof renderMotorista === 'function') renderMotorista();
}

// --- Inits, mapas e handlers menores ---
function initMap() {
  try {
    const mapEl = document.getElementById('map');
    const mapFlexEl = document.getElementById('map-flex');
    if (!mapEl || !mapFlexEl) {
      return;
    }
    if (window._vesco_map_inited) return;
    window._vesco_map_inited = true;

    map = L.map('map').setView([-23.55052, -46.633308], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(map);
    if (typeof L.markerClusterGroup === 'function') {
      markerCluster = L.markerClusterGroup({ iconCreateFunction: function(cluster) { return new L.DivIcon({ html: '<div><span>' + cluster.getChildCount() + '</span></div>', className: 'marker-cluster marker-cluster-main', iconSize: new L.Point(40, 40) }); } });
    } else { markerCluster = L.layerGroup(); }
    map.addLayer(markerCluster);

    mapFlex = L.map('map-flex').setView([-23.55052, -46.633308], 11);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { attribution: '&copy; CartoDB', maxZoom: 19 }).addTo(mapFlex);
    if (typeof L.markerClusterGroup === 'function') {
      markerClusterFlex = L.markerClusterGroup({ chunkedLoading: true, iconCreateFunction: function(cluster) { return new L.DivIcon({ html: '<div><span>' + cluster.getChildCount() + '</span></div>', className: 'marker-cluster marker-cluster-flex', iconSize: new L.Point(40, 40) }); } });
    } else { markerClusterFlex = L.layerGroup(); }
    mapFlex.addLayer(markerClusterFlex);

    window.map = map;
    window.mapFlex = mapFlex;
    window.markerCluster = markerCluster;
    window.markerClusterFlex = markerClusterFlex;

    setTimeout(()=>{ try { if (map) map.invalidateSize(); if (mapFlex) mapFlex.invalidateSize(); } catch(e){} }, 300);
  } catch(e){ console.warn('initMap erro', e); }
}

// focus helpers
function findMainMarkerByKey(key){
  if(!key) return null;
  const k1 = normalizeEcomNumber(key);
  const k2 = normalizeOrderNumber(key);
  if(k1 && window.activeMainMarkers[k1]) return window.activeMainMarkers[k1];
  if(k2 && window.activeMainMarkers[k2]) return window.activeMainMarkers[k2];
  if(window.activeMainMarkers[key]) return window.activeMainMarkers[key];
  return null;
}
function findFlexMarkerByKey(key){
  if(!key) return null;
  const k1 = normalizeEcomNumber(key);
  const k2 = normalizeOrderNumber(key);
  if(k1 && window.activeFlexMarkers[k1]) return window.activeFlexMarkers[k1];
  if(k2 && window.activeFlexMarkers[k2]) return window.activeFlexMarkers[k2];
  if(window.activeFlexMarkers[key]) return window.activeFlexMarkers[key];
  return null;
}

function focusOrderOnMap(numeroOrEcom) {
  const marker = findMainMarkerByKey(numeroOrEcom);
  if (marker) {
    switchTab('logistica');
    setTimeout(() => { // Aguarda a aba ser trocada antes de centralizar
        const latLng = marker.getLatLng();
        map.setView(latLng, 16);
        marker.openPopup();
        document.getElementById('map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
  } else {
    showToast("Aguardando carregamento das coordenadas no mapa...");
  }
}
function focusFlexOnMap(numeroOrEcom) {
  const marker = findFlexMarkerByKey(numeroOrEcom);
  if (marker) {
    switchTab('envios_flex');
    setTimeout(() => { // Aguarda a aba ser trocada antes de centralizar
        const latLng = marker.getLatLng();
        mapFlex.setView(latLng, 16);
        marker.openPopup();
        document.getElementById('map-flex')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 350);
  } else {
    showToast("Aguardando carregamento das coordenadas no mapa...");
  }
}

// UI small utils
function showLoading(on){ const el = document.getElementById('loadingOverlay'); if(el) el.style.display = on ? 'flex' : 'none'; }
function showToast(msg, ms=2500){ const t=document.getElementById('toast'); if(!t) return; t.innerText=msg; t.style.display='block'; setTimeout(()=>t.style.display='none', ms); }



// --- JSONP updates ---
function updateStatusJsonp(id, status, observacao = ''){
  showLoading(true);
  const url = `${API}?action=updateStatus&id=${id}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}`;
  jsonpFetch(url, function(){ showLoading(false); load(); });
}

function updateFlexStatusJsonp(id, status, observacao = '', cb){
  showLoading(true);
  const url = `${API_FLEX}?action=updateStatus&id=${encodeURIComponent(id)}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}`;
  jsonpFetch(url, function(err, resp){
    showLoading(false);
    if(typeof cb === 'function') cb(err, resp);
    load();
  });
}

function updateAlarmTimeJsonp(id, timeValue) {
  if (!timeValue) return;
  showLoading(true);
  const url = `${API}?action=updateStatus&id=${id}&alarme=${encodeURIComponent(timeValue)}&operador=${encodeURIComponent(currentOperator)}`;
  jsonpFetch(url, function(){ showLoading(false); load(); });
}

function markFlexDelivered(id, numero){
  if(!id) return;
  if(!confirm(`Confirmar entrega do Flex ${numero || id} ?`)) return;
  const f = (flexOrders||[]).find(x => String(x.id || x.numero) === String(id));
  updateFlexStatusJsonp(id, 'Entregue', `Confirmado via painel por ${currentOperator}`, function(err, resp){
    if(f){
      const newOrder = { id: f.id || f.numero || (`flex-${Date.now()}`), numero: f.numero || f.id || '', cliente_nome: f.destinatario || f.cliente || f.nome || '', endereco_completo: f.endereco_completo || '', tempo_separacao: '—', status_logistica: 'Entregue' };
      flexOrders = (flexOrders || []).filter(x => String(x.id || x.numero) !== String(id));
      orders = orders || [];
      orders.push(newOrder);
      scheduleRender();
      switchTab('entregues');
      showToast(`Flex ${numero || id} marcado como entregue.`);
    } else {
      load();
      showToast(`Atualizando — verifique se Flex ${numero || id} foi registrado.`);
    }
  });
}

function switchTab(which){
  document.getElementById('view-separacao')?.classList.toggle('hidden', which !== 'separacao');
  document.getElementById('view-separados_hoje')?.classList.toggle('hidden', which !== 'separados_hoje');
  document.getElementById('view-logistica')?.classList.toggle('hidden', which !== 'logistica');
  document.getElementById('view-envios_flex')?.classList.toggle('hidden', which !== 'envios_flex');
  document.getElementById('view-rotas')?.classList.toggle('hidden', which !== 'rotas');
  document.getElementById('view-entregues')?.classList.toggle('hidden', which !== 'entregues');
  document.getElementById('view-motorista')?.classList.toggle('hidden', which !== 'motorista');
  
  if(document.getElementById('main-sep')) document.getElementById('main-sep').className = which === 'separacao' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-sephoje')) document.getElementById('main-sephoje').className = which === 'separados_hoje' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-log')) document.getElementById('main-log').className = which === 'logistica' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-flex')) document.getElementById('main-flex').className = which === 'envios_flex' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-rotas')) document.getElementById('main-rotas').className = which === 'rotas' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-ent')) document.getElementById('main-ent').className = which === 'entregues' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-mot')) document.getElementById('main-mot').className = which === 'motorista' ? 'tab-btn active' : 'tab-btn';
  
  if(which === 'logistica') {
    setTimeout(() => {
      try {
        if (map) map.invalidateSize();
        const b = markerCluster && markerCluster.getBounds && markerCluster.getBounds();
        if(b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 14, animate: false });
      } catch(e){}
    }, 250);
  }
  if(which === 'envios_flex') { 
    setTimeout(() => {
      try { 
        if (mapFlex) mapFlex.invalidateSize(); 
        if(markerClusterFlex && markerClusterFlex.getLayers && markerClusterFlex.getLayers().length > 0){
          const b = markerClusterFlex.getBounds();
          if(b && b.isValid && b.isValid()) {
            if(b.getSouthWest().equals(b.getNorthEast())) mapFlex.setView(b.getSouthWest(), 14);
            else mapFlex.fitBounds(b.pad(0.12), { maxZoom: 14, animate: false });
          }
        }
      } catch(e){}
    }, 300);
  }
  if(which === 'rotas') {
    setTimeout(() => {
       try { if (typeof plotRotasMap === 'function') plotRotasMap(); } catch(e){}
       try { if (typeof renderRotas === 'function') renderRotas(); } catch(e){}
    }, 300);
  }
  if(which === 'motorista') {
    // Dá 200ms para a tela renderizar antes de calcular o tamanho do quadro de assinatura
    setTimeout(() => {
      if(typeof resizeCanvas === 'function') resizeCanvas();
    }, 200);
  }
}

function switchSubTab(name){
  document.getElementById('subview-fila').classList.toggle('hidden', name !== 'fila');
  document.getElementById('subview-pendencias').classList.toggle('hidden', name !== 'pendencias');
  document.getElementById('sub-fila').className = name==='fila' ? 'bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 transition-all';
  document.getElementById('sub-pend').className = name==='pendencias' ? 'bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 transition-all';
}

function checkOperator() { if (!currentOperator) { const modal = document.getElementById('operatorModal'); if(modal) modal.classList.remove('hidden'); } else { const el = document.getElementById('activeOperatorDisplay'); if(el) el.innerText = `Op: ${currentOperator}`; } }
function saveOperator() { const name = (document.getElementById('operatorNameInput')?.value || '').trim(); if(name) { localStorage.setItem('vesco_operator', name); currentOperator = name; const modal = document.getElementById('operatorModal'); if(modal) modal.classList.add('hidden'); const el = document.getElementById('activeOperatorDisplay'); if(el) el.innerText = `Op: ${currentOperator}`; } }

// --- Eventos da tabela foram removidos, usamos os botões Crosshair e Onclick da Row ---
document.addEventListener('DOMContentLoaded', function(){
  (function ensureFlexScrollableInit(){
    const flexCard = document.querySelector('#view-envios_flex .card');
    if(flexCard){
      const offset = 240;
      flexCard.style.maxHeight = (window.innerHeight - offset) + 'px';
      flexCard.style.overflowY = 'auto';
      flexCard.style.overflowX = 'auto';
    }
  })();
});

// --- Inicialização principal (bootstrap) ---
document.addEventListener('DOMContentLoaded', function() {
  try {
    setTodayDate();
    initMap();
    let attempts = 0;
    const tryInit = setInterval(()=>{ attempts++; if(window._vesco_map_inited) { clearInterval(tryInit); return; } initMap(); if(attempts>6) clearInterval(tryInit); }, 500);

    checkOperator();
    load();

    setInterval(load, 60000);
    setInterval(()=> {
      const horaBrasiliaStr = new Date().toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo'});
      const clockEl = document.getElementById('clock');
      if (clockEl) clockEl.innerText = horaBrasiliaStr;
      if (typeof window.checkTimeAlarms === 'function') window.checkTimeAlarms(horaBrasiliaStr);
    }, 1000);
  } catch(e) {
    console.warn('Erro na inicialização principal', e);
  }
});

function setTodayDate() {
  const dBr = new Date();
  const offset = dBr.getTimezoneOffset();
  const topCalendar = document.getElementById('topCalendar');
  if (topCalendar) {
    topCalendar.value = new Date(dBr.getTime() - (offset*60*1000)).toISOString().split('T')[0];
  }
}
// =================================================================
// 1. SISTEMA DE NOTIFICAÇÕES E RASTREIO DE OPERADOR
// =================================================================

// Função melhorada de Toast para mostrar Nome do Operador e Hora
function showToast(msg, type = 'info', ms = 4000) {
  const t = document.getElementById('toast');
  if(!t) return;
  
  // Cores dinâmicas
  let bg = 'bg-slate-800';
  if(type === 'success') bg = 'bg-emerald-600';
  if(type === 'warning') bg = 'bg-amber-500';
  if(type === 'error') bg = 'bg-red-600';

  t.className = `toast fixed top-4 right-4 ${bg} text-white px-5 py-3 rounded-xl shadow-2xl font-bold text-sm flex items-center gap-3 z-[9999] transition-all transform translate-y-0 opacity-100`;
  t.innerHTML = `<i class="fas fa-bell"></i> <div>${msg}</div>`;
  t.style.display = 'flex';
  
  setTimeout(() => {
    t.classList.add('opacity-0', '-translate-y-5');
    setTimeout(() => t.style.display = 'none', 300);
  }, ms);
}

// Atualizamos a função de enviar o status para gerar a notificação na tela
function updateStatusJsonp(id, status, observacao = ''){
  showLoading(true);
  const horaLocal = new Date().toLocaleTimeString('pt-BR', {timeZone: 'America/Sao_Paulo'}).slice(0,5);
  
  const url = `${API}?action=updateStatus&id=${id}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}`;
  
  jsonpFetch(url, function(){ 
    showLoading(false); 
    // Dispara a notificação de auditoria
    showToast(`<span class="text-blue-200">${currentOperator}</span> alterou o pedido #${id}<br><span class="text-xs font-normal">Para: <b>${status}</b> às ${horaLocal}</span>`, 'info', 5000);
    load(); 
  });
}

// =================================================================
// 2. RELATÓRIO DE PENDÊNCIAS
// =================================================================

window.moverParaPendenciaPrompt = (id) => {
  document.getElementById('pendenciaId').value = id;
  document.getElementById('pendenciaPedidoDisplay').innerText = `Pedido #${id}`;
  document.getElementById('pendenciaDetalhes').value = '';
  document.getElementById('pendenciaModal').classList.remove('hidden');
};

window.fecharPendenciaModal = () => {
  document.getElementById('pendenciaModal').classList.add('hidden');
};

window.salvarPendenciaModal = () => {
  const id = document.getElementById('pendenciaId').value;
  const motivo = document.getElementById('pendenciaMotivo').value;
  const detalhes = document.getElementById('pendenciaDetalhes').value;
  
  if(detalhes.trim() === '') return alert("Por favor, especifique os detalhes/produtos faltantes.");
  
  const observacaoFinal = `[${motivo}] ${detalhes}`;
  fecharPendenciaModal();
  updateStatusJsonp(id, 'Pendente', observacaoFinal);
};

// =================================================================
// 3. O MOTOR DO ALARME SONORO E POP-UP
// =================================================================

// Esta função já estava no seu app.js, agora ela ganha vida!
window.checkTimeAlarms = (horaAtualStr) => {
  // Pega só o HH:MM para comparar com o input type="time"
  const horaMinutoAtual = horaAtualStr.slice(0, 5); 
  
  (orders || []).forEach(o => {
    // Se o pedido tem alarme, a hora bateu, e ainda não tocou hoje
    if (o.alarme && o.alarme === horaMinutoAtual && !o.alarmeTocado) {
      o.alarmeTocado = true; // Marca para não ficar apitando a cada segundo
      
      // Toca o som (garanta que a função playBeepSound exista no seu código)
      if(typeof playBeepSound === 'function') playBeepSound();
      
      // Mostra a tela de estouro piscando na cara do operador
      const modal = document.getElementById('snoozeModal');
      const numDisplay = document.getElementById('modalOrderNum');
      if (modal && numDisplay) {
        numDisplay.innerText = `#${o.numero || o.id}`;
        modal.classList.remove('hidden');
      }
    }
  });
};

// Se você não tinha o botão fechar do Snooze implementado:
document.getElementById('btnSnoozeAction')?.addEventListener('click', function() {
  document.getElementById('snoozeModal').classList.add('hidden');
  stopAudioAlarm();
});

// =================================================================
// 4. ASSINATURA DIGITAL (APP MOTORISTA)
// =================================================================

// Garante que a aba abra corretamente
const originalSwitchTab = switchTab;
window.switchTab = function(which) {
  originalSwitchTab(which); // Roda sua função antiga
  
  const viewMot = document.getElementById('view-motorista');
  if(viewMot) viewMot.classList.toggle('hidden', which !== 'motorista');
  
  const btnMot = document.getElementById('main-mot');
  if(btnMot) btnMot.className = which === 'motorista' ? 'tab-btn active' : 'tab-btn';
  
  if(which === 'motorista') resizeCanvas(); // Ajusta a resolução do desenho no celular
};

// Lógica de desenho com o dedo na tela
let canvas, ctx, desenhando = false;

document.addEventListener("DOMContentLoaded", () => {
  canvas = document.getElementById('signatureCanvas');
  if(!canvas) return;
  ctx = canvas.getContext('2d');
  
  // Eventos de Mouse e Touch (Dedo no celular)
  canvas.addEventListener('mousedown', startPosition);
  canvas.addEventListener('mouseup', endPosition);
  canvas.addEventListener('mousemove', draw);
  canvas.addEventListener('touchstart', startPosition, {passive: true});
  canvas.addEventListener('touchend', endPosition);
  canvas.addEventListener('touchmove', draw, {passive: false});
});

function resizeCanvas() {
  if(!canvas) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#1e293b'; // Cor da caneta azul escuro
}

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const ev = e.touches ? e.touches[0] : e;
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

function startPosition(e) { desenhando = true; draw(e); }
function endPosition() { desenhando = false; ctx.beginPath(); }
function draw(e) {
  if (!desenhando) return;
  e.preventDefault(); // Impede a tela de rolar enquanto assina
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
}

window.limparAssinatura = () => {
  if(ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
  }
};

window.enviarComprovante = () => {
  const pedido = document.getElementById('motPedidoInput').value.trim();
  const recebedor = document.getElementById('motRecebedor').value.trim();
  const transportador = document.getElementById('motTransportador').value;
  
  if(!pedido || !recebedor) return alert("Preencha o Número do Pedido e o Nome de quem recebeu.");
  
  // Transforma o desenho em um texto gigante (Base64) que pode ser salvo na planilha
  const assinaturaBase64 = canvas.toDataURL('image/png');
  
  // Aqui você chama a sua função de atualização do Google Sheets, 
  // enviando a assinatura e os dados. Por hora, vamos mudar o status do pedido!
  const msgAudit = `Entregue via: ${transportador} | Recebido por: ${recebedor}`;
  
  showLoading(true);
  const horaLocal = new Date().toLocaleTimeString('pt-BR').slice(0,5);
  
  // Reutiliza a URL existente, mas marca como entregue e anota quem recebeu
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(pedido)}&status=Entregue&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(msgAudit)}`;
  
  jsonpFetch(url, function(){ 
    showLoading(false); 
    showToast(`Comprovante do pedido #${pedido} salvo com sucesso!`, 'success', 5000);
    limparAssinatura();
    document.getElementById('motPedidoInput').value = '';
    document.getElementById('motRecebedor').value = '';
    load(); 
  });
};
// =================================================================
// 5. LÓGICA DE PRODUÇÃO DO MOTORISTA (DESPACHO E ENTREGAS)
// =================================================================

window.renderMotorista = () => {
  const tbodyMot = document.getElementById('table-motorista');
  if (!tbodyMot) return;

  // Mistura os pedidos normais e Flex para o motorista não perder nenhuma entrega
  const todosPedidos = [...(typeof orders !== 'undefined' ? orders : []), ...(typeof flexOrders !== 'undefined' ? flexOrders : [])];
  
  const emRota = todosPedidos.filter(o => String(o.status_logistica || o.situacao_nome || '').toLowerCase() === 'despachado');

  if (emRota.length === 0) {
    tbodyMot.innerHTML = `<tr><td colspan="3" class="p-8 text-center text-slate-400 font-bold"><i class="fas fa-box-open text-3xl mb-2 block"></i>Nenhuma entrega em rota no momento.</td></tr>`;
    return;
  }

  tbodyMot.innerHTML = emRota.map(o => `
    <tr class="hover:bg-slate-50 transition-colors border-b border-slate-100 last:border-0">
      <td class="p-3 font-black text-slate-800 text-sm">#${escapeHtml(o.numero || o.id)}</td>
      <td class="p-3 leading-tight">
        <span class="font-bold text-slate-700 text-sm">${escapeHtml(o.cliente_nome || o.destinatario || '')}</span><br>
        <span class="text-[11px] text-slate-400 font-normal"><i class="fas fa-location-dot text-slate-300 mr-1"></i>${escapeHtml(o.endereco_completo || o.endereco || '')}</span>
      </td>
      <td class="p-3 text-right">
        <button onclick="abrirAssinaturaMotorista('${escapeHtml(o.numero || o.id)}')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold text-[11px] shadow-sm transition-all uppercase whitespace-nowrap"><i class="fas fa-signature mr-1"></i> Entregar</button>
      </td>
    </tr>
  `).join('');
};
window.prepararDespachoMotorista = (numeroPedido) => {
  // 1. Truque Visual: Altera TODAS as flags para forçar o pedido a sumir da Logística
  let achou = false;
  if (typeof orders !== 'undefined') {
    const p = orders.find(o => String(o.numero) === String(numeroPedido) || String(o.id) === String(numeroPedido));
    if (p) { 
        p.status_logistica = 'Despachado'; 
        p.situacao_nome = 'Despachado'; // <-- Essa linha faz sumir da Logística!
        achou = true; 
    }
  }
  if (!achou && typeof flexOrders !== 'undefined') {
    const p = flexOrders.find(o => String(o.numero) === String(numeroPedido) || String(o.id) === String(numeroPedido));
    if (p) { 
        p.status_logistica = 'Despachado'; 
        p.situacao_nome = 'Despachado'; 
    }
  }

  // 2. Transição visual instantânea
  showToast(`Pedido #${numeroPedido} Despachado com sucesso!`, 'success', 4000);
  switchTab('motorista');
  
  if (typeof renderMotorista === 'function') renderMotorista();
  if (typeof render === 'function') render(); 
  
  // 3. Salva no Banco de Dados Fantasma
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(numeroPedido)}&status=Despachado&operador=${encodeURIComponent(currentOperator)}&observacao=Saiu%20para%20entrega`;
  jsonpFetch(url, function() {
    console.log("Despacho salvo no Google Sheets.");
  });
};

window.enviarComprovante = () => {
  const pedidoId = document.getElementById('motPedidoInput').value.trim();
  const recebedor = document.getElementById('motRecebedor').value.trim();
  const transportador = document.getElementById('motTransportador').value;
  
  if(!pedidoId || !recebedor) return alert("Por favor, preencha o Nome de quem recebeu a mercadoria.");
  
  // 1. Truque visual imediato para mover para 'Entregues'
  if (typeof orders !== 'undefined') {
    const pedidoObj = orders.find(o => String(o.numero || o.id) === String(pedidoId));
    if (pedidoObj) {
        pedidoObj.status_logistica = 'Entregue';
        pedidoObj.situacao_nome = 'Entregue'; // <-- Faz o pedido ir para a aba final
    }
  }
  if (typeof flexOrders !== 'undefined') {
    const pedidoObjFlex = flexOrders.find(o => String(o.numero || o.id) === String(pedidoId));
    if (pedidoObjFlex) {
        pedidoObjFlex.status_logistica = 'Entregue';
        pedidoObjFlex.situacao_nome = 'Entregue';
    }
  }
  
  showToast(`Entrega #${pedidoId} finalizada com sucesso!`, 'success', 5000);
  
  // 2. Esconde o painel de assinatura
  const form = document.getElementById('form-assinatura-motorista');
  if (form) form.classList.add('hidden');
  if (typeof limparAssinatura === 'function') limparAssinatura();
  
  // 3. Atualiza as telas
  if (typeof renderMotorista === 'function') renderMotorista();
  if (typeof render === 'function') render();
  
  // 4. Salvamento Fantasma da Assinatura no Google Sheets
  const msgAudit = `Entregue via: ${transportador} | Assinado por: ${recebedor}`;
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(pedidoId)}&status=Entregue&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(msgAudit)}`;
  
  jsonpFetch(url, function(){ 
     console.log("Comprovante salvo no Google Sheets.");
  });
};
window.abrirAssinaturaMotorista = (numeroPedido) => {
  const form = document.getElementById('form-assinatura-motorista');
  if (form) form.classList.remove('hidden'); // Revela o quadro de assinatura
  
  const inputPedido = document.getElementById('motPedidoInput');
  if (inputPedido) inputPedido.value = numeroPedido; // Trava o número do pedido

  const inputRecebedor = document.getElementById('motRecebedor');
  if (inputRecebedor) {
    inputRecebedor.value = ''; // Limpa o nome antigo
    inputRecebedor.focus();
  }

  if (typeof limparAssinatura === 'function') limparAssinatura();
  if (typeof resizeCanvas === 'function') resizeCanvas();
  
  // Desce a tela suavemente até a assinatura
  if (form) form.scrollIntoView({ behavior: 'smooth', block: 'end' });
};
// =================================================================
// 6. MOTOR DE ASSINATURA DIGITAL (TOUCH CELULAR E MOUSE)
// =================================================================
let canvas, ctx, desenhando = false;

// Inicializa a prancheta de desenho com um pequeno atraso para garantir que a tela carregou
setTimeout(() => {
  canvas = document.getElementById('signatureCanvas');
  if(canvas) {
    ctx = canvas.getContext('2d');
    
    // Suporte para Mouse (Testes no PC)
    canvas.addEventListener('mousedown', startPosition);
    canvas.addEventListener('mouseup', endPosition);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseleave', endPosition);
    
    // Suporte para Dedo (Celular/Tablet) - O 'passive: false' impede a tela de rolar
    canvas.addEventListener('touchstart', startPosition, {passive: false});
    canvas.addEventListener('touchend', endPosition, {passive: false});
    canvas.addEventListener('touchmove', draw, {passive: false});
  }
}, 1000);

// Ajusta a resolução da prancheta na hora que o motorista abre a aba
window.resizeCanvas = () => {
  if(!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = rect.height;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#2563eb'; // Cor da tinta: Azul Escuro
};

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  // Identifica se é dedo (touches) ou mouse (clientX)
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function startPosition(e) { 
  if (e.cancelable) e.preventDefault(); // Trava a tela para não rolar
  desenhando = true; 
  draw(e); 
}

function endPosition() { 
  desenhando = false; 
  if(ctx) ctx.beginPath(); 
}

function draw(e) {
  if (!desenhando || !ctx) return;
  if (e.cancelable) e.preventDefault(); // Trava a tela enquanto rabisca
  
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
}

window.limparAssinatura = () => {
  if(ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
  }
};
