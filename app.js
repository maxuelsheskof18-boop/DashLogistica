// app.js — Versão Definitiva: Visual Original Restaurado + Motorista + Rotas

// --- Motor de Áudio (Bipe) ---
window.playBeepSound = () => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctxAudio = new AudioContext();
        const osc = ctxAudio.createOscillator();
        const gain = ctxAudio.createGain();

        osc.type = 'square';
        osc.frequency.setValueAtTime(880, ctxAudio.currentTime);
        gain.gain.setValueAtTime(0.1, ctxAudio.currentTime);

        osc.connect(gain);
        gain.connect(ctxAudio.destination);
        osc.start();
        osc.stop(ctxAudio.currentTime + 0.15);
    } catch(e) { console.warn("Áudio bloqueado pelo navegador."); }
};

window.stopAudioAlarm = () => {
    const modal = document.getElementById('snoozeModal');
    if (modal) modal.classList.add('hidden');
};
window.checkTimeAlarms = window.checkTimeAlarms || function() {};

// --- Endpoints ---
const API = "https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec";
const API_FLEX = "https://script.google.com/macros/s/AKfycbzDp2qs2S_MxDc_3afY1TurNKYEwfYKkk2cc4IliNxLiVaJuSKYyRqofOUMnhdFBjwNwg/exec";

// --- Estado global ---
let orders = [];
let flexOrders = [];
let currentOperator = localStorage.getItem('vesco_operator') || '';
let map, mapFlex, mapRotas, markerCluster, markerClusterFlex, markerClusterRotas;
let renderTimer = null;
let geocodeCache = {};
let geocodeQueue = [];
let geocodeProcessing = false;
let currentMapRenderToken = 0;
const GEOCODE_DELAY_MS = 1100;

// Estado do Roteirizador
let routeSelection = new Set();
let routeEligible = [];

const DEBUG_DATES = (new URLSearchParams(window.location.search)).get('debug_dates') === '1';

// --- Helpers básicos ---
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 60);
}
function escapeHtml(text) {
  if (text == null) return '';
  return String(text).replace(/[&<>"']/g, function(m) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[m];
  });
}
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
// DATA E EXTRAÇÃO
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
  const regexes = [ /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/, /(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/, /(\d{10,13})/ ];
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
    const preferredKeys = ['data_prevista','data','data_previsao','data_previsão','previsao','dataentrega','deliverydate','expecteddate','dateexpected','eta','scheduled','scheduledat','data_prev'];
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
  if(DEBUG_DATES) { try { console.info('DATE_EXTRACT DEBUG', { input, result }); } catch(e){} }
  return result;
}

