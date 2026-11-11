// Baches SCZ: cámara o video -> detector en el teléfono -> puntos confirmados en el mapa de Santa Cruz.

import { Detector } from './detector.js';
import { Mapa } from './mapa.js';
import * as almacen from './almacen.js';
import { distancia, prepararRuta, puntoEnRuta, rumbo } from './geo.js';

const $ = (s) => document.querySelector(s);
const BASE = new URL('./', location.href);
// Varios hilos de CPU solo si la página está aislada (lo hace sw.js); si no, uno.
const HILOS = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;

// Las confianzas de partida son las del modelo predeterminado en modelos.json; al cambiar de modelo se
// toman las de ese modelo (las confianzas de modelos distintos no son comparables).
const PREDETERMINADOS = {
  modelo: 'yolo26s_ajustado', soloBaches: false, confBache: 0.1, confGrieta: 0.25, confirmar: true, lado: 640,
  velocidadVideo: 1, posicion: 'gps', ruta: 'r1', kmh: 25, radio: 15, motor: 'auto',
};
// v2: la ubicación real pasó a ser la predeterminada. v3: el YOLO26s ajustado pasó a ser el modelo predeterminado.
const CLAVE_AJUSTES = 'ajustes-v3';
const NOMBRE = {
  bache: 'Bache', grieta: 'Grieta', grieta_longitudinal: 'Grieta longitudinal',
  grieta_transversal: 'Grieta transversal', grieta_cocodrilo: 'Grieta cocodrilo',
};
const CORTO = { bache: 'bache', grieta_longitudinal: 'g. long.', grieta_transversal: 'g. trans.', grieta_cocodrilo: 'g. cocodrilo' };
const COLOR = { bache: '#e53935', grieta: '#fb8c00' };
// Severidad provisional, la misma regla que preview.py del repo del proyecto (área de la caja / área del cuadro).
const PESO_GRIETA = { grieta_longitudinal: 1, grieta_transversal: 1, grieta_cocodrilo: 2 };
const EVENTO_S = 1.0;   // sin verlo más de 1 s, lo siguiente es otro daño

function leerAjustes() {
  try { return { ...PREDETERMINADOS, ...JSON.parse(localStorage.getItem(CLAVE_AJUSTES) || '{}') }; } catch { return { ...PREDETERMINADOS }; }
}
const aj = leerAjustes();
function guardarAjustes() { try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(aj)); } catch { /* sin almacenamiento */ } }

const est = {
  modelos: [], rutas: [], ruta: null, detector: null, detectorId: null, cargando: null,
  corriendo: false, ocupado: false, fuente: null, nombreVideo: '', urlVideo: null, stream: null,
  gps: null, posGps: null, gpsEstado: 'buscando', t0: 0, ultimaPos: '', puntos: [], borrados: new Set(),
  historial: { bache: [], grieta: [] }, evento: { bache: null, grieta: null },
  ms: 0, pantalla: null, instalar: null,
};
let mapa;

/* ---------- Arranque ---------- */

async function iniciar() {
  registrarServiceWorker();
  configurarInstalar();
  mapa = new Mapa('mapa', { alClicPunto: abrirPunto });
  mapa.alDejarDeSeguir = () => { $('#btn-seguir').hidden = false; };
  const contenedor = mapa.map.getContainer();
  contenedor.append($('#btn-seguir'), $('.leyenda'));
  conectarUI();
  try {
    const [modelos, rutas] = await Promise.all([
      fetch('modelos/modelos.json').then((r) => r.json()), fetch('datos/rutas.json').then((r) => r.json()),
    ]);
    est.modelos = modelos.modelos;
    est.rutas = rutas.map((r) => ({ ...r, prep: prepararRuta(r.coords) }));
  } catch (e) {
    aviso(`No se pudieron leer los datos de la app: ${e.message}`, 'error');
  }
  llenarAjustes();
  await cargarPuntos();
  aplicarPosicion();
  setInterval(tick, 300);
}

/**
 * Los puntos quedan guardados en el teléfono (IndexedDB): siguen ahí al actualizar o cerrar la app.
 * Justo al actualizar, la página anterior todavía puede tener la base abierta y la primera lectura vuelve
 * vacía (probado en Chrome/Edge). Por eso se vuelve a leer un momento después, uniendo sin duplicar y sin
 * revivir los puntos que se borraron.
 */
