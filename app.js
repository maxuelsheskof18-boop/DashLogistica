// app.js — VERSÃO MASTER E DEFINITIVA

// ==========================================
// 1. VARIÁVEIS GLOBAIS
// ==========================================
let orders = [], flexOrders = [], currentOperator = localStorage.getItem('vesco_operator') || '';
let map, mapFlex, mapRotas, markerCluster, markerClusterFlex, markerClusterRotas;
let renderTimer = null, geocodeCache = {}, geocodeQueue = [], geocodeProcessing = false, currentMapRenderToken = 0;
let routeSelection = new Set(), routeEligible = [];
let canvas, ctx, desenhando = false;

const GEOCODE_DELAY_MS = 1100;
const API = "https://script.google.com/macros/s/AKfycbxEzbxBABMDwi7B7tn_1p-lC0vc50JjHFOrH3w42Oog2-5R2-WMYSrQ27ED7wduJUN6/exec";
const API_FLEX = "https://script.google.com/macros/s/AKfycbzDp2qs2S_MxDc_3afY1TurNKYEwfYKkk2cc4IliNxLiVaJuSKYyRqofOUMnhdFBjwNwg/exec";

// ==========================================
// 2. HELPERS BÁSICOS E ÁUDIO
// ==========================================
window.playBeepSound = () => {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctxAudio = new AudioContext();
        const osc = ctxAudio.createOscillator();
        const gain = ctxAudio.createGain();
        osc.type = 'square'; osc.frequency.setValueAtTime(880, ctxAudio.currentTime);
        gain.gain.setValueAtTime(0.1, ctxAudio.currentTime);
        osc.connect(gain); gain.connect(ctxAudio.destination);
        osc.start(); osc.stop(ctxAudio.currentTime + 0.15);
    } catch(e) { console.warn("Áudio bloqueado."); }
};
window.stopAudioAlarm = () => { document.getElementById('snoozeModal')?.classList.add('hidden'); };
window.checkTimeAlarms = window.checkTimeAlarms || function() {};