// -------------------------
// Geocoding
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
    const q = encodeURIComponent(address + ', Brasil');
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&addressdetails=1&accept-language=pt-BR`;
    fetch(url, { method: 'GET' })
      .then(r => r.json())
      .then(js => {
        if(Array.isArray(js) && js.length > 0){
          const p = js[0];
          const res = { lat: parseFloat(p.lat), lon: parseFloat(p.lon), display_name: p.display_name || address, raw: p };
          geocodeCache[key] = res;
          item.resolve(res);
        } else {
          geocodeCache[key] = null;
          item.resolve(null);
        }
      }).catch(err => {
        console.warn('geocode error', err);
        geocodeCache[key] = null;
        item.resolve(null);
      }).finally(() => setTimeout(next, GEOCODE_DELAY_MS));
  };
  next();
}
function tryGeocodeIfNeeded(item, onResolved){
  const coords = getCoords(item);
  if(coords){ if(typeof onResolved === 'function') onResolved(coords); return; }
  const addr = (item.endereco_completo || item.endereco || item.address || item.full_address || '').trim();
  if(!addr) { if(typeof onResolved === 'function') onResolved(null); return; }
  const cacheKey = normalizeAddressKey(addr);
  if(geocodeCache.hasOwnProperty(cacheKey)) {
    const c = geocodeCache[cacheKey];
    if(c) { if(typeof onResolved === 'function') onResolved({lat: c.lat, lon: c.lon}); else onResolved(null); }
    else { if(typeof onResolved === 'function') onResolved(null); }
    return;
  }
  geocodeAddress(addr).then(res => {
    if(res) { if(typeof onResolved === 'function') onResolved({ lat: res.lat, lon: res.lon }); } else { if(typeof onResolved === 'function') onResolved(null); }
  });
}

// -------------------------
// Ícone, jsonp, util
// -------------------------
function createPinSVG(color='#eab308', size=28){
  const inner = Math.max(8, Math.round(size * 0.35));
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6z" fill="${color}" stroke="#ffff" stroke-width="1.2"/><circle cx="12" cy="8" r="${inner/4}" fill="#fff" /></svg>`;
}
function jsonpFetch(url, cb) {
  const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
  const script = document.createElement('script');
  const timeout = setTimeout(() => { try { delete window[cbName]; } catch(e){} if (script.parentNode) script.remove(); cb(new Error("Timeout"), null); }, 15000);
  window[cbName] = function(res) { clearTimeout(timeout); try { cb(null, res); } catch(e){} try { delete window[cbName]; } catch(e){} if (script.parentNode) script.remove(); };
  script.src = `${url}${url.indexOf('?') === -1 ? '?' : '&'}callback=${cbName}`;
  document.head.appendChild(script);
}
function jsonpFetchPromise(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
    const script = document.createElement('script');
    let timer = null;
    function cleanup() { if (timer) clearTimeout(timer); try { delete window[cbName]; } catch(e){} if (script.parentNode) script.remove(); }
    window[cbName] = function(res){ cleanup(); resolve({ jsonp: true, resp: res }); };
    script.onerror = function(ev){ cleanup(); reject(new Error('JSONP script error')); };
    timer = setTimeout(() => { cleanup(); reject(new Error('JSONP timeout')); }, timeoutMs);
    script.src = `${url}${url.indexOf('?') === -1 ? '?' : '&'}callback=${cbName}`;
    document.head.appendChild(script);
  });
}
function findArrayInObject(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return obj;
  if (typeof obj !== 'object') return null;
  for (const k in obj) { if (!Object.prototype.hasOwnProperty.call(obj, k)) continue; const v = obj[k]; if (Array.isArray(v)) return v; }
  for (const k in obj) { if (!Object.prototype.hasOwnProperty.call(obj, k)) continue; const v = obj[k]; if (v && typeof v === 'object') { for (const k2 in v) { if (!Object.prototype.hasOwnProperty.call(v, k2)) continue; if (Array.isArray(v[k2])) return v[k2]; } } }
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
  const keys = ['cliente_nome','cliente','destinatario','destinatário','nome','receiver','recipient','customer_name','customer','client'];
  for (const k of keys) { if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') { return String(obj[k]).trim(); } }
  return '';
}
function extractEcomNumberFromAny(obj) {
  if (!obj) return '';
  const keys = ['numero_ecommerce','numero_ecom','ecom','ecom_id','order_reference','order_ref','reference','referencia','orderNumber'];
  for (const k of keys) { if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') { return normalizeEcomNumber(obj[k]); } }
  return '';
}
function extractStoreNameFromAny(obj) {
  if (!obj) return '';
  const keys = ['conta','loja','store','store_name','nome_loja','account','seller','shop','marketplace','merchant'];
  for (const k of keys) { if (k in obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') { return String(obj[k]).trim(); } }
  return '';
}

function getEcomNum(item){
  if(!item) return '';
  const candidates = [item.numero_ecommerce, item.numero_ecom, item.ecom_num, item.id_ecom, item.referencia, item.reference, item.codigo_externo];
  for(const c of candidates){ if(c !== undefined && c !== null && String(c).trim() !== '') { const normalized = normalizeEcomNumber(c); if(normalized) return normalized; } }
  const fallback = item.numero || item.id || item.pedido || '';
  return normalizeEcomNumber(fallback) || '';
}

function normalizeOrderObject(item) {
  const obj = Object.assign({}, item);
  obj.numero = obj.numero || obj.id || obj.pedido || obj.order_id || obj.orderNumber || obj.reference || obj.referencia || '';
  obj.numero = String(obj.numero || '').trim();
  obj.cliente_nome = String(obj.cliente_nome || obj.cliente || obj.destinatario || obj.nome || '').trim();
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
// Carregamento dos dados
// -------------------------
function load(){
  // ERP
  jsonpFetch(API, function(err, resp){
    if (resp && resp.success) {
      let dadosErp = (resp.data || []).filter(o => (o.numero || o.id || o.pedido));
      orders = dadosErp.map(normalizeOrderObject);
      scheduleRender();
    } else if (Array.isArray(resp)) {
      orders = (resp || []).map(normalizeOrderObject);
      scheduleRender();
    } else { orders = []; scheduleRender(); }
  });

  // FLEX
  (function fetchFlexRobust(){
    const urlBase = `${API_FLEX}?action=separacoesIndex`;
    jsonpFetchPromise(urlBase, 15000).then(result => {
      processFlexResponse(result.resp);
    }).catch(jsonpErr => {
      fetch(urlBase, { cache: 'no-store' }).then(r => r.text()).then(txt => {
        try {
          const parsed = JSON.parse(txt);
          processFlexResponse(parsed);
        } catch(e) {
          const m = txt.match(/^[^(]*\(([\s\S]*)\)\s*;?\s*$/);
          if (m && m[1]) { try { const parsed2 = JSON.parse(m[1]); processFlexResponse(parsed2); return; } catch(e2){} }
          try { const maybe = JSON.parse(txt.replace(/\n/g,'')); processFlexResponse(maybe); return; } catch(e3){}
          flexOrders = []; scheduleRender();
        }
      }).catch(fetchErr => { flexOrders = []; scheduleRender(); });
    });

    function processFlexResponse(resp){
      let dadosBrutos = findArrayInObject(resp) || (Array.isArray(resp) ? resp : null);
      if(!dadosBrutos) dadosBrutos = [];
      if (Array.isArray(dadosBrutos) && dadosBrutos.length > 0 && Array.isArray(dadosBrutos[0])) {
        const headerRow = dadosBrutos[0].map(h => String(h || '').trim());
        const dataRows = dadosBrutos.slice(1);
        dadosBrutos = dataRows.map(row => {
          const obj = {};
          for (let i = 0; i < headerRow.length; i++) { obj[headerRow[i] || `col${i}`] = row[i]; }
          return obj;
        });
      }
      const normalized = dadosBrutos.map(raw => {
        const f = Object.assign({}, raw);
        f.numero = String(f.numero || f.id || f.pedido || f.order_id || '').trim();
        f.cliente_nome = extractClientNameFromAny(f) || f.destinatario || f.cliente || f.nome || '';
        f.data_prevista = extractDateDefinitiveWithDebug(f);
        f.numero_ecommerce = extractEcomNumberFromAny(f) || normalizeEcomNumber(f.numero_ecommerce || f.referencia || f.reference || f.id || '');
        f.store_name = extractStoreNameFromAny(f) || f.loja || f.store || '';
        f.endereco_completo = f.endereco_completo || f.endereco || f.address || '';
        f.lat = f.lat || f.latitude || '';
        f.lon = f.lon || f.longitude || '';
        f.situacao_nome = f.situacao_nome || f.status || f.situacao || '';
        f.id = f.id || f.numero || f.pedido || '';
        return f;
      });
      flexOrders = normalized;
      scheduleRender();
    }
  })();
}

// -------------------------
// Plotagem de marcadores
// -------------------------
window.activeMainMarkers = {};
window.activeFlexMarkers = {};
let flexBoundsTimer = null;
let mainBoundsTimer = null;

function plotMapMarkers(orderList, flexList){
  if(!markerCluster || !markerClusterFlex) return;

  currentMapRenderToken++;
  const myToken = currentMapRenderToken;

  markerCluster.clearLayers();
  markerClusterFlex.clearLayers();

  window.activeMainMarkers = {};
  window.activeFlexMarkers = {};

  function debouncedFitBoundsMain() {
    clearTimeout(mainBoundsTimer);
    mainBoundsTimer = setTimeout(() => {
        if(myToken !== currentMapRenderToken) return;
        try { if (markerCluster.getLayers().length > 0) { const b = markerCluster.getBounds(); if(b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 14 }); } } catch(e){}
    }, 600);
  }

  function debouncedFitBoundsFlex() {
    clearTimeout(flexBoundsTimer);
    flexBoundsTimer = setTimeout(() => {
        if(myToken !== currentMapRenderToken) return;
        try { if (markerClusterFlex.getLayers().length > 0) { const b = markerClusterFlex.getBounds(); if(b && b.isValid && b.isValid()) mapFlex.fitBounds(b.pad(0.12), { maxZoom: 14 }); } } catch(e){}
    }, 600);
  }

  function addMainMarker(item, lat, lon){
    if (myToken !== currentMapRenderToken) return; 
    const ecomNum = (item.numero_ecommerce || getEcomNum(item) || '').toString();
    const normNum = normalizeOrderNumber(item.numero || item.id || item.pedido || '');
    if (window.activeMainMarkers[normNum]) return; 

    const popupHtml = `<div class='p-1 font-sans'><b class='text-blue-600 text-sm'>Pedido #${escapeHtml(String(item.numero || ''))}</b><br><small class='text-xs text-slate-600 font-medium'>${escapeHtml(String(item.endereco_completo || ''))}</small><br><div class='text-[13px] text-slate-800 font-semibold mt-1'>${escapeHtml(String(item.cliente_nome || ''))}</div><div class='text-xs text-slate-500 mt-1'>Data Prevista: <b>${escapeHtml(String(item.data_prevista || '—'))}</b></div></div>`;
    const icon = L.divIcon({ html: createPinSVG('#004f9f', 30), className: '', iconSize: [30,30], iconAnchor: [15,30] });
    const m = L.marker([lat, lon], { icon }).bindPopup(popupHtml);
    
    markerCluster.addLayer(m);
    try { if(normNum) window.activeMainMarkers[normNum] = m; if(ecomNum) window.activeMainMarkers[ecomNum] = m; window.activeMainMarkers[String(item.numero || item.id || '')] = m; } catch(e){}
    debouncedFitBoundsMain();
  }

  function addFlexMarker(item, lat, lon){
    if (myToken !== currentMapRenderToken) return; 
    const ecomNum = (item.numero_ecommerce || '').toString();
    const normNum = normalizeOrderNumber(item.numero || item.id || '');
    if (window.activeFlexMarkers[normNum]) return; 

    const popupHtml = `<div class='p-1 font-sans'><b class='text-amber-500 text-sm'>Flex #${escapeHtml(String(item.numero || item.id || ''))}</b><br><small class='text-xs text-slate-600 font-medium'>${escapeHtml(String(item.endereco_completo || ''))}</small><br><div class='text-[13px] text-slate-800 font-semibold mt-1'>${escapeHtml(String(item.cliente_nome || ''))}</div><div class='text-xs text-slate-500 mt-1'>Data Prevista: <b>${escapeHtml(String(item.data_prevista || '—'))}</b></div><div class='text-xs text-slate-400 mt-1'>Loja: ${escapeHtml(item.store_name || '—')}</div></div>`;
    const iconFlex = L.divIcon({ html: createPinSVG('#eab308', 30), className: '', iconSize: [30,30], iconAnchor: [15,30] });
    
    const mFlex = L.marker([lat, lon], { icon: iconFlex }).bindPopup(popupHtml);
    markerClusterFlex.addLayer(mFlex);

    const mFlexForMain = L.marker([lat, lon], { icon: iconFlex }).bindPopup(popupHtml);
    markerCluster.addLayer(mFlexForMain);
    
    try { if(normNum) window.activeFlexMarkers[normNum] = mFlex; if(ecomNum) window.activeFlexMarkers[ecomNum] = mFlex; window.activeFlexMarkers[String(item.numero || item.id || '')] = mFlex; } catch(e){}
    debouncedFitBoundsFlex();
    debouncedFitBoundsMain(); 
  }

  for(const item of (orderList||[])){
    const coords = getCoords(item);
    if(coords) addMainMarker(item, coords.lat, coords.lon);
    else tryGeocodeIfNeeded(item, (c) => { if(c) addMainMarker(item, c.lat, c.lon); });
  }

  for(const item of (flexList||[])){
    const coords = getCoords(item);
    if(coords) addFlexMarker(item, coords.lat, coords.lon);
    else tryGeocodeIfNeeded(item, (c) => { if(c) addFlexMarker(item, c.lat, c.lon); });
  }
}

// -------------------------
// ROTEIRIZADOR (MONTAR ROTAS)
// -------------------------
function renderRotas() {
  routeEligible = [];
  const pushEligible = (o, type) => {
     const st = String(o.status_logistica || o.situacao_nome || o.status || '').toLowerCase();
     if(st !== 'entregue' && st !== 'despachado' && String(o.numero || '').trim() !== '') {
         o._routeType = type;
         routeEligible.push(o);
     }
  };
  
  orders.forEach(o => pushEligible(o, 'ERP'));
  flexOrders.forEach(o => pushEligible(o, 'FLEX'));

  const tbodyRotas = document.getElementById('table-rotas');
  if(tbodyRotas) {
     if(routeEligible.length === 0) {
        tbodyRotas.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido disponível para rota.</td></tr>`;
     } else {
        tbodyRotas.innerHTML = routeEligible.map((o) => {
           const id = escapeHtml(String(o.id || o.numero));
           const ecom = escapeHtml(normalizeEcomNumber(getEcomNum(o)));
           const checked = routeSelection.has(id) ? 'checked' : '';
           const typeBadge = o._routeType === 'FLEX' 
              ? '<span class="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[10px] font-bold">FLEX</span>' 
              : '<span class="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-bold">ERP</span>';
           
           return `
             <tr class="hover:bg-slate-50 cursor-pointer ${checked ? 'bg-purple-50' : ''} transition-colors" onclick="toggleRouteOrder('${id}')">
                <td class="p-2.5 text-center" onclick="event.stopPropagation()">
                   <input type="checkbox" class="w-4 h-4 accent-purple-600 rounded cursor-pointer" ${checked} onchange="toggleRouteOrder('${id}')">
                </td>
                <td class="p-2.5">
                   <div class="font-bold text-slate-800 text-xs">#${escapeHtml(o.numero)}</div>
                   <div class="text-[10px] text-slate-400 mt-0.5">${ecom || '—'}</div>
                </td>
                <td class="p-2.5">
                   <div class="font-bold text-slate-700 text-[11px]">${escapeHtml(o.cliente_nome)}</div>
                   <div class="text-[10px] text-slate-500 truncate max-w-[220px] mt-0.5" title="${escapeHtml(o.endereco_completo)}">${escapeHtml(o.endereco_completo)}</div>
                </td>
                <td class="p-2.5 text-right">
                   ${typeBadge}
                   <div class="mt-1 text-[9px] font-bold text-slate-400 uppercase">${escapeHtml(o.status_logistica || o.situacao_nome || o.situacao || 'A Separar')}</div>
                </td>
             </tr>
           `;
        }).join('');
     }
  }
  
  const countEl = document.getElementById('rota-count');
  if(countEl) countEl.innerText = routeSelection.size;
  plotRotasMap();
}

function plotRotasMap() {
  if(!markerClusterRotas) return;
  markerClusterRotas.clearLayers();
  routeEligible.forEach(item => {
      const coords = getCoords(item);
      if(coords) {
          const id = String(item.id || item.numero);
          const isSelected = routeSelection.has(id);
          const color = isSelected ? '#9333ea' : '#94a3b8';
          const svgHtml = createPinSVG(color, isSelected ? 34 : 26);
          const icon = L.divIcon({ html: svgHtml, className: '', iconSize: [isSelected?34:26, isSelected?34:26], iconAnchor: [isSelected?17:13, isSelected?34:26] });
          const m = L.marker([coords.lat, coords.lon], { icon }).bindPopup(`<div class='p-1 font-sans text-center'><b class='text-[13px] ${isSelected ? 'text-purple-600' : 'text-slate-600'}'>#${escapeHtml(item.numero)}</b><br><span class='text-xs text-slate-700 font-semibold'>${escapeHtml(item.cliente_nome)}</span></div>`);
          m.on('click', () => { toggleRouteOrder(id); });
          markerClusterRotas.addLayer(m);
      }
  });
  if(routeSelection.size > 0 && markerClusterRotas.getLayers().length > 0) {
      const bounds = L.featureGroup(markerClusterRotas.getLayers()).getBounds();
      if(bounds.isValid()) mapRotas.fitBounds(bounds.pad(0.1), { maxZoom: 15 });
  }
}

window.toggleRouteOrder = function(id) { if(routeSelection.has(id)) routeSelection.delete(id); else routeSelection.add(id); renderRotas(); };
window.selectAllRoute = function() { routeEligible.forEach(o => routeSelection.add(String(o.id || o.numero))); renderRotas(); };
window.clearRouteSelection = function() { routeSelection.clear(); renderRotas(); };

window.sugerirRotasInteligentes = function() {
    if (!routeEligible || routeEligible.length === 0) return alert('Não há pedidos disponíveis para roteirizar.');
    routeSelection.clear();
    let count = 0;
    routeEligible.forEach(o => {
        if (count < 12) { 
            routeSelection.add(String(o.id || o.numero));
            count++;
        }
    });
    renderRotas();
    showToast('Roteiro inteligente sugerido com sucesso!', 'success');
};

window.gerarRotaWhatsApp = function() {
  if(routeSelection.size === 0) return showToast('Selecione ao menos um pedido para a rota.');
  const selecionados = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
  let text = `🚚 *ROTA DE ENTREGA - VESCO*\n\n`;
  selecionados.forEach((s, i) => {
    const end = escapeHtml(s.endereco_completo || 'Endereço não informado');
    const obs = escapeHtml(s.instrucao_entrega || s.forma_pagamento || '');
    const tipo = s._routeType === 'FLEX' ? '[FLEX] ' : '';
    text += `*${i+1}. Pedido #${s.numero}* ${tipo}\n👤 ${s.cliente_nome}\n📍 ${end}\n💰 ${obs}\n\n`;
  });
  text += `*Total de Pacotes: ${selecionados.length}*`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
};

window.gerarRotaMaps = function() {
  if(routeSelection.size === 0) return showToast('Selecione ao menos um pedido para a rota.');
  const selecionados = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
  const comCoords = selecionados.map(o => getCoords(o)).filter(c => c !== null);
  if(comCoords.length === 0) return showToast('Nenhum pedido possui coordenadas válidas para o GPS.');
  if(comCoords.length > 10) return alert('O Google Maps aceita no máximo 10 paradas por link.');
  const dest = comCoords[comCoords.length - 1];
  let url = `http://googleusercontent.com/maps.google.com/maps?saddr=${comCoords[0].lat},${comCoords[0].lon}&daddr=${dest.lat},${dest.lon}`;
  if(comCoords.length > 2) {
      const waypoints = comCoords.slice(1, comCoords.length - 1).map(c => `${c.lat},${c.lon}`).join('+to:');
      url += `+to:${waypoints}`;
  }
  window.open(url, '_blank');
};

// -------------------------
// APP MOTORISTA
// -------------------------
window.renderMotorista = () => {
  const tbodyMot = document.getElementById('table-motorista');
  if (!tbodyMot) return;
  const todosPedidos = [...orders, ...flexOrders];
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

window.abrirAssinaturaMotorista = (numeroPedido) => {
  const form = document.getElementById('form-assinatura-motorista');
  if (form) form.classList.remove('hidden');
  const inputPedido = document.getElementById('motPedidoInput');
  if (inputPedido) inputPedido.value = numeroPedido;
  const inputRecebedor = document.getElementById('motRecebedor');
  if (inputRecebedor) { inputRecebedor.value = ''; inputRecebedor.focus(); }
  if (typeof limparAssinatura === 'function') limparAssinatura();
  if (typeof resizeCanvas === 'function') resizeCanvas();
  if (form) form.scrollIntoView({ behavior: 'smooth', block: 'end' });
};

window.prepararDespachoMotorista = (numeroPedido) => {
  let achou = false;
  if (typeof orders !== 'undefined') {
    const p = orders.find(o => String(o.numero) === String(numeroPedido) || String(o.id) === String(numeroPedido));
    if (p) { p.status_logistica = 'Despachado'; p.situacao_nome = 'Despachado'; achou = true; }
  }
  if (!achou && typeof flexOrders !== 'undefined') {
    const p = flexOrders.find(o => String(o.numero) === String(numeroPedido) || String(o.id) === String(numeroPedido));
    if (p) { p.status_logistica = 'Despachado'; p.situacao_nome = 'Despachado'; }
  }
  showToast(`Pedido #${numeroPedido} Despachado!`, 'success', 4000);
  switchTab('motorista');
  renderMotorista();
  render(); 
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(numeroPedido)}&status=Despachado&operador=${encodeURIComponent(currentOperator)}&observacao=Saiu%20para%20entrega`;
  jsonpFetch(url, function() { console.log("Despacho salvo no Google Sheets."); });
};

window.enviarComprovante = () => {
  const pedidoId = document.getElementById('motPedidoInput').value.trim();
  const recebedor = document.getElementById('motRecebedor').value.trim();
  const transportador = document.getElementById('motTransportador').value;
  if(!pedidoId || !recebedor) return alert("Preencha o Nome de quem recebeu a mercadoria.");
  if (typeof orders !== 'undefined') {
    const pedidoObj = orders.find(o => String(o.numero || o.id) === String(pedidoId));
    if (pedidoObj) { pedidoObj.status_logistica = 'Entregue'; pedidoObj.situacao_nome = 'Entregue'; }
  }
  if (typeof flexOrders !== 'undefined') {
    const pedidoObjFlex = flexOrders.find(o => String(o.numero || o.id) === String(pedidoId));
    if (pedidoObjFlex) { pedidoObjFlex.status_logistica = 'Entregue'; pedidoObjFlex.situacao_nome = 'Entregue'; }
  }
  showToast(`Entrega #${pedidoId} finalizada!`, 'success', 5000);
  const form = document.getElementById('form-assinatura-motorista');
  if (form) form.classList.add('hidden');
  if (typeof limparAssinatura === 'function') limparAssinatura();
  renderMotorista();
  render();
  const msgAudit = `Entregue via: ${transportador} | Assinado por: ${recebedor}`;
  const url = `${API}?action=updateStatus&id=${encodeURIComponent(pedidoId)}&status=Entregue&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(msgAudit)}`;
  jsonpFetch(url, function(){ console.log("Comprovante salvo no Google Sheets."); });
};

// Canvas Signature
let canvas, ctx, desenhando = false;
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    canvas = document.getElementById('signatureCanvas');
    if(canvas) {
      ctx = canvas.getContext('2d');
      const getPos = (e) => { const rect=canvas.getBoundingClientRect(); const clientX=e.touches?e.touches[0].clientX:e.clientX; const clientY=e.touches?e.touches[0].clientY:e.clientY; return { x: clientX - rect.left, y: clientY - rect.top }; };
      const start = (e) => { if (e.cancelable) e.preventDefault(); desenhando = true; draw(e); };
      const stop = () => { desenhando = false; if(ctx) ctx.beginPath(); };
      const draw = (e) => { if (!desenhando || !ctx) return; if (e.cancelable) e.preventDefault(); const pos = getPos(e); ctx.lineTo(pos.x, pos.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(pos.x, pos.y); };
      
      canvas.addEventListener('mousedown', start); canvas.addEventListener('mouseup', stop);
      canvas.addEventListener('mousemove', draw); canvas.addEventListener('mouseleave', stop);
      canvas.addEventListener('touchstart', start, {passive: false}); canvas.addEventListener('touchend', stop, {passive: false});
      canvas.addEventListener('touchmove', draw, {passive: false});
    }
  }, 1000);
});

window.resizeCanvas = () => {
  if(!canvas || !ctx) return;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width; canvas.height = rect.height;
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#2563eb';
};
window.limparAssinatura = () => { if(ctx && canvas) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.beginPath(); } };

