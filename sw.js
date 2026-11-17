// Service worker: guarda la app en el teléfono (funciona sin conexión, salvo el mapa) y agrega las
// cabeceras de aislamiento (COOP/COEP) que GitHub Pages no permite configurar: con ellas, ONNX Runtime
// puede usar varios hilos de CPU cuando el teléfono no tiene WebGPU.
// Al publicar una versión nueva, cambiar VERSION para que los teléfonos bajen los archivos nuevos.

const VERSION = 'v6';
const CACHE = `baches-scz-${VERSION}`;
const NUCLEO = [
  './', './index.html', './estilos.css', './app.js', './detector.js', './motor.js', './mapa.js', './almacen.js', './geo.js',
  './manifest.webmanifest', './iconos/icono-192.png', './iconos/icono-512.png',
  './vendor/maplibre/maplibre-gl.mjs', './vendor/maplibre/maplibre-gl-worker.mjs', './vendor/maplibre/maplibre-gl.css',
  './vendor/ort/ort.webgpu.bundle.min.mjs', './modelos/modelos.json', './datos/rutas.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(NUCLEO)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('baches-scz-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function aislada(r) {
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const pedido = e.request;
  const url = new URL(pedido.url);
  // El mapa (OpenFreeMap) y Nominatim van directo a la red.
  if (pedido.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    let r = await cache.match(pedido, { ignoreSearch: true });
    if (!r) {
      r = await fetch(pedido);
      // Modelos (.onnx) y el motor (.wasm) se guardan la primera vez que se usan.
      if (r.ok && r.type === 'basic') cache.put(pedido, r.clone());
    }
    // También los workers (MapLibre y el modelo): en una página aislada, un worker sin estas cabeceras se bloquea.
    return r.type === 'basic' ? aislada(r) : r;
  })());
});
