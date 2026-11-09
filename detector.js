// Detector YOLO (exportado de ultralytics) en el navegador, con ONNX Runtime Web.
// letterbox, aTensor, decodificar y nms son funciones puras (sin DOM). Replican el preprocesado y el NMS
// de ultralytics: probadas en Node con ONNX Runtime Web contra ultralytics en Python, dan las mismas
// cajas, clases y confianzas (diferencia 0,000 px; ver README).
// El modelo en sí corre en un Web Worker (motor.js) para no congelar la pantalla.

/** Como LetterBox(auto=True) de ultralytics: lado mayor = `lado`, relleno gris centrado a múltiplos de 32. */
export function letterbox(w, h, lado) {
  const r = lado / Math.max(w, h);
  const nw = Math.round(w * r), nh = Math.round(h * r);
  const W = Math.ceil(nw / 32) * 32, H = Math.ceil(nh / 32) * 32;
  return { r, nw, nh, W, H, x0: Math.round((W - nw) / 2 - 0.1), y0: Math.round((H - nh) / 2 - 0.1) };
}

/** RGBA (W*H*4) -> Float32Array CHW en [0, 1], orden RGB. */
export function aTensor(rgba, W, H) {
  const n = W * H, out = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = rgba[j] / 255;
    out[i + n] = rgba[j + 1] / 255;
    out[i + 2 * n] = rgba[j + 2] / 255;
  }
  return out;
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return union > 0 ? inter / union : 0;
}

/** NMS por clase, de mayor a menor confianza (como ultralytics, agnostic=False). */
export function nms(cands, umbralIou = 0.7, maxDet = 100) {
  cands.sort((a, b) => b.conf - a.conf);
  const out = [];
  for (const c of cands) {
    if (out.length >= maxDet) break;
    if (out.every((o) => o.k !== c.k || iou(o.caja, c.caja) <= umbralIou)) out.push(c);
  }
  return out;
}

/**
 * Salida [1, 4+nc, N] de YOLOv8/11/12 -> detecciones en píxeles de la imagen original.
 * clases[k] = "bache", "grieta_..." o null (clase que no se usa, p. ej. Repair).
 * Como ultralytics: la clase es la de mayor puntaje entre todas, y el umbral se aplica a ese puntaje.
 */
export function decodificar(datos, dims, clases, umbrales, lb, ancho, alto, umbralIou = 0.7) {
  const C = dims[1], N = dims[2], nc = C - 4;
  const cands = [];
  for (let i = 0; i < N; i++) {
    let k = 0, s = datos[4 * N + i];
    for (let c = 1; c < nc; c++) {
      const v = datos[(4 + c) * N + i];
      if (v > s) { s = v; k = c; }
    }
    const clase = clases[k];
    if (!clase || s < (clase === 'bache' ? umbrales.bache : umbrales.grieta)) continue;
    const cx = datos[i], cy = datos[N + i], w = datos[2 * N + i], h = datos[3 * N + i];
    const caja = [
      Math.min(ancho, Math.max(0, (cx - w / 2 - lb.x0) / lb.r)),
      Math.min(alto, Math.max(0, (cy - h / 2 - lb.y0) / lb.r)),
      Math.min(ancho, Math.max(0, (cx + w / 2 - lb.x0) / lb.r)),
      Math.min(alto, Math.max(0, (cy + h / 2 - lb.y0) / lb.r)),
    ];
    cands.push({ k, clase, conf: s, caja });
  }
  return nms(cands, umbralIou);
}

async function descargar(url, progreso) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo bajar ${url} (HTTP ${r.status})`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
  const lector = r.body.getReader();
  const partes = [];
  let n = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    partes.push(value);
    n += value.length;
    progreso?.(Math.min(1, n / total));
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of partes) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Lado de la pantalla: arma el cuadro (letterbox), se lo pasa al worker y recibe las detecciones.
 * Así la inferencia, sobre todo en CPU, no congela la pantalla ni el mapa.
 */
export class Detector {
  constructor(worker, meta) {
    this.worker = worker;
    this.meta = meta;
    this.motor = null;   // 'webgpu' o 'wasm'
    this.hilos = 0;
    const n = Math.max(...Object.keys(meta.clases).map(Number)) + 1;
    this.clases = Array.from({ length: n }, (_, k) => meta.clases[String(k)] ?? null);
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.pedidos = new Map();
    this.siguiente = 1;
    this.alAviso = null;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.tipo === 'aviso') { this.alAviso?.(m.texto); return; }
      const p = this.pedidos.get(m.id);
      if (!p) return;
      this.pedidos.delete(m.id);
      if (m.tipo === 'error') p.mal(new Error(m.mensaje)); else p.ok(m);
    };
    worker.onerror = (e) => {
      for (const p of this.pedidos.values()) p.mal(new Error(e.message || 'falló el motor del modelo'));
      this.pedidos.clear();
    };
  }

  llamar(msg, transferir = []) {
    const id = this.siguiente++;
    return new Promise((ok, mal) => {
      this.pedidos.set(id, { ok, mal });
      this.worker.postMessage({ ...msg, id }, transferir);
    });
  }

  /** Baja el modelo y lo abre en el worker: primero la GPU del teléfono (WebGPU) y, si no se puede, la CPU. */
  static async crear(meta, base, { motor = 'auto', hilos = 1, progreso, aviso } = {}) {
    const datos = await descargar(new URL(meta.archivo, base), progreso);
    const worker = new Worker(new URL('./motor.js', import.meta.url), { type: 'module' });
    const det = new Detector(worker, meta);
    det.alAviso = aviso;
    try {
      const r = await det.llamar({
        tipo: 'crear', datos, motor, hilos, clases: det.clases,
        wasmPaths: new URL('./vendor/ort/', import.meta.url).href,
      }, [datos.buffer]);
      det.motor = r.motor;
      det.hilos = r.hilos;
      return det;
    } catch (e) {
      worker.terminate();
      throw e;
    }
  }

  /** Detecta en un <video>, <img> o <canvas>. Devuelve {dets, ms, lb}; las cajas van en píxeles de la fuente. */
  async detectar(fuente, ancho, alto, { lado = 640, umbrales }) {
    const lb = letterbox(ancho, alto, lado);
    const { canvas, ctx } = this;
    if (canvas.width !== lb.W || canvas.height !== lb.H) {
      canvas.width = lb.W;
      canvas.height = lb.H;
    }
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, lb.W, lb.H);
    ctx.drawImage(fuente, lb.x0, lb.y0, lb.nw, lb.nh);
    const rgba = ctx.getImageData(0, 0, lb.W, lb.H).data;
    const r = await this.llamar({ tipo: 'detectar', rgba, lb, umbrales, ancho, alto }, [rgba.buffer]);
    return { dets: r.dets, ms: r.ms, lb };
  }

  liberar() {
    this.worker.terminate();
    for (const p of this.pedidos.values()) p.mal(new Error('modelo liberado'));
    this.pedidos.clear();
  }
}