function escapeHtml(t){ if(t==null) return ''; return String(t).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
function normalizeOrderNumber(n){ return n ? String(n).trim().replace(/^#/,'').replace(/[^0-9A-Za-z\-_.]/g,'') : ''; }
function normalizeEcomNumber(v){ if(!v) return ''; let s=String(v).trim().replace(/\D/g,''); return s.length>=5 ? s : String(v).trim().replace(/[^0-9A-Za-z\-_]/g,''); }

function parseNumberLoose(v){
  if(v === null || v === undefined) return NaN;
  if(typeof v === 'number') return v;
  return parseFloat(String(v).trim().replace(/\s+/g,'').replace(',', '.').replace(/[^0-9\.\-]/g, ''));
}
function _tryNormalizeNumber(v, isLat){
  if(v === null || v === undefined) return null;
  const n = parseNumberLoose(v);
  if(!Number.isFinite(n)) return null;
  const divisors = [1e6, 1e7, 1e5, 1e3, 1e2];
  for(const d of divisors){ const nv = n / d; if(Math.abs(nv) <= (isLat ? 90 : 180)) return nv; }
  return null;
}
function getCoords(item) {
    const lat = _tryNormalizeNumber(item.lat ?? item.latitude ?? item.latitude_local, true);
    const lon = _tryNormalizeNumber(item.lon ?? item.longitude ?? item.longitude_local, false);
    return (lat !== null && lon !== null) ? { lat, lon } : null;
}
function getEcomNum(item){
    if(!item) return '';
    const candidates = [item.numero_ecommerce, item.numero_ecom, item.ecom_num, item.id_ecom, item.referencia, item.reference, item.codigo_externo, item.order_id];
    for(const c of candidates){ if(c) { const norm = normalizeEcomNumber(c); if(norm) return norm; } }
    return normalizeEcomNumber(item.numero || item.id || item.pedido || '');
}

function showLoading(on){ const el = document.getElementById('loadingOverlay'); if(el) el.style.display = on ? 'flex' : 'none'; }
function showToast(msg, type='info', ms=4000){ 
    const t = document.getElementById('toast'); if(!t) return; 
    t.className = `toast fixed top-4 right-4 ${type==='success'?'bg-emerald-600':type==='error'?'bg-red-600':'bg-slate-800'} text-white px-5 py-3 rounded-xl shadow-2xl font-bold text-sm flex items-center z-[9999]`;
    t.innerHTML = `<div>${msg}</div>`; t.style.display='flex'; 
    setTimeout(()=>t.style.display='none', ms); 
}
function scheduleRender() { if(renderTimer) clearTimeout(renderTimer); renderTimer = setTimeout(render, 60); }

// ==========================================
// 3. FETCH DATA (JSONP)
// ==========================================
function jsonpFetch(url, cb) {
    const cbName = '__jsonp_cb_' + Math.random().toString(36).substr(2,9);
    const script = document.createElement('script');
    const timeout = setTimeout(() => { try{delete window[cbName];}catch(e){} if(script.parentNode) script.remove(); cb(new Error("Timeout"), null); }, 15000);
    window[cbName] = function(res) { clearTimeout(timeout); try{cb(null, res);}catch(e){} try{delete window[cbName];}catch(e){} if(script.parentNode) script.remove(); };
    script.src = `${url}${url.indexOf('?')===-1?'?':'&'}callback=${cbName}`; document.head.appendChild(script);
}

function load() {
    jsonpFetch(API, function(err, resp){
        if (resp && resp.success) orders = (resp.data || []).filter(o => o.numero || o.id);
        else if (Array.isArray(resp)) orders = resp;
        else orders = [];
        scheduleRender();
    });
    jsonpFetch(API_FLEX+'?action=separacoesIndex', function(err, resp){
        if (resp && resp.data) flexOrders = resp.data;
        else if (Array.isArray(resp)) flexOrders = resp;
        else flexOrders = [];
        scheduleRender();
    });
}

// ==========================================
// 4. MAPAS (INIT E PLOT)
// ==========================================
function initMap() {
    if (window._vesco_map_inited) return;
    window._vesco_map_inited = true;
    try {
        if(document.getElementById('map')) { map = L.map('map').setView([-23.55052, -46.633308], 11); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png').addTo(map); markerCluster = L.markerClusterGroup(); map.addLayer(markerCluster); }
        if(document.getElementById('map-flex')) { mapFlex = L.map('map-flex').setView([-23.55052, -46.633308], 11); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png').addTo(mapFlex); markerClusterFlex = L.markerClusterGroup(); mapFlex.addLayer(markerClusterFlex); }
        if(document.getElementById('map-rotas')) { mapRotas = L.map('map-rotas').setView([-23.55052, -46.633308], 11); L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png').addTo(mapRotas); markerClusterRotas = L.markerClusterGroup(); mapRotas.addLayer(markerClusterRotas); }
    } catch(e) { console.warn("Erro ao iniciar mapas:", e); }
}

function createPinSVG(color, size){ return `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><path d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6z" fill="${color}" stroke="#fff" stroke-width="1.2"/><circle cx="12" cy="8" r="4" fill="#fff" /></svg>`; }

window.activeMainMarkers = {}; window.activeFlexMarkers = {};

function plotMapMarkers(orderList, flexList){
    if(!markerCluster || !markerClusterFlex) return;
    currentMapRenderToken++; const myToken = currentMapRenderToken;
    markerCluster.clearLayers(); markerClusterFlex.clearLayers();
    window.activeMainMarkers = {}; window.activeFlexMarkers = {};

    function addMarker(item, isFlex) {
        if(myToken !== currentMapRenderToken) return;
        const c = getCoords(item); if(!c) return;
        const normNum = normalizeOrderNumber(item.numero || item.id);
        if(isFlex && window.activeFlexMarkers[normNum]) return;
        if(!isFlex && window.activeMainMarkers[normNum]) return;
        
        const color = isFlex ? '#eab308' : '#004f9f';
        const icon = L.divIcon({ html: createPinSVG(color, 30), className: '', iconSize: [30,30], iconAnchor: [15,30] });
        const m = L.marker([c.lat, c.lon], { icon }).bindPopup(`<b>#${item.numero}</b><br>${item.cliente_nome}`);
        
        if(isFlex) { markerClusterFlex.addLayer(m); markerCluster.addLayer(L.marker([c.lat, c.lon],{icon}).bindPopup(`<b>#${item.numero}</b><br>${item.cliente_nome}`)); window.activeFlexMarkers[normNum] = m; }
        else { markerCluster.addLayer(m); window.activeMainMarkers[normNum] = m; }
    }
    (orderList||[]).forEach(o => addMarker(o, false));
    (flexList||[]).forEach(o => addMarker(o, true));
}

// ==========================================
// 5. ROTEIRIZADOR E MAPAS DE ROTAS
// ==========================================
function renderRotas() {
    routeEligible = [...orders, ...flexOrders].filter(o => { const st = String(o.status_logistica || o.situacao_nome || '').toLowerCase(); return st !== 'entregue' && st !== 'despachado' && String(o.numero||'').trim() !== ''; });
    const tbody = document.getElementById('table-rotas');
    if(tbody) tbody.innerHTML = routeEligible.map(o => {
        const id = String(o.id || o.numero); const checked = routeSelection.has(id) ? 'checked' : '';
        return `<tr class="border-b cursor-pointer ${checked ? 'bg-purple-50' : ''}" onclick="toggleRouteOrder('${id}')">
            <td class="p-2.5 text-center" onclick="event.stopPropagation()"><input type="checkbox" class="w-4 h-4" ${checked} onchange="toggleRouteOrder('${id}')"></td>
            <td class="p-2.5 text-xs font-bold">#${escapeHtml(o.numero)}</td><td class="p-2.5 text-xs">${escapeHtml(o.cliente_nome||'')}</td>
            <td class="p-2.5 text-xs text-right">${escapeHtml(o.status_logistica||o.situacao_nome||'A Separar')}</td>
        </tr>`;
    }).join('');
    if(document.getElementById('rota-count')) document.getElementById('rota-count').innerText = routeSelection.size;
    plotRotasMap();
}

function plotRotasMap() {
    if(!markerClusterRotas || !mapRotas) return;
    markerClusterRotas.clearLayers();
    routeEligible.forEach(item => {
        const c = getCoords(item);
        if(c && routeSelection.has(String(item.id||item.numero))) { 
            const m = L.marker([c.lat, c.lon], {icon: L.divIcon({html: createPinSVG('#9333ea', 34), className:'', iconSize:[34,34], iconAnchor:[17,34]})});
            markerClusterRotas.addLayer(m); 
        }
    });
    if(routeSelection.size > 0 && markerClusterRotas.getLayers().length > 0) {
        const bounds = L.featureGroup(markerClusterRotas.getLayers()).getBounds();
        if(bounds.isValid()) mapRotas.fitBounds(bounds.pad(0.1), { maxZoom: 15 });
    }
}

window.toggleRouteOrder = (id) => { routeSelection.has(String(id)) ? routeSelection.delete(String(id)) : routeSelection.add(String(id)); renderRotas(); };
window.selectAllRoute = () => { routeEligible.forEach(o => routeSelection.add(String(o.id || o.numero))); renderRotas(); };
window.clearRouteSelection = () => { routeSelection.clear(); renderRotas(); };

window.sugerirRotasInteligentes = () => {
    if (!routeEligible || routeEligible.length === 0) return alert('Não há pedidos disponíveis.');
    routeSelection.clear(); let count = 0;
    routeEligible.forEach(o => { if (count < 12) { routeSelection.add(String(o.id || o.numero)); count++; } });
    renderRotas(); showToast('Roteiro sugerido com sucesso!', 'success');
};

window.gerarRotaWhatsApp = () => {
    const sels = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
    if(sels.length === 0) return alert('Selecione pedidos.');
    let text = `🚚 *ROTA DE ENTREGA - VESCO*\n\n` + sels.map((s,i) => `*${i+1}. #${s.numero}*\n👤 ${s.cliente_nome}\n📍 ${s.endereco_completo || s.endereco}\n`).join('\n');
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
};

window.gerarRotaMaps = () => {
    const sels = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero))).map(o=>getCoords(o)).filter(Boolean);
    if(sels.length < 2) return alert('Selecione 2 pedidos com coordenadas válidas.');
    const origin = sels[0]; const dest = sels[sels.length-1];
    window.open(`http://googleusercontent.com/maps.google.com/maps?saddr=${origin.lat},${origin.lon}&daddr=${dest.lat},${dest.lon}${sels.length>2?'+to:'+sels.slice(1,-1).map(c=>`${c.lat},${c.lon}`).join('+to:'):''}`, '_blank');
};

// ==========================================
// 6. MOTORISTA E DESPACHO
// ==========================================
window.renderMotorista = () => {
    const tbody = document.getElementById('table-motorista'); if (!tbody) return;
    const emRota = [...orders, ...flexOrders].filter(o => String(o.status_logistica || o.situacao_nome || '').toLowerCase() === 'despachado');
    if (emRota.length === 0) { tbody.innerHTML = `<tr><td colspan="3" class="p-8 text-center text-slate-400 font-bold">Nenhuma entrega em rota.</td></tr>`; return; }
    tbody.innerHTML = emRota.map(o => `
        <tr class="border-b">
            <td class="p-3 font-black">#${escapeHtml(o.numero)}</td>
            <td class="p-3 text-sm font-bold text-slate-700">${escapeHtml(o.cliente_nome)}<div class="text-[11px] font-normal">${escapeHtml(o.endereco_completo)}</div></td>
            <td class="p-3 text-right"><button onclick="abrirAssinaturaMotorista('${escapeHtml(o.numero)}')", class="bg-blue-600 text-white px-4 py-2 rounded-lg font-bold text-[11px]">ENTREGAR</button></td>
        </tr>`).join('');
};

window.prepararDespachoMotorista = (numeroPedido) => {
    let p = orders.find(o => String(o.numero) === String(numeroPedido)) || flexOrders.find(o => String(o.numero) === String(numeroPedido));
    if (p) { p.status_logistica = 'Despachado'; p.situacao_nome = 'Despachado'; }
    showToast(`Pedido #${numeroPedido} Despachado!`, 'success');
    window.switchTab('motorista'); render();
    jsonpFetch(`${API}?action=updateStatus&id=${encodeURIComponent(numeroPedido)}&status=Despachado&operador=${encodeURIComponent(currentOperator)}&observacao=Saiu%20para%20entrega`, ()=>{});
};

window.abrirAssinaturaMotorista = (num) => {
    const form = document.getElementById('form-assinatura-motorista');
    if (form) { form.classList.remove('hidden'); document.getElementById('motPedidoInput').value = num; form.scrollIntoView({ behavior: 'smooth', block: 'end' }); window.resizeCanvas(); }
};

window.limparAssinatura = () => { if(ctx && canvas) { ctx.clearRect(0,0,canvas.width,canvas.height); ctx.beginPath(); } };
window.resizeCanvas = () => { if(!canvas || !ctx) return; const rect = canvas.getBoundingClientRect(); canvas.width = rect.width; canvas.height = rect.height; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = '#2563eb'; };

window.enviarComprovante = () => {
    const pedido = document.getElementById('motPedidoInput').value;
    const recebedor = document.getElementById('motRecebedor').value;
    if(!pedido || !recebedor) return alert("Preencha o nome do recebedor.");
    let p = orders.find(o => String(o.numero) === String(pedido)) || flexOrders.find(o => String(o.numero) === String(pedido));
    if (p) { p.status_logistica = 'Entregue'; p.situacao_nome = 'Entregue'; }
    showToast(`Entrega #${pedido} finalizada!`, 'success');
    document.getElementById('form-assinatura-motorista').classList.add('hidden');
    window.limparAssinatura(); render();
    jsonpFetch(`${API}?action=updateStatus&id=${encodeURIComponent(pedido)}&status=Entregue&operador=${encodeURIComponent(currentOperator)}&observacao=Assinado%20por:%20${encodeURIComponent(recebedor)}`, ()=>{});
};

// ==========================================
// 7. AÇÕES DE SISTEMA GERAIS
// ==========================================
window.updateStatusJsonp = function(id, status, observacao = ''){
    showLoading(true);
    jsonpFetch(`${API}?action=updateStatus&id=${id}&status=${encodeURIComponent(status)}&operador=${encodeURIComponent(currentOperator)}&observacao=${encodeURIComponent(observacao)}`, function(){ showLoading(false); showToast('Atualizado!', 'success'); load(); });
};
window.updateAlarmTimeJsonp = function(id, timeValue) {
    if (!timeValue) return; showLoading(true);
    jsonpFetch(`${API}?action=updateStatus&id=${id}&alarme=${encodeURIComponent(timeValue)}&operador=${encodeURIComponent(currentOperator)}`, function(){ showLoading(false); showToast('Alarme salvo!', 'success'); load(); });
};
window.moverParaPendenciaPrompt = function(id){
    const motivo = prompt('Motivo da pendência:'); if(motivo !== null) window.updateStatusJsonp(id, 'Pendente', motivo || '');
};

// ==========================================
// 8. RENDERIZAÇÃO DA TABELA VISUAL
// ==========================================
function render(){
    const searchQ = (document.getElementById('search')?.value || '').toLowerCase();
    
    // Fila ERP
    const fila = orders.filter(o => { const st=String(o.status_logistica||'').toLowerCase(); return (st==='a separar'||st==='em separação') && (String(o.numero).includes(searchQ) || String(o.cliente_nome).toLowerCase().includes(searchQ)); });
    const tbodyFila = document.getElementById('table-fila');
    if(tbodyFila) tbodyFila.innerHTML = fila.map(o => `<tr class="border-b text-xs"><td class="p-3 font-bold uppercase text-red-600">${escapeHtml(o.status_logistica||'A Separar')}</td><td class="p-3 font-bold">#${escapeHtml(o.numero)}<br><span class="font-normal text-slate-500">${escapeHtml(o.cliente_nome)}</span></td><td class="p-3 text-right"><button onclick="updateStatusJsonp('${o.id}','Em Separação')" class="bg-blue-600 text-white px-2 py-1 rounded">Iniciar</button> <button onclick="updateStatusJsonp('${o.id}','Pronto p/ Entrega')" class="bg-emerald-600 text-white px-2 py-1 rounded">Pronto</button></td></tr>`).join('');

    // Separados Hoje
    const prontos = orders.filter(o => String(o.status_logistica||'').toLowerCase().includes('pronto'));
    const tbodyProntos = document.getElementById('table-separados-hoje');
    if(tbodyProntos) tbodyProntos.innerHTML = prontos.map(o => `<tr class="border-b text-xs"><td class="p-3 font-bold">#${escapeHtml(o.numero)}</td><td class="p-3">${escapeHtml(o.cliente_nome)}</td><td class="p-3 text-right"><button onclick="prepararDespachoMotorista('${o.numero}')" class="bg-amber-500 text-white px-3 py-1 rounded font-bold">Despachar</button></td></tr>`).join('');

    // Entregues
    const entregues = [...orders, ...flexOrders].filter(o => String(o.status_logistica||o.situacao_nome||'').toLowerCase() === 'entregue');
    const tbodyEntregues = document.getElementById('table-entregues');
    if(tbodyEntregues) tbodyEntregues.innerHTML = entregues.map(o => `<tr class="border-b text-xs"><td class="p-3 font-bold text-emerald-600">#${escapeHtml(o.numero)}</td><td class="p-3">${escapeHtml(o.cliente_nome)}</td><td class="p-3 text-right font-bold text-emerald-600">ENTREGUE</td></tr>`).join('');

    // Logística (ERP Prontos)
    const tbodyLog = document.getElementById('table-logistica');
    if(tbodyLog) {
        const logOrders = prontos.filter(o => !String(o.nomeformafenvio||'').toLowerCase().includes('flex'));
        tbodyLog.innerHTML = logOrders.map(o => `<tr class="border-b text-xs"><td class="p-3 font-bold">#${escapeHtml(o.numero)}</td><td class="p-3">${escapeHtml(o.cliente_nome)}<br><span class="text-slate-400">${escapeHtml(o.endereco_completo)}</span></td><td class="p-3 text-right"><button onclick="prepararDespachoMotorista('${o.numero}')" class="bg-amber-500 text-white px-3 py-1 rounded font-bold">Despachar</button></td></tr>`).join('');
    }

    // Flex
    const tbodyFlex = document.getElementById('table-envios-flex-corpo');
    if(tbodyFlex) tbodyFlex.innerHTML = flexOrders.filter(f=>f.numero).map(f => `<tr class="border-b text-xs"><td class="p-3 font-bold text-amber-600">#${escapeHtml(f.numero)}</td><td class="p-3">${escapeHtml(f.cliente_nome)}</td><td class="p-3 text-right"><button onclick="prepararDespachoMotorista('${f.numero}')" class="bg-blue-600 text-white px-3 py-1 rounded font-bold">Despachar</button></td></tr>`).join('');

    // Módulos
    window.renderMotorista();
    window.renderRotas();
    plotMapMarkers(orders.filter(o => !String(o.nomeformafenvio||'').toLowerCase().includes('flex')), flexOrders.filter(f=>f.numero));
}

// ==========================================
// 9. NAVEGAÇÃO E INICIALIZAÇÃO DA PÁGINA
// ==========================================
window.switchTab = function(which){
    ['separacao','separados_hoje','logistica','envios_flex','rotas','motorista','entregues'].forEach(id => {
        document.getElementById('view-'+id)?.classList.toggle('hidden', which !== id);
        const btn = document.getElementById('main-'+(id==='separacao'?'sep':id==='separados_hoje'?'sephoje':id==='logistica'?'log':id==='envios_flex'?'flex':id==='motorista'?'mot':id==='entregues'?'ent':'rotas'));
        if(btn) btn.className = which === id ? 'tab-btn active' : 'tab-btn';
    });
    if(which==='logistica') setTimeout(()=>map?.invalidateSize(), 250);
    if(which==='envios_flex') setTimeout(()=>mapFlex?.invalidateSize(), 250);
    if(which==='rotas') setTimeout(()=>mapRotas?.invalidateSize(), 250);
    if(which==='motorista') setTimeout(()=>window.resizeCanvas(), 250);
};

window.switchSubTab = function(name){ document.getElementById('subview-fila')?.classList.toggle('hidden', name!=='fila'); document.getElementById('subview-pendencias')?.classList.toggle('hidden', name!=='pendencias'); };
window.toggleMapExpand = function(id) { document.getElementById(id)?.closest('.map-wrapper')?.classList.toggle('expanded-map'); setTimeout(() => { map?.invalidateSize(); mapFlex?.invalidateSize(); mapRotas?.invalidateSize(); }, 300); };
window.changeMapHeight = function(id, delta) { const el=document.getElementById(id); if(!el) return; el.style.height = Math.max(200, el.clientHeight + delta) + 'px'; setTimeout(() => { map?.invalidateSize(); mapFlex?.invalidateSize(); mapRotas?.invalidateSize(); }, 300); };

window.checkOperator = function() { if(!currentOperator) document.getElementById('operatorModal')?.classList.remove('hidden'); else { const el=document.getElementById('activeOperatorDisplay'); if(el) el.innerText=`Op: ${currentOperator}`; } };
window.saveOperator = function() { const n = document.getElementById('operatorNameInput')?.value.trim(); if(n){ localStorage.setItem('vesco_operator', n); currentOperator=n; document.getElementById('operatorModal')?.classList.add('hidden'); document.getElementById('activeOperatorDisplay').innerText=`Op: ${n}`; } };
window.setTodayDate = function() { const t=document.getElementById('topCalendar'); if(t) t.value=new Date(new Date().getTime() - (new Date().getTimezoneOffset()*60000)).toISOString().split('T')[0]; };

document.addEventListener('DOMContentLoaded', () => {
    window.setTodayDate();
    initMap();
    window.checkOperator();
    load();
    setInterval(load, 60000);

    // Setup do Canvas do Motorista
    setTimeout(() => {
        canvas = document.getElementById('signatureCanvas');
        if(canvas) {
            ctx = canvas.getContext('2d');
            const getPos = (e) => { const rect=canvas.getBoundingClientRect(); const clientX=e.touches?e.touches[0].clientX:e.clientX; const clientY=e.touches?e.touches[0].clientY:e.clientY; return { x: clientX - rect.left, y: clientY - rect.top }; };
            const start = (e) => { if (e.cancelable) e.preventDefault(); desenhando = true; const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
            const stop = () => { desenhando = false; if(ctx) ctx.beginPath(); };
            const draw = (e) => { if (!desenhando || !ctx) return; if (e.cancelable) e.preventDefault(); const pos = getPos(e); ctx.lineTo(pos.x, pos.y); ctx.stroke(); ctx.beginPath(); ctx.moveTo(pos.x, pos.y); };
            
            canvas.addEventListener('mousedown', start); canvas.addEventListener('mouseup', stop);
            canvas.addEventListener('mousemove', draw); canvas.addEventListener('mouseleave', stop);
            canvas.addEventListener('touchstart', start, {passive: false}); canvas.addEventListener('touchend', stop, {passive: false});
            canvas.addEventListener('touchmove', draw, {passive: false});
        }
    }, 1000);
});