async function cargarPuntos() {
  try { navigator.storage.persist().catch(() => {}); } catch { /* sin la API: igual se guardan */ }   // que no los borre si falta espacio
  let fallo = false;
  const unir = async () => {
    let lista;
    try { lista = await almacen.todos(); fallo = false; } catch { fallo = true; return false; }
    const ids = new Set(est.puntos.map((p) => p.id));
    const nuevos = lista.filter((p) => !ids.has(p.id) && !est.borrados.has(p.id));
    est.puntos.push(...nuevos);
    return nuevos.length > 0;
  };
  await unir();
  if (fallo) aviso('No se pudo abrir el almacenamiento del teléfono', 'error');
  refrescarPuntos();
  for (const ms of [800, 2500, 6000]) {
    setTimeout(async () => { if (await unir()) refrescarPuntos(); }, ms);
  }
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const habiaControl = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e));
  // Cuando toma el control un service worker se recarga una vez: en la primera visita, para tener las
  // cabeceras que habilitan varios hilos de CPU; después, para usar la versión nueva de la app.
  // Si ya eligió cámara o video no se recarga (se aplica la próxima vez que abra la app).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!habiaControl && self.crossOriginIsolated) return;
    let ultima = 0;
    try { ultima = Number(sessionStorage.getItem('recargado') || 0); sessionStorage.setItem('recargado', String(Date.now())); } catch { return; }
    if (Date.now() - ultima > 10000 && !est.fuente) location.reload();
  });
}

function configurarInstalar() {
  const btn = $('#btn-instalar');
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) btn.hidden = true;
  addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); est.instalar = e; });
  addEventListener('appinstalled', () => { btn.hidden = true; aviso('Instalada: ábrela desde el ícono "Baches SCZ"'); });
  btn.addEventListener('click', async () => {
    if (!est.instalar) { $('#dlg-instalar').showModal(); return; }
    est.instalar.prompt();
    const { outcome } = await est.instalar.userChoice;
    est.instalar = null;
    if (outcome === 'accepted') btn.hidden = true;
  });
}

/* ---------- Interfaz ---------- */

function conectarUI() {
  for (const b of document.querySelectorAll('.pestanas button')) b.addEventListener('click', () => cambiarModo(b.dataset.modo));
  $('#btn-camara').addEventListener('click', usarCamara);
  $('#archivo-video').addEventListener('change', (e) => { if (e.target.files[0]) usarVideo(e.target.files[0]); e.target.value = ''; });
  $('#btn-detectar').addEventListener('click', () => (est.corriendo ? detener() : comenzar()));
  $('#btn-ajustes').addEventListener('click', () => $('#dlg-ajustes').showModal());
  $('#chip-pos').addEventListener('click', () => {
    if (aj.posicion === 'gps' && est.gpsEstado !== 'ok') { iniciarGps(true); return; }
    $('#dlg-ajustes').showModal();
  });
  $('#btn-info').addEventListener('click', () => $('#dlg-info').showModal());
  $('#btn-seguir').addEventListener('click', () => { mapa.seguir = true; $('#btn-seguir').hidden = true; est.ultimaPos = ''; });
  $('#btn-geojson').addEventListener('click', exportarGeojson);
  $('#btn-csv').addEventListener('click', exportarCsv);
  $('#archivo-geojson').addEventListener('change', (e) => { if (e.target.files[0]) importarGeojson(e.target.files[0]); e.target.value = ''; });
  $('#btn-borrar').addEventListener('click', borrarTodo);
  const v = $('#video');
  v.addEventListener('ended', () => { if (est.corriendo) { detener(); aviso('Terminó el video'); } });
  for (const el of document.querySelectorAll('[data-ajuste]')) {
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => cambiarAjuste(el));
  }
  addEventListener('resize', () => mapa.redimensionar());
}

function cambiarModo(modo) {
  document.body.classList.remove('modo-recorrido', 'modo-mapa', 'modo-datos');
  document.body.classList.add(`modo-${modo}`);
  for (const b of document.querySelectorAll('.pestanas button')) b.classList.toggle('activa', b.dataset.modo === modo);
  if (modo === 'datos') pintarLista();
  requestAnimationFrame(() => mapa.redimensionar());
}

