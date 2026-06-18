/**
 * ROTEIRIZADOR VESCO - Módulo Integrado OSRM + Inteligência K-Means
 */

// CORREÇÃO: Variáveis globais essenciais que faltavam
let routeSelection = new Set();
let routeEligible = [];
let mapRotas = null;
let routingControl = null;
let markersRotasLayer = null;
let clustersSugeridos = []; // Guarda as rotas geradas pela IA

// Inicializa o mapa da aba de rotas
function initMapRotas() {
  if (mapRotas) return;
  mapRotas = L.map('map-rotas').setView([-23.55052, -46.633308], 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', { 
    attribution: '&copy; CartoDB', 
    maxZoom: 19 
  }).addTo(mapRotas);
  
  markersRotasLayer = L.layerGroup().addTo(mapRotas);
}

// Renderiza a Tabela (Corrigido para ler o escopo global corretamente)
function renderRotas() {
  const tbodyRotas = document.getElementById('table-rotas');
  if (!tbodyRotas) return;

  // REMOVIDO o "window." que estava bloqueando a leitura dos pedidos
  routeEligible = [...(typeof orders !== 'undefined' ? orders : []), ...(typeof flexOrders !== 'undefined' ? flexOrders : [])].filter(o => 
    String(o.status_logistica || o.situacao_nome || '').toLowerCase() !== 'entregue' && 
    String(o.numero || '').trim() !== ''
  );

  tbodyRotas.innerHTML = routeEligible.map(o => {
    const id = String(o.id || o.numero);
    const checked = routeSelection.has(id) ? 'checked' : '';
    // Adiciona uma tag visual se o pedido for Flex
    const isFlex = (o.situacao_nome !== undefined || String(o.nomeformafenvio || '').toLowerCase().includes('flex')) ? '<span class="text-[9px] bg-amber-100 text-amber-700 px-1 py-0.5 rounded ml-1">FLEX</span>' : '';

    return `
      <tr class="border-b cursor-pointer hover:bg-slate-50 ${checked ? 'bg-purple-50' : ''}" onclick="toggleRouteOrder('${id}')">
        <td class="p-2 text-center"><input type="checkbox" ${checked} onclick="event.stopPropagation(); toggleRouteOrder('${id}')"></td>
        <td class="p-2 text-xs font-bold text-slate-800">#${escapeHtml(o.numero)} ${isFlex}</td>
        <td class="p-2 text-xs text-slate-700 font-medium">${escapeHtml(o.cliente_nome)}<br><span class="text-[10px] text-slate-400 font-normal">${escapeHtml(o.endereco_completo || '')}</span></td>
        <td class="p-2 text-[10px] text-slate-500 text-right uppercase tracking-wider">${escapeHtml(o.status_logistica || o.situacao_nome || '')}</td>
      </tr>`;
  }).join('');
  
  const countEl = document.getElementById('rota-count');
  if(countEl) countEl.innerText = routeSelection.size;
  
  plotRotasMap(); 
}

// Funções de Controle da UI
window.toggleRouteOrder = (id) => {
  routeSelection.has(String(id)) ? routeSelection.delete(String(id)) : routeSelection.add(String(id));
  renderRotas();
};

window.selectAllRoute = () => {
  routeEligible.forEach(o => routeSelection.add(String(o.id || o.numero)));
  renderRotas();
};

window.clearRouteSelection = () => {
  routeSelection.clear();
  clustersSugeridos = []; // Limpa rotas geradas
  if (routingControl) {
    mapRotas.removeControl(routingControl);
    routingControl = null;
  }
  renderRotas();
};

// Plota Pinos Selecionados no Mapa
function plotRotasMap() {
  initMapRotas();
  markersRotasLayer.clearLayers();

  const selecionados = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
  const bounds = [];

  selecionados.forEach(item => {
    // Usa o getCoords que já existe no seu app.js
    const coords = typeof getCoords === 'function' ? getCoords(item) : null; 
    if (coords && coords.lat && coords.lon) {
      const isFlex = item.situacao_nome !== undefined;
      const cor = isFlex ? '#eab308' : '#9333ea'; // Amarelo para Flex, Roxo para ERP
      
      const icon = L.divIcon({ 
        html: createPinSVG(cor, 28), 
        className: '', iconSize: [28,28], iconAnchor: [14,28] 
      });
      const m = L.marker([coords.lat, coords.lon], { icon }).bindPopup(`<b>#${item.numero}</b><br>${item.cliente_nome}`);
      markersRotasLayer.addLayer(m);
      bounds.push([coords.lat, coords.lon]);
    }
  });

  if (bounds.length > 0) {
    mapRotas.fitBounds(bounds, { padding: [30, 30] });
  }
}