// -------------------------
// RENDER DA UI GERAL (A SUA TABELA ORIGINAL RESTAURADA)
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

  // FILA ATIVA (ERP)
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
        
        if (instrucaoStr.includes('JÁ PAGO')) { paymentBadgeClass = "bg-emerald-50 text-emerald-700 border-emerald-200"; } 
        else if (instrucaoStr.includes('CONFERIR')) { paymentBadgeClass = "bg-amber-50 text-amber-700 border-amber-200"; } 
        else if (instrucaoStr.includes('MAQUININHA')) { paymentBadgeClass = "bg-blue-50 text-blue-700 border-blue-200"; } 
        else if (instrucaoStr.includes('DINHEIRO')) { paymentBadgeClass = "bg-indigo-50 text-indigo-700 border-indigo-200"; }

        return `
          <tr id="row-pedido-${escapeHtml(id)}" data-num="${escapeHtml(normalizeOrderNumber(o.numero || ''))}" data-ecom="${escapeHtml(ecomNorm)}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 transition-colors text-xs md:text-sm">
            <td class="p-3 pl-4"><span class="status-pill ${badgeStyle}"><span class="status-dot ${dotStyle}"></span><span>${escapeHtml(statusAtual)}</span></span></td>
            <td class="p-3 font-bold text-slate-900">#${escapeHtml(o.numero || 'S/N')}<div class="text-[12px] text-slate-800 font-semibold mt-1">${escapeHtml(o.cliente_nome || '')}</div></td>
            <td class="p-3 text-center"><input type="time" class="bg-white border border-slate-200 rounded-lg px-2 py-0.5 text-center font-bold text-xs md:text-sm w-20 shadow-sm focus:border-blue-500 outline-none" value="${o.alarme || ''}" onchange="updateAlarmTimeJsonp('${escapeHtml(id)}', this.value)"></td>
            <td class="p-3 text-center font-mono text-[#004f9f] font-bold hidden md:table-cell">${escapeHtml(displayDataPrev)}</td>
            <td class="p-3 text-xs text-slate-500 max-w-xs truncate hidden lg:table-cell">${escapeHtml(o.endereco_completo || '')}</td>
            <td class="p-3 align-middle"><span class="text-[11px] font-bold px-2.5 py-1.5 rounded-lg whitespace-nowrap shadow-sm border ${paymentBadgeClass}">${escapeHtml(instrucaoStr)}</span></td>
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

  // Logística
  if (tbodyLog) {
    const prontosOrders = orders.filter(o => String(o.status_logistica || '').toLowerCase().trim().includes('pronto'));
    const logOrdersPadrao = prontosOrders.filter(o => { const frete = String(o.nomeformafenvio || o.nome_forma_envio || o.forma_envio || '').toLowerCase(); return !frete.includes('flex') && !frete.includes('mercado'); });
    tbodyLog.innerHTML = logOrdersPadrao.map((o, idx) => {
      const ecomNorm = normalizeEcomNumber(getEcomNum(o) || '');
      const displayDataPrev = (o.data_prevista && String(o.data_prevista).trim()) ? String(o.data_prevista).trim() : '—';
      return `
      <tr id="row-pedido-${escapeHtml(o.id)}" data-num="${escapeHtml(normalizeOrderNumber(o.numero))}" data-ecom="${escapeHtml(ecomNorm)}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm cursor-pointer" onclick="focusOrderOnMap('${escapeHtml(ecomNorm || normalizeOrderNumber(o.numero))}')">
        <td class="p-3 pl-4 font-bold text-slate-900">
          <div class="flex items-center gap-1.5"><span>#${escapeHtml(o.numero)}</span><button class="ml-2 bg-blue-50 hover:bg-blue-100 text-blue-600 px-1.5 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center transition-all border border-blue-200" title="Ver localização do pedido" onclick="event.stopPropagation(); focusOrderOnMap('${escapeHtml(ecomNorm || normalizeOrderNumber(o.numero))}')"><i class="fas fa-crosshairs"></i></button></div>
          <div class="text-[11px] text-slate-400">ecom: ${escapeHtml(ecomNorm || '—')}</div>
          <div class="text-[12px] text-slate-800 font-semibold mt-1">${escapeHtml(o.cliente_nome || '')}</div>
        </td>
        <td class="p-3 text-center font-mono font-bold text-slate-600">${escapeHtml(o.alarme || '—')}</td>
        <td class="p-3 text-center font-mono font-bold text-slate-600 hidden md:table-cell">${escapeHtml(displayDataPrev)}</td>
        <td class="p-3"><b class="text-slate-800">${escapeHtml(o.cliente_nome)}</b><div class="text-[11px] text-slate-400 mt-0.5 truncate max-w-xs hidden md:block">${escapeHtml(o.endereco_completo)}</div></td>
        <td class="p-3 bg-slate-50/40 hidden md:table-cell text-xs font-semibold text-slate-500">${escapeHtml(o.instrucao_entrega || '—')}</td>
        <td class="p-3 pr-4 text-right space-x-1 whitespace-nowrap">
          <button class="bg-slate-100 hover:bg-slate-200 border border-slate-200 text-slate-600 px-2 py-1 rounded-lg font-bold text-[11px] transition-all" onclick="event.stopPropagation(); updateStatusJsonp('${escapeHtml(o.id)}','A Separar')">Estornar</button>
          <button class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg font-bold text-[11px] shadow-sm transition-all" onclick="event.stopPropagation(); prepararDespachoMotorista('${escapeHtml(o.numero)}')">Despachar</button>
        </td>
      </tr>`; 
    }).join('');
  }

  // Flex
  if (tbodyFlexCorpo) {
    const flexFiltrados = (flexOrders || []).filter(f => {
      const q = (searchQ || '').toLowerCase();
      return ( String(f.numero || '').toLowerCase().includes(q) || String(f.cliente_nome || '').toLowerCase().includes(q) || String(f.endereco_completo || '').toLowerCase().includes(q) || String(f.numero_ecommerce || '').toLowerCase().includes(q) || String(f.store_name || '').toLowerCase().includes(q) );
    });

    if (!flexFiltrados || flexFiltrados.length === 0) {
      tbodyFlexCorpo.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido Flex detectado.</td></tr>`;
    } else {
      tbodyFlexCorpo.innerHTML = flexFiltrados.map((f, idx) => {
        const numeroDoc = f.numero || 'S/N';
        const numeroEcom = f.numero_ecommerce || f.referencia || '—';
        const volumesNum = f.qtd_volumes || f.volumes || f.items_count || '1';
        const focusId = escapeHtml(normalizeEcomNumber(numeroEcom) || normalizeOrderNumber(numeroDoc));

        return `
          <tr data-num="${escapeHtml(normalizeOrderNumber(f.numero || ''))}" data-ecom="${escapeHtml(normalizeEcomNumber(numeroEcom))}" class="${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-slate-100/70 text-xs md:text-sm text-slate-700 cursor-pointer" onclick="focusFlexOnMap('${focusId}')">
            <td class="p-3 pl-4 font-bold text-slate-900">
              <div class="flex items-center gap-1.5">
                <span>#${escapeHtml(numeroDoc)}</span>
                <button class="ml-2 bg-amber-50 hover:bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-md text-[10px] font-bold inline-flex items-center transition-all border border-amber-200" title="Ver localização no mapa" onclick="event.stopPropagation(); focusFlexOnMap('${focusId}')"><i class="fas fa-crosshairs"></i></button>
              </div>
              <div class="text-[11px] text-slate-400">E‑com: ${escapeHtml(numeroEcom)}</div>
            </td>
            <td class="p-3 text-center">${escapeHtml(String(volumesNum))}</td>
            <td class="p-3"><b class="text-slate-900">${escapeHtml(f.cliente_nome || f.destinatario || f.cliente || '—')}</b><div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(f.endereco_completo || '')}</div><div class="text-[10px] text-slate-400 mt-1 font-medium">Loja: <b>${escapeHtml(f.store_name || '—')}</b></div></td>
            <td class="p-3 text-center hidden md:table-cell"><span class="font-mono text-slate-700 font-bold">${escapeHtml(f.data_prevista || '—')}</span></td>
            <td class="p-3 hidden md:table-cell">${escapeHtml(f.situacao_nome || f.situacao || '—')}</td>
            <td class="p-3 pr-4 text-right"><button class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-xl font-bold text-[11px] shadow-sm transition-all" onclick="event.stopPropagation(); prepararDespachoMotorista('${escapeHtml(numeroDoc)}')">Despachar</button></td>
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
  if(sumTotalEl) { const flexFiltradosParaMapa = (flexOrders || []).filter(f => String(f.numero || '').trim() !== ''); sumTotalEl.innerText = orders.length + flexFiltradosParaMapa.length; }
  if(sumFlexEl) { const flexFiltrados = (flexOrders || []).filter(f => String(f.numero || '').trim() !== ''); sumFlexEl.innerText = flexFiltrados.length; }

  // AÇÕES FINAIS E INTEGRAÇÃO DE COMPONENTES
  try {
    const logOrdersForMap = (orders || []).filter(o => { const frete = String(o.nomeformafenvio || o.nome_forma_envio || o.forma_envio || '').toLowerCase(); return !frete.includes('flex') && !frete.includes('mercado'); });
    const flexFiltradosParaMapa = (flexOrders || []).filter(f => String(f.numero || '').trim() !== '');
    
    // Roda os componentes
    plotMapMarkers(logOrdersForMap, flexFiltradosParaMapa);
    if(typeof renderRotas === 'function') renderRotas();
    if(typeof renderMotorista === 'function') renderMotorista();
    
  } catch (e) { console.warn('Erros visuais no render principal:', e); }
}

// --- Funções de Navegação Globais ---
function switchTab(which){
  document.getElementById('view-separacao')?.classList.toggle('hidden', which !== 'separacao');
  document.getElementById('view-separados_hoje')?.classList.toggle('hidden', which !== 'separados_hoje');
  document.getElementById('view-logistica')?.classList.toggle('hidden', which !== 'logistica');
  document.getElementById('view-envios_flex')?.classList.toggle('hidden', which !== 'envios_flex');
  document.getElementById('view-rotas')?.classList.toggle('hidden', which !== 'rotas');
  document.getElementById('view-motorista')?.classList.toggle('hidden', which !== 'motorista');
  document.getElementById('view-entregues')?.classList.toggle('hidden', which !== 'entregues');
  
  if(document.getElementById('main-sep')) document.getElementById('main-sep').className = which === 'separacao' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-sephoje')) document.getElementById('main-sephoje').className = which === 'separados_hoje' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-log')) document.getElementById('main-log').className = which === 'logistica' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-flex')) document.getElementById('main-flex').className = which === 'envios_flex' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-rotas')) document.getElementById('main-rotas').className = which === 'rotas' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-mot')) document.getElementById('main-mot').className = which === 'motorista' ? 'tab-btn active' : 'tab-btn';
  if(document.getElementById('main-ent')) document.getElementById('main-ent').className = which === 'entregues' ? 'tab-btn active' : 'tab-btn';
  
  if(which === 'logistica') { setTimeout(() => { try { if (map) map.invalidateSize(); const b = markerCluster && markerCluster.getBounds && markerCluster.getBounds(); if(b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.12), { maxZoom: 14, animate: false }); } catch(e){} }, 250); }
  if(which === 'envios_flex') { setTimeout(() => { try { if (mapFlex) mapFlex.invalidateSize(); if(markerClusterFlex && markerClusterFlex.getLayers && markerClusterFlex.getLayers().length > 0){ const b = markerClusterFlex.getBounds(); if(b && b.isValid && b.isValid()) { if(b.getSouthWest().equals(b.getNorthEast())) mapFlex.setView(b.getSouthWest(), 14); else mapFlex.fitBounds(b.pad(0.12), { maxZoom: 14, animate: false }); } } } catch(e){} }, 300); }
  if(which === 'rotas') { setTimeout(() => { try { if (typeof plotRotasMap === 'function') plotRotasMap(); } catch(e){} }, 300); }
  if(which === 'motorista') { setTimeout(() => { if(typeof resizeCanvas === 'function') resizeCanvas(); }, 200); }
}

function switchSubTab(name){
  document.getElementById('subview-fila').classList.toggle('hidden', name !== 'fila');
  document.getElementById('subview-pendencias').classList.toggle('hidden', name !== 'pendencias');
  document.getElementById('sub-fila').className = name==='fila' ? 'bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 transition-all';
  document.getElementById('sub-pend').className = name==='pendencias' ? 'bg-slate-900 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-sm transition-all' : 'bg-slate-50 text-slate-600 hover:bg-slate-100 px-4 py-2 rounded-xl text-xs font-bold border border-slate-200 transition-all';
}

function checkOperator() { if (!currentOperator) { const modal = document.getElementById('operatorModal'); if(modal) modal.classList.remove('hidden'); } else { const el = document.getElementById('activeOperatorDisplay'); if(el) el.innerText = `Op: ${currentOperator}`; } }
function saveOperator() { const name = (document.getElementById('operatorNameInput')?.value || '').trim(); if(name) { localStorage.setItem('vesco_operator', name); currentOperator = name; const modal = document.getElementById('operatorModal'); if(modal) modal.classList.add('hidden'); const el = document.getElementById('activeOperatorDisplay'); if(el) el.innerText = `Op: ${currentOperator}`; } }

// --- Map Toolbar Controls ---
window.toggleMapExpand = function(mapId) {
  const el = document.getElementById(mapId); if(!el) return; const wrapper = el.closest('.map-wrapper'); if(wrapper) wrapper.classList.toggle('expanded-map');
  setTimeout(() => { if(mapId === 'map' && map) map.invalidateSize(); if(mapId === 'map-flex' && mapFlex) mapFlex.invalidateSize(); if(mapId === 'map-rotas' && mapRotas) mapRotas.invalidateSize(); }, 300);
};

window.changeMapHeight = function(mapId, delta) {
  const el = document.getElementById(mapId); if(!el) return; const currentHeight = el.clientHeight || 420; let newHeight = currentHeight + delta; if (newHeight < 200) newHeight = 200; el.style.setProperty('height', newHeight + 'px', 'important');
  setTimeout(() => { if(mapId === 'map' && map) map.invalidateSize(); if(mapId === 'map-flex' && mapFlex) mapFlex.invalidateSize(); if(mapId === 'map-rotas' && mapRotas) mapRotas.invalidateSize(); }, 300);
};

// --- Início ---
document.addEventListener('DOMContentLoaded', function() {
  try {
    const dBr = new Date(); const offset = dBr.getTimezoneOffset(); const topCalendar = document.getElementById('topCalendar'); if (topCalendar) { topCalendar.value = new Date(dBr.getTime() - (offset*60*1000)).toISOString().split('T')[0]; }
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
  } catch(e) { console.warn('Erro na inicialização', e); }
});

// JSONP Base Status Actions
window.updateStatusJsonp = function(id, status, observacao = ''){
  showLoading(true);
  const url = `${API}?action=updateStatus&id=${id}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}`;
  jsonpFetch(url, function(){ showLoading(false); load(); showToast('Status atualizado!', 'success'); });
};
window.updateAlarmTimeJsonp = function(id, timeValue) {
  if (!timeValue) return; showLoading(true);
  const url = `${API}?action=updateStatus&id=${id}&alarme=${encodeURIComponent(timeValue)}&operador=${encodeURIComponent(currentOperator)}`;
  jsonpFetch(url, function(){ showLoading(false); load(); showToast('Alarme configurado!', 'success'); });
};
window.moverParaPendenciaPrompt = function(id){
  const motivo = prompt('Motivo da pendência:');
  if(motivo !== null) updateStatusJsonp(id, 'Pendente', motivo || '');
};
// =======================================================
// CORREÇÃO DO MAPA E LÓGICA DE ROTAS INTELIGENTES
// Cole no final do seu app.js original
// =======================================================

// 1. Devolvemos a função do Mapa que estava faltando
function initMap() {
    if (window._vesco_map_inited) return;
    window._vesco_map_inited = true;

    try {
        if(document.getElementById('map')) { map = L.map('map').setView([-23.55052, -46.633308], 11); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png').addTo(map); markerCluster = L.markerClusterGroup(); map.addLayer(markerCluster); }
        if(document.getElementById('map-flex')) { mapFlex = L.map('map-flex').setView([-23.55052, -46.633308], 11); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png').addTo(mapFlex); markerClusterFlex = L.markerClusterGroup(); mapFlex.addLayer(markerClusterFlex); }
        if(document.getElementById('map-rotas')) { mapRotas = L.map('map-rotas').setView([-23.55052, -46.633308], 11); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png').addTo(mapRotas); markerClusterRotas = L.markerClusterGroup(); mapRotas.addLayer(markerClusterRotas); }
    } catch(e) { console.warn("Erro ao iniciar mapas:", e); }
}

// 2. Lógica das Rotas
let routeSelection = new Set();
let routeEligible = [];

function renderRotas() {
  routeEligible = [];
  const pushEligible = (o, type) => {
     const st = String(o.status_logistica || o.situacao_nome || o.status || '').toLowerCase();
     if(st !== 'entregue' && st !== 'despachado' && String(o.numero || '').trim() !== '') {
         o._routeType = type;
         routeEligible.push(o);
     }
  };
  
  if (typeof orders !== 'undefined') orders.forEach(o => pushEligible(o, 'ERP'));
  if (typeof flexOrders !== 'undefined') flexOrders.forEach(o => pushEligible(o, 'FLEX'));

  const tbodyRotas = document.getElementById('table-rotas');
  if(tbodyRotas) {
     if(routeEligible.length === 0) {
        tbodyRotas.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400 font-semibold">Nenhum pedido disponível para rota.</td></tr>`;
     } else {
        tbodyRotas.innerHTML = routeEligible.map((o) => {
           const id = escapeHtml(String(o.id || o.numero));
           const ecom = typeof getEcomNum === 'function' ? escapeHtml(normalizeEcomNumber(getEcomNum(o))) : '';
           const checked = routeSelection.has(id) ? 'checked' : '';
           const typeBadge = o._routeType === 'FLEX' 
              ? '<span class="bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-[10px] font-bold">FLEX</span>' 
              : '<span class="bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded text-[10px] font-bold">ERP</span>';
           
           return `
             <tr class="hover:bg-slate-50 cursor-pointer ${checked ? 'bg-purple-50' : ''} transition-colors" onclick="toggleRouteOrder('${id}')">
                <td class="p-2.5 text-center" onclick="event.stopPropagation()">
                   <input type="checkbox" class="w-4 h-4 accent-purple-600 rounded cursor-pointer" ${checked} onchange="toggleRouteOrder('${id}')">
                </td>
                <td class="p-2.5">
                   <div class="font-bold text-slate-800 text-xs">#${escapeHtml(o.numero)}</div>
                   <div class="text-[10px] text-slate-400 mt-0.5">${ecom || '—'}</div>
                </td>
                <td class="p-2.5">
                   <div class="font-bold text-slate-700 text-[11px]">${escapeHtml(o.cliente_nome)}</div>
                   <div class="text-[10px] text-slate-500 truncate max-w-[220px] mt-0.5" title="${escapeHtml(o.endereco_completo)}">${escapeHtml(o.endereco_completo)}</div>
                </td>
                <td class="p-2.5 text-right">
                   ${typeBadge}
                   <div class="mt-1 text-[9px] font-bold text-slate-400 uppercase">${escapeHtml(o.status_logistica || o.situacao_nome || o.situacao || 'A Separar')}</div>
                </td>
             </tr>
           `;
        }).join('');
     }
  }
  
  const countEl = document.getElementById('rota-count');
  if(countEl) countEl.innerText = routeSelection.size;
  plotRotasMap();
}