function llenarAjustes() {
  $('#sel-modelo').innerHTML = est.modelos.map((m) =>
    `<option value="${m.id}">${m.uso === 'cerca' ? 'De cerca' : 'Vehículo'}: ${m.titulo} · ${m.mb} MB</option>`).join('');
  $('#sel-ruta').innerHTML = est.rutas.map((r) => `<option value="${r.id}">${r.nombre} (${r.km} km)</option>`).join('');
  for (const el of document.querySelectorAll('[data-ajuste]')) {
    const v = aj[el.dataset.ajuste];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = el.value === v;
    else el.value = String(v);
  }
  for (const o of document.querySelectorAll('[data-valor]')) o.value = String(aj[o.dataset.valor]);
  infoMotor();
}

function cambiarAjuste(el) {
  const k = el.dataset.ajuste;
  if (el.type === 'radio' && !el.checked) return;
  const valor = el.type === 'checkbox' ? el.checked : (el.type === 'range' || ['lado', 'velocidadVideo'].includes(k)) ? Number(el.value) : el.value;
  aj[k] = valor;
  const meta = k === 'modelo' ? est.modelos.find((m) => m.id === valor) : null;
  if (meta?.conf) {   // cada modelo trae sus confianzas, elegidas en validación
    aj.confBache = meta.conf.bache;
    aj.confGrieta = meta.conf.grieta;
    for (const c of ['confBache', 'confGrieta']) {
      for (const o of document.querySelectorAll(`[data-ajuste="${c}"], [data-valor="${c}"]`)) o.value = String(aj[c]);
    }
  }
  guardarAjustes();
  for (const o of document.querySelectorAll(`[data-valor="${k}"]`)) o.value = String(valor);
  if (k === 'modelo' || k === 'motor') liberarDetector();
  if (k === 'velocidadVideo') $('#video').playbackRate = valor;
  if (['posicion', 'ruta', 'kmh'].includes(k)) aplicarPosicion();
  infoMotor();
}

function infoMotor() {
  const gpu = 'gpu' in navigator ? 'Este navegador tiene WebGPU.' : 'Este navegador no tiene WebGPU: el modelo corre en la CPU.';
  const hilos = HILOS > 1 ? `CPU con ${HILOS} hilos.` : 'CPU con 1 hilo.';
  const actual = est.detector ? ` Modelo cargado en ${est.detector.motor === 'webgpu' ? 'la GPU' : 'la CPU'}.` : '';
  $('#info-motor').textContent = `${gpu} ${hilos}${actual}`;
}

/* ---------- Fuentes de imagen ---------- */

function liberarFuente() {
  detener();
  const v = $('#video');
  if (est.stream) { for (const t of est.stream.getTracks()) t.stop(); est.stream = null; }
  if (est.urlVideo) { URL.revokeObjectURL(est.urlVideo); est.urlVideo = null; }
  v.removeAttribute('src');
  v.srcObject = null;
  limpiarCapa();
  est.fuente = null;
  $('#btn-detectar').disabled = true;
  $('#btn-camara').classList.remove('activo');
}