// =====================================================================
// MOTOR DE INTELIGÊNCIA LOGÍSTICA (K-MEANS + NEAREST NEIGHBOR)
// =====================================================================

// 1. Vizinho Mais Próximo (Para ordenar as rotas curtas)
function otimizarPontosNearestNeighbor(pontos) {
  if (pontos.length <= 2) return pontos;
  let naoVisitados = [...pontos];
  let rotaOtimizada = [];
  
  let atual = naoVisitados.shift();
  rotaOtimizada.push(atual);

  while (naoVisitados.length > 0) {
    let maisProximoIndex = 0;
    let menorDistancia = Infinity;
    for (let i = 0; i < naoVisitados.length; i++) {
      let dx = atual.lat - naoVisitados[i].lat;
      let dy = atual.lon - naoVisitados[i].lon;
      let dist = (dx * dx) + (dy * dy);
      if (dist < menorDistancia) { menorDistancia = dist; maisProximoIndex = i; }
    }
    atual = naoVisitados.splice(maisProximoIndex, 1)[0];
    rotaOtimizada.push(atual);
  }
  return rotaOtimizada;
}

// 2. Inteligência de Separação de Rotas (Mista: 1 Moto + 3 Carros)
window.sugerirRotasInteligentes = () => {
  // Sua frota atual cravada
  const quantVeiculos = 4; 

  let pedidosComCoords = routeEligible.map(o => {
    const c = typeof getCoords === 'function' ? getCoords(o) : null;
    return c ? { 
      id: String(o.id || o.numero), 
      lat: c.lat, 
      lon: c.lon, 
      isFlex: (o.situacao_nome !== undefined || String(o.nomeformafenvio || '').toLowerCase().includes('flex')),
      data: o 
    } : null;
  }).filter(c => c !== null);

  if (pedidosComCoords.length < quantVeiculos) {
    return alert("Aguarde a geocodificação ou adicione mais pedidos. Total atual menor que a frota.");
  }

  // Lógica de agrupamento por região (K-Means)
  let centroides = [];
  let embaralhados = [...pedidosComCoords].sort(() => 0.5 - Math.random());
  for(let i=0; i<quantVeiculos; i++) centroides.push({lat: embaralhados[i].lat, lon: embaralhados[i].lon});

  let clusters = Array.from({length: quantVeiculos}, () => []);
  
  for(let iteracao = 0; iteracao < 5; iteracao++) {
    clusters = Array.from({length: quantVeiculos}, () => []);
    
    pedidosComCoords.forEach(p => {
      let menorDist = Infinity;
      let clusterIndex = 0;
      centroides.forEach((c, idx) => {
        let dist = Math.pow(p.lat - c.lat, 2) + Math.pow(p.lon - c.lon, 2);
        // Bônus: A Rota 0 (Moto) "puxa" com mais força os pedidos Flex
        if(idx === 0 && p.isFlex) dist = dist * 0.4; 

        if(dist < menorDist) { menorDist = dist; clusterIndex = idx; }
      });
      clusters[clusterIndex].push(p);
    });

    centroides = clusters.map(cluster => {
      if(cluster.length === 0) return centroides[0];
      let sumLat = cluster.reduce((sum, p) => sum + p.lat, 0);
      let sumLon = cluster.reduce((sum, p) => sum + p.lon, 0);
      return { lat: sumLat/cluster.length, lon: sumLon/cluster.length };
    });
  }

  // Exibe as opções de frota para você escolher qual traçar agora
  const escolha = prompt(
    `MAPA DIVIDIDO PARA SUA FROTA (1 Moto, 3 Carros)\n\n` +
    `Escolha qual rota enviar para a mesa de separação:\n` +
    `[1] MOTO: ${clusters[0].length} pedidos (Foco em Flex/Agilidade)\n` +
    `[2] CARRO A: ${clusters[1].length} pedidos (Geografia 1)\n` +
    `[3] CARRO B: ${clusters[2].length} pedidos (Geografia 2)\n` +
    `[4] CARRO C: ${clusters[3].length} pedidos (Geografia 3)\n\n` +
    `Digite o número da rota (1 a 4):`, "1"
  );

  const idxEscolhido = parseInt(escolha) - 1;
  
  if(idxEscolhido >= 0 && idxEscolhido < 4 && clusters[idxEscolhido]) {
    routeSelection.clear();
    clusters[idxEscolhido].forEach(p => routeSelection.add(p.id));
    renderRotas();
    alert(`Veículo selecionado! Clique em "Traçar Rota no Painel" para visualizar o roteiro no mapa.`);
  }
};