function plotRotasMap() {
  if(!window.markerClusterRotas || !window.mapRotas) return;
  markerClusterRotas.clearLayers();
  
  routeEligible.forEach(item => {
      const coords = typeof getCoords === 'function' ? getCoords(item) : null;
      if(coords) {
          const id = String(item.id || item.numero);
          const isSelected = routeSelection.has(id);
          const color = isSelected ? '#9333ea' : '#94a3b8'; 
          const svgHtml = `<svg width="${isSelected?34:26}" height="${isSelected?34:26}" viewBox="0 0 24 24"><path d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6z" fill="${color}" stroke="#fff"/></svg>`;
          const icon = L.divIcon({ html: svgHtml, className: '', iconSize: [isSelected?34:26, isSelected?34:26], iconAnchor: [isSelected?17:13, isSelected?34:26] });
          const m = L.marker([coords.lat, coords.lon], { icon }).bindPopup(`<div class='p-1 font-sans text-center'><b class='text-[13px] ${isSelected ? 'text-purple-600' : 'text-slate-600'}'>#${escapeHtml(item.numero)}</b><br><span class='text-xs text-slate-700 font-semibold'>${escapeHtml(item.cliente_nome)}</span></div>`);
          m.on('click', () => { toggleRouteOrder(id); });
          markerClusterRotas.addLayer(m);
      }
  });
  
  if(routeSelection.size > 0 && markerClusterRotas.getLayers().length > 0) {
      const bounds = L.featureGroup(markerClusterRotas.getLayers()).getBounds();
      if(bounds.isValid()) mapRotas.fitBounds(bounds.pad(0.1), { maxZoom: 15 });
  }
}

window.toggleRouteOrder = function(id) { if(routeSelection.has(id)) routeSelection.delete(id); else routeSelection.add(id); renderRotas(); };
window.selectAllRoute = function() { routeEligible.forEach(o => routeSelection.add(String(o.id || o.numero))); renderRotas(); };
window.clearRouteSelection = function() { routeSelection.clear(); renderRotas(); };

window.sugerirRotasInteligentes = function() {
    if (!routeEligible || routeEligible.length === 0) return alert('Não há pedidos disponíveis para roteirizar.');
    routeSelection.clear();
    let count = 0;
    routeEligible.forEach(o => { if (count < 12) { routeSelection.add(String(o.id || o.numero)); count++; } });
    renderRotas();
    if(typeof showToast === 'function') showToast('Roteiro sugerido com sucesso!', 'success'); else alert('Roteiro sugerido com sucesso!');
};

window.gerarRotaWhatsApp = function() {
  if(routeSelection.size === 0) return alert('Selecione ao menos um pedido para a rota.');
  const selecionados = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
  let text = `🚚 *ROTA DE ENTREGA - VESCO*\n\n`;
  selecionados.forEach((s, i) => {
    const end = escapeHtml(s.endereco_completo || 'Endereço não informado');
    const obs = escapeHtml(s.instrucao_entrega || s.forma_pagamento || '');
    const tipo = s._routeType === 'FLEX' ? '[FLEX] ' : '';
    text += `*${i+1}. Pedido #${s.numero}* ${tipo}\n👤 ${s.cliente_nome}\n📍 ${end}\n💰 ${obs}\n\n`;
  });
  text += `*Total de Pacotes: ${selecionados.length}*`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
};

window.gerarRotaMaps = function() {
  if(routeSelection.size === 0) return alert('Selecione ao menos um pedido para a rota.');
  const selecionados = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
  const comCoords = selecionados.map(o => typeof getCoords === 'function' ? getCoords(o) : null).filter(c => c !== null);
  if(comCoords.length === 0) return alert('Nenhum pedido possui coordenadas válidas para o GPS.');
  if(comCoords.length > 10) return alert('O Google Maps aceita no máximo 10 paradas por link.');
  const dest = comCoords[comCoords.length - 1];
  let url = `http://googleusercontent.com/maps.google.com/maps?saddr=${comCoords[0].lat},${comCoords[0].lon}&daddr=${dest.lat},${dest.lon}`;
  if(comCoords.length > 2) {
      const waypoints = comCoords.slice(1, comCoords.length - 1).map(c => `${c.lat},${c.lon}`).join('+to:');
      url += `+to:${waypoints}`;
  }
  window.open(url, '_blank');
};

// Vincula a renderização da rota à função global render() que você já tem
const roteirizador_originalRender = typeof render === 'function' ? render : function(){};
window.render = function() {
    roteirizador_originalRender();
    renderRotas();
};