async function usarCamara() {
  liberarFuente();
  try {
    est.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (e) {
    aviso(`No se pudo abrir la cámara (${e.name}). Revisa el permiso de cámara del navegador.`, 'error');
    return;
  }
  const v = $('#video');
  v.srcObject = est.stream;
  await v.play().catch(() => {});
  est.fuente = 'camara';
  est.nombreVideo = '';
  $('#btn-camara').classList.add('activo');
  fuenteLista();
}

function usarVideo(archivo) {
  liberarFuente();
  const v = $('#video');
  est.urlVideo = URL.createObjectURL(archivo);
  v.src = est.urlVideo;
  v.playbackRate = aj.velocidadVideo;
  est.fuente = 'video';
  est.nombreVideo = archivo.name;
  v.addEventListener('loadeddata', () => { v.currentTime = 0; fuenteLista(); aviso(`Video listo: ${archivo.name}`); }, { once: true });
  v.load();
}

function fuenteLista() {
  $('#vacio').hidden = true;
  $('#btn-detectar').disabled = false;
}

/* ---------- Detector ---------- */

function liberarDetector() {
  if (est.corriendo) detener();
  est.detector?.liberar();
  est.detector = null;
  est.detectorId = null;
}

function progreso(texto, fraccion) {
  const c = $('#carga');
  c.hidden = false;
  c.querySelector('.texto').textContent = texto;
  const barra = c.querySelector('.progreso');
  barra.classList.toggle('indefinido', fraccion == null);
  barra.querySelector('i').style.width = fraccion == null ? '' : `${Math.round(fraccion * 100)}%`;
}

async function asegurarDetector() {
  if (est.detector && est.detectorId === aj.modelo) return est.detector;
  if (est.cargando) return est.cargando;
  const meta = est.modelos.find((m) => m.id === aj.modelo) || est.modelos[0];
  if (!meta) { aviso('No hay modelos en modelos/modelos.json', 'error'); return null; }
  progreso(`Bajando el modelo (${meta.mb} MB, solo la primera vez)…`, 0);
  est.cargando = Detector.crear(meta, new URL('modelos/', BASE), {
    motor: aj.motor, hilos: HILOS,
    progreso: (f) => progreso(`Bajando el modelo (${meta.mb} MB, solo la primera vez)…`, f),
    aviso: (t) => progreso(t, null),
  }).then((d) => {
    est.detector = d;
    est.detectorId = meta.id;
    aviso(`Modelo listo en ${d.motor === 'webgpu' ? 'la GPU del teléfono (WebGPU)' : `la CPU (${d.hilos} hilo${d.hilos > 1 ? 's' : ''})`}`);
    infoMotor();
    return d;
  }).catch((e) => {
    console.error(e);
    aviso(`No se pudo cargar el modelo: ${e.message}`, 'error');
    return null;
  }).finally(() => {
    est.cargando = null;
    $('#carga').hidden = true;
  });
  return est.cargando;
}

async function comenzar() {
  if (!est.fuente || est.corriendo) return;
  const det = await asegurarDetector();
  if (!det || !est.fuente) return;
  est.historial = { bache: [], grieta: [] };
  est.evento = { bache: null, grieta: null };
  est.ms = 0;
  est.t0 = performance.now();
  const v = $('#video');
  if (est.fuente === 'video') {
    v.playbackRate = aj.velocidadVideo;
    if (v.ended) v.currentTime = 0;
    await v.play().catch(() => {});
  }
  if (aj.posicion === 'gps') iniciarGps();
  est.corriendo = true;
  botonDetectar();
  $('#hud').hidden = false;
  $('#hud').textContent = 'Analizando…';
  try { est.pantalla = await navigator.wakeLock?.request('screen'); } catch { /* sin bloqueo de pantalla */ }
  requestAnimationFrame(bucle);
}

function detener() {
  if (!est.corriendo) return;
  est.corriendo = false;
  if (est.fuente === 'video') $('#video').pause();
  est.pantalla?.release?.().catch(() => {});
  est.pantalla = null;
  botonDetectar();
}

function botonDetectar() {
  const b = $('#btn-detectar');
  b.classList.toggle('detener', est.corriendo);
  b.querySelector('span').textContent = est.corriendo ? 'Detener' : 'Detectar';
  b.querySelector('svg').innerHTML = est.corriendo ? '<rect x="6" y="6" width="12" height="12" rx="1"/>' : '<path d="M7 5v14l11-7z"/>';
}

async function bucle() {
  if (!est.corriendo) return;
  const v = $('#video');
  if (!est.ocupado && v.readyState >= 2 && v.videoWidth && !v.paused) {
    est.ocupado = true;
    const t0 = performance.now();
    try {
      const umbrales = { bache: aj.confBache, grieta: aj.soloBaches ? 2 : aj.confGrieta };
      const { dets, lb } = await est.detector.detectar(v, v.videoWidth, v.videoHeight, { lado: aj.lado, umbrales });
      if (est.corriendo) {
        dibujar(dets, v);
        await procesar(dets, v, lb);
        mostrarHud(performance.now() - t0);
      }
    } catch (e) {
      // Si ya se detuvo a propósito (p. ej., al cambiar de modelo en Ajustes), el pedido cortado no es un error.
      if (est.corriendo) {
        console.error(e);
        aviso(`Error al detectar: ${e.message}`, 'error');
        detener();
      }
    }
    est.ocupado = false;
  }
  requestAnimationFrame(bucle);
}

function mostrarHud(ms) {
  est.ms = est.ms ? est.ms * 0.85 + ms * 0.15 : ms;
  const motor = est.detector.motor === 'webgpu' ? 'GPU' : `CPU${est.detector.hilos > 1 ? ` ×${est.detector.hilos}` : ''}`;
  $('#hud').textContent = `${motor} · ${Math.round(est.ms)} ms · ${(1000 / est.ms).toFixed(1)} cuadros/s · ${aj.lado} px`;
}

function limpiarCapa() {
  const c = $('#capa');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

function dibujar(dets, v) {
  const c = $('#capa');
  if (c.width !== v.videoWidth || c.height !== v.videoHeight) { c.width = v.videoWidth; c.height = v.videoHeight; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const letra = Math.max(13, Math.round(c.width / 48));
  g.lineWidth = Math.max(2, c.width / 300);
  g.font = `700 ${letra}px system-ui, sans-serif`;
  for (const d of dets) {
    const col = d.clase === 'bache' ? COLOR.bache : COLOR.grieta;
    const [x1, y1, x2, y2] = d.caja;
    g.strokeStyle = col;
    g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const txt = `${CORTO[d.clase]} ${Math.round(d.conf * 100)}%`;
    const ancho = g.measureText(txt).width + 10, alto = letra + 8;
    const ty = y1 >= alto ? y1 - alto : y1;
    g.fillStyle = col;
    g.fillRect(x1, ty, ancho, alto);
    g.fillStyle = '#fff';
    g.fillText(txt, x1 + 5, ty + alto - 6);
  }
}

/* ---------- Del cuadro al mapa ---------- */

function severidad(d, areaRel) {
  if (d.clase === 'bache') return areaRel > 0.05 ? 'alta' : areaRel > 0.015 ? 'media' : 'baja';
  const puntaje = (PESO_GRIETA[d.clase] || 1) * (1 + areaRel * 10) * d.conf;
  return puntaje >= 3 ? 'alta' : puntaje >= 1.5 ? 'media' : 'baja';
}

/** Recorte del daño, tomado del mismo cuadro que vio el modelo. */
function recorte(d, lb) {
  const src = est.detector.canvas;
  const [x1, y1, x2, y2] = d.caja.map((v, i) => v * lb.r + (i % 2 ? lb.y0 : lb.x0));
  const m = 0.3, w = x2 - x1, h = y2 - y1;
  const sx = Math.max(0, x1 - w * m), sy = Math.max(0, y1 - h * m);
  const sw = Math.min(src.width - sx, w * (1 + 2 * m)), sh = Math.min(src.height - sy, h * (1 + 2 * m));
  const escala = Math.min(1, 220 / Math.max(sw, sh, 1)) * Math.max(1, 120 / Math.max(sw, sh, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * escala));
  c.height = Math.max(1, Math.round(sh * escala));
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.78);
}

async function procesar(dets, v, lb) {
  const ahora = est.fuente === 'video' ? v.currentTime : performance.now() / 1000;
  for (const tipo of ['bache', 'grieta']) {
    if (tipo === 'grieta' && aj.soloBaches) continue;
    const delTipo = dets.filter((d) => (tipo === 'bache' ? d.clase === 'bache' : d.clase.startsWith('grieta')));
    const h = est.historial[tipo];
    h.push(delTipo.length > 0);
    if (h.length > 3) h.shift();
    const confirmado = delTipo.length > 0 && (!aj.confirmar || h.filter(Boolean).length >= 2);
    if (!confirmado) continue;
    const mejor = delTipo.reduce((a, b) => (b.conf > a.conf ? b : a));
    await registrar(tipo, mejor, ahora, v, lb);
  }
}

async function registrar(tipo, d, ahora, v, lb) {
  const pos = posicionActual();
  if (!pos) {
    avisoUnaVez(est.gpsEstado === 'bloqueada'
      ? 'Sin permiso de ubicación no se pueden marcar los daños. Actívalo en el candado junto a la dirección.'
      : 'Esperando tu ubicación para marcar los daños…');
    return;
  }
  const areaRel = ((d.caja[2] - d.caja[0]) * (d.caja[3] - d.caja[1])) / (v.videoWidth * v.videoHeight);
  const sev = severidad(d, areaRel);
  const iso = new Date().toISOString();
  const ev = est.evento[tipo];
  if (ev && ahora >= ev.ultimo && ahora - ev.ultimo <= EVENTO_S) {
    // Sigue el mismo daño: se acerca el vehículo, así que la posición se actualiza.
    ev.ultimo = ahora;
    const p = ev.punto;
    p.cuadros = (p.cuadros || 1) + 1;
    if (ev.nuevo) { p.lon = pos.lon; p.lat = pos.lat; }
    if (d.conf > p.conf) Object.assign(p, { conf: d.conf, subtipo: d.clase, severidad: sev, foto: recorte(d, lb) });
    await guardarPunto(p);
    return;
  }
  // Con un video y la ubicación real, el teléfono no se mueve: unir por distancia juntaría todos los
  // daños del video en un solo punto. Ahí cada daño nuevo es un punto aparte, en tu ubicación.
  const unirCerca = !(est.fuente === 'video' && pos.tipo === 'gps');
  const cerca = unirCerca && est.puntos.find((p) => p.tipo === tipo && distancia([p.lon, p.lat], [pos.lon, pos.lat]) <= aj.radio);
  if (cerca) {
    cerca.veces = (cerca.veces || 1) + 1;
    cerca.ultimaVez = iso;
    if (d.conf > cerca.conf) Object.assign(cerca, { conf: d.conf, subtipo: d.clase, severidad: sev, foto: recorte(d, lb) });
    est.evento[tipo] = { punto: cerca, ultimo: ahora, nuevo: false };
    await guardarPunto(cerca);
    aviso(`${NOMBRE[tipo]} ya marcado: visto ${cerca.veces} veces`, tipo);
    return;
  }
  const p = {
    id: crypto.randomUUID(), tipo, subtipo: d.clase, conf: d.conf, severidad: sev, lon: pos.lon, lat: pos.lat,
    posicion: pos.tipo, precision: pos.precision ?? null, fecha: iso, ultimaVez: iso, veces: 1, cuadros: 1,
    fuente: est.fuente === 'video' ? `video: ${est.nombreVideo}` : 'cámara',
    segundoVideo: est.fuente === 'video' ? Math.round(v.currentTime * 10) / 10 : null,
    modelo: est.detectorId, foto: recorte(d, lb),
  };
  est.puntos.push(p);
  est.evento[tipo] = { punto: p, ultimo: ahora, nuevo: true };
  await guardarPunto(p);
  aviso(`${NOMBRE[d.clase] || NOMBRE[tipo]} ${tipo === 'grieta' ? 'marcada' : 'marcado'} en el mapa · severidad ${sev}`, tipo);
}

let pendiente = null;
async function guardarPunto(p) {
  try { await almacen.guardar(p); } catch (e) { console.error(e); }
  clearTimeout(pendiente);
  pendiente = setTimeout(refrescarPuntos, 250);
}

function refrescarPuntos() {
  mapa.ponerPuntos(est.puntos);
  const b = est.puntos.filter((p) => p.tipo === 'bache').length;
  $('#n-baches').textContent = b;
  $('#n-grietas').textContent = est.puntos.length - b;
  if (document.body.classList.contains('modo-datos')) pintarLista();
}

/* ---------- Posición: simulada o GPS ---------- */

function aplicarPosicion() {
  const ruta = est.rutas.find((r) => r.id === aj.ruta) || est.rutas[0];
  est.ruta = aj.posicion === 'simulada' ? ruta : null;
  mapa.ponerRuta(est.ruta ? est.ruta.coords : null);
  if (aj.posicion === 'gps') iniciarGps(); else detenerGps();
  textoPosicion();
  est.ultimaPos = '';
  mapa.seguir = true;
  $('#btn-seguir').hidden = true;
}

function posicionActual() {
  if (aj.posicion === 'gps') return est.posGps ? { ...est.posGps, tipo: 'gps' } : null;
  if (!est.ruta) return null;
  let t = 0;
  if (est.fuente === 'video') t = $('#video').currentTime;
  else if (est.corriendo) t = (performance.now() - est.t0) / 1000;
  return { ...puntoEnRuta(est.ruta.prep, (aj.kmh / 3.6) * t), tipo: 'simulada', precision: null };
}

function textoPosicion() {
  const chip = $('#chip-pos');
  if (est.ruta) {
    chip.textContent = `Recorrido de prueba · ${est.ruta.corto} · ${aj.kmh} km/h`;
    return;
  }
  chip.textContent = {
    ok: `Tu ubicación · ±${est.posGps?.precision ?? '?'} m`,
    buscando: 'Buscando tu ubicación…',
    bloqueada: 'Ubicación bloqueada · tocar para reintentar',
    sin: 'Este navegador no da ubicación',
  }[est.gpsEstado];
  chip.classList.toggle('alerta', est.gpsEstado === 'bloqueada' || est.gpsEstado === 'sin');
}

/** Pide la ubicación real (el navegador muestra el permiso la primera vez) y la sigue en vivo. */
function iniciarGps(reintento = false) {
  if (!('geolocation' in navigator)) { est.gpsEstado = 'sin'; textoPosicion(); return; }
  if (est.gps != null) return;
  if (est.gpsEstado !== 'ok') est.gpsEstado = 'buscando';
  textoPosicion();
  est.gps = navigator.geolocation.watchPosition((p) => {
    const nueva = [p.coords.longitude, p.coords.latitude];
    const previa = est.posGps;
    const r = Number.isFinite(p.coords.heading) ? p.coords.heading
      : previa && distancia([previa.lon, previa.lat], nueva) > 3 ? rumbo([previa.lon, previa.lat], nueva) : previa?.rumbo ?? null;
    const primera = est.gpsEstado !== 'ok';
    est.posGps = { lon: nueva[0], lat: nueva[1], precision: Math.round(p.coords.accuracy), rumbo: r };
    est.gpsEstado = 'ok';
    textoPosicion();
    if (primera) aviso('Ubicación lista: los daños se marcan donde estás');
  }, (e) => {
    if (e.code === e.PERMISSION_DENIED) {
      est.gpsEstado = 'bloqueada';
      if (est.gps != null) navigator.geolocation.clearWatch(est.gps);
      est.gps = null;
      textoPosicion();
      aviso('Sin permiso de ubicación no se pueden marcar los daños. Actívalo en el candado junto a la dirección y toca el aviso de ubicación.', 'error');
    } else if (est.gpsEstado !== 'ok') {
      avisoUnaVez('Todavía no hay señal de ubicación. Al aire libre llega en unos segundos.');
    }
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  if (reintento) aviso('Pidiendo la ubicación otra vez…');
}

function detenerGps() {
  if (est.gps != null) navigator.geolocation.clearWatch(est.gps);
  est.gps = null;
  est.posGps = null;
  est.gpsEstado = 'buscando';
}

function tick() {
  const pos = posicionActual();
  const clave = pos ? `${pos.lon.toFixed(6)},${pos.lat.toFixed(6)}` : '';
  if (clave === est.ultimaPos) return;
  est.ultimaPos = clave;
  mapa.moverVehiculo(pos);
}

/* ---------- Puntos: ver, listar, exportar ---------- */

const fmtFecha = (iso) => new Date(iso).toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' });
const pct = (x) => `${Math.round(x * 100)} %`;

function abrirPunto(id) {
  const p = est.puntos.find((q) => q.id === id);
  if (!p) return;
  const el = document.createElement('div');
  el.className = 'popup';
  el.innerHTML = `
    ${p.foto ? `<img alt="Recorte del daño" src="${p.foto}">` : ''}
    <b>${NOMBRE[p.subtipo] || NOMBRE[p.tipo]} · severidad ${p.severidad}</b>
    <span class="meta">Confianza ${pct(p.conf)} · visto ${p.veces} ${p.veces === 1 ? 'vez' : 'veces'}</span>
    <span class="meta">${fmtFecha(p.fecha)} · ${p.fuente}${p.segundoVideo != null ? ` (seg. ${p.segundoVideo})` : ''}</span>
    ${p.posicion === 'simulada' ? '<span class="aviso-sim">Recorrido de prueba: no es la ubicación real del daño</span>'
      : `<span class="meta">GPS ± ${p.precision ?? '?'} m</span>`}
    <span class="meta calle">${p.calle ? `Calle: ${p.calle}` : 'Buscando la calle…'}</span>
    <button type="button">Borrar este punto</button>`;
  el.querySelector('button').addEventListener('click', async () => {
    est.puntos = est.puntos.filter((q) => q.id !== p.id);
    est.borrados.add(p.id);
    await almacen.borrar(p.id);
    mapa.popup.remove();
    refrescarPuntos();
  });
  mapa.mostrarPopup(p, el);
  if (!p.calle) buscarCalle(p).then((c) => { el.querySelector('.calle').textContent = c ? `Calle: ${c}` : 'Calle: sin dato'; });
}

let ultimaConsulta = 0;
async function buscarCalle(p) {
  // Nominatim (OpenStreetMap) pide como máximo una consulta por segundo: solo se consulta al abrir un punto.
  const espera = 1100 - (Date.now() - ultimaConsulta);
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaConsulta = Date.now();
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p.lat}&lon=${p.lon}&zoom=17&accept-language=es`);
    const j = await r.json();
    const a = j.address || {};
    p.calle = a.road || a.pedestrian || a.neighbourhood || a.suburb || j.display_name || null;
    if (p.calle) await almacen.guardar(p);
    return p.calle;
  } catch {
    return null;
  }
}

function pintarLista() {
  const ul = $('#lista');
  const lista = [...est.puntos].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
  const b = lista.filter((p) => p.tipo === 'bache').length;
  $('#resumen-datos').textContent = lista.length
    ? `${lista.length} puntos: ${b} baches y ${lista.length - b} grietas. Toca uno para verlo en el mapa.`
    : '';
  if (!lista.length) {
    ul.innerHTML = '<li class="vacio-lista" style="display:block;cursor:default">Todavía no hay puntos. Ve a <b>Recorrido</b> y toca <b>Detectar</b>.</li>';
    return;
  }
  ul.innerHTML = '';
  for (const p of lista) {
    const li = document.createElement('li');
    li.innerHTML = `
      ${p.foto ? `<img alt="" src="${p.foto}">` : '<img alt="">'}
      <div>
        <div class="titulo">${NOMBRE[p.subtipo] || NOMBRE[p.tipo]} <span class="sev ${p.severidad}">${p.severidad}</span></div>
        <div class="meta">${pct(p.conf)} · visto ${p.veces}× · ${fmtFecha(p.fecha)}</div>
        <div class="meta">${p.calle ? p.calle + ' · ' : ''}${p.fuente}${p.posicion === 'simulada' ? ' · recorrido de prueba' : ''}</div>
      </div>`;
    li.addEventListener('click', () => { cambiarModo('mapa'); mapa.irA(p); setTimeout(() => abrirPunto(p.id), 600); });
    ul.append(li);
  }
}

function bajar(blob, nombre) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
const sello = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

function exportarGeojson() {
  if (!est.puntos.length) { aviso('No hay puntos para exportar'); return; }
  const fc = {
    type: 'FeatureCollection',
    features: est.puntos.map(({ foto, lon, lat, ...props }) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props,
    })),
  };
  bajar(new Blob([JSON.stringify(fc, null, 1)], { type: 'application/geo+json' }), `baches_scz_${sello()}.geojson`);
}

function exportarCsv() {
  if (!est.puntos.length) { aviso('No hay puntos para exportar'); return; }
  const cols = ['id', 'tipo', 'subtipo', 'severidad', 'conf', 'lat', 'lon', 'posicion', 'precision', 'fecha', 'veces', 'fuente', 'segundoVideo', 'modelo', 'calle'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const filas = [cols.join(','), ...est.puntos.map((p) => cols.map((c) => esc(p[c])).join(','))];
  bajar(new Blob(['﻿' + filas.join('\n')], { type: 'text/csv' }), `baches_scz_${sello()}.csv`);
}

async function importarGeojson(archivo) {
  try {
    const fc = JSON.parse(await archivo.text());
    let n = 0;
    for (const f of fc.features || []) {
      if (f?.geometry?.type !== 'Point') continue;
      const [lon, lat] = f.geometry.coordinates;
      const pr = f.properties || {};
      const tipo = pr.tipo === 'grieta' ? 'grieta' : 'bache';
      const p = {
        severidad: 'baja', conf: 0, veces: 1, fuente: `importado: ${archivo.name}`, posicion: 'importada', fecha: new Date().toISOString(),
        ...pr, tipo, subtipo: pr.subtipo || tipo, lon: Number(lon), lat: Number(lat), id: crypto.randomUUID(),
      };
      if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) continue;
      est.puntos.push(p);
      await almacen.guardar(p);
      n++;
    }
    refrescarPuntos();
    mapa.encuadrar(est.puntos);
    aviso(`Importados ${n} puntos`);
  } catch (e) {
    aviso(`No se pudo leer el archivo: ${e.message}`, 'error');
  }
}

async function borrarTodo() {
  if (!est.puntos.length || !confirm(`¿Borrar los ${est.puntos.length} puntos de este teléfono?`)) return;
  for (const p of est.puntos) est.borrados.add(p.id);
  await almacen.borrarTodo();
  est.puntos = [];
  refrescarPuntos();
  aviso('Se borraron todos los puntos');
}

/* ---------- Avisos ---------- */

function aviso(texto, tipo = '') {
  const el = document.createElement('div');
  el.className = `aviso ${tipo}`;
  el.textContent = texto;
  $('#avisos').append(el);
  while ($('#avisos').children.length > 3) $('#avisos').firstChild.remove();
  setTimeout(() => el.classList.add('fuera'), 2800);
  setTimeout(() => el.remove(), 3300);
}
const dichos = new Set();
function avisoUnaVez(texto) { if (!dichos.has(texto)) { dichos.add(texto); aviso(texto); } }

iniciar();