// =====================================================================
// TRAÇADO DA ROTA (OSRM)
// =====================================================================
window.tracarRotaInterna = () => {
  initMapRotas();
  
  const selecionados = routeEligible.filter(o => routeSelection.has(String(o.id || o.numero)));
  if(selecionados.length < 2) return alert('Selecione ao menos 2 pedidos para criar uma rota.');

  let waypointsRaw = selecionados.map(o => {
    const c = typeof getCoords === 'function' ? getCoords(o) : null;
    return c ? { lat: c.lat, lon: c.lon, num: o.numero } : null;
  }).filter(c => c !== null);

  if(waypointsRaw.length < 2) return alert('Aguarde os endereços serem convertidos em coordenadas antes de traçar.');

  // Otimiza a ordem internamente
  const waypointsOtimizados = otimizarPontosNearestNeighbor(waypointsRaw);
  const leafletWaypoints = waypointsOtimizados.map(p => L.latLng(p.lat, p.lon));

  // Remove rota anterior se houver
  if (routingControl) mapRotas.removeControl(routingControl);

  // Desenha a linha azul pelas ruas
  routingControl = L.Routing.control({
    waypoints: leafletWaypoints,
    routeWhileDragging: false,
    addWaypoints: false,
    fitSelectedRoutes: true,
    lineOptions: { styles: [{color: '#2563eb', opacity: 0.8, weight: 6}] },
    createMarker: function() { return null; }, 
    show: false, // Tenta esconder por padrão
    language: 'pt-BR'
  }).addTo(mapRotas);

  // Garante que o botão de "Obter Informações" fique visível
  const btnInfo = document.getElementById('btn-info-rota');
  if(btnInfo) btnInfo.classList.remove('hidden');

  // FORÇA o painel a sumir assim que o Leaflet injetar ele no HTML
  setTimeout(() => {
    const painel = document.querySelector('.leaflet-routing-container');
    if (painel) {
      painel.style.display = 'none'; // Esconde na marra
    }
  }, 100); 
}; // <--- O ERRO ESTAVA AQUI! Essa chave com ponto e vírgula tinha sumido.
// Puxa a função SVG que já existe no app.js, se não existir cria um fallback
// Substitua a função createPinSVG no final do rotas.js por esta:
function createPinSVG(color='#eab308', size=28){
  const inner = Math.max(8, Math.round(size * 0.35));
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8.686 2 6 4.686 6 8c0 4.418 6 12 6 12s6-7.582 6-12c0-3.314-2.686-6-6-6z" fill="${color}" stroke="#ffff" stroke-width="1.2"/><circle cx="12" cy="8" r="${inner/4}" fill="#fff" /></svg>`;
}
// Função para ocultar/mostrar o painel de texto da rota
window.toggleInstrucoesRota = () => {
  // Pega a caixa padrão que o Leaflet gera
  const painelInstrucoes = document.querySelector('.leaflet-routing-container');
  
  if (painelInstrucoes) {
    // Se estiver oculto, mostra. Se estiver visível, oculta.
    if (painelInstrucoes.style.display === 'none' || painelInstrucoes.style.display === '') {
      painelInstrucoes.style.display = 'block';
    } else {
      painelInstrucoes.style.display = 'none';
    }
  } else {
    alert("Nenhuma rota traçada no momento.");
  }
};