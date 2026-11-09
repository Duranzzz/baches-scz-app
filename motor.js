// Worker del modelo: ONNX Runtime Web fuera del hilo de la pantalla.
// Recibe el cuadro ya armado (RGBA con letterbox) y devuelve las detecciones.

import * as ort from './vendor/ort/ort.webgpu.bundle.min.mjs';
import { aTensor, decodificar } from './detector.js';

let sesion = null;
let clases = [];

async function hayWebGPU() {
  if (!('gpu' in navigator)) return false;
  try { return !!(await navigator.gpu.requestAdapter()); } catch { return false; }
}

async function crear(m) {
  ort.env.wasm.wasmPaths = m.wasmPaths;
  ort.env.wasm.numThreads = m.hilos;
  clases = m.clases;
  const motores = m.motor === 'cpu' ? ['wasm'] : ['webgpu', 'wasm'];
  let error = null;
  for (const ep of motores) {
    if (ep === 'webgpu' && !(await hayWebGPU())) continue;
    try {
      self.postMessage({ tipo: 'aviso', texto: ep === 'webgpu' ? 'Preparando la GPU del teléfono…' : 'Preparando el modelo en la CPU…' });
      sesion = await ort.InferenceSession.create(m.datos, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      return { motor: ep, hilos: ep === 'wasm' ? m.hilos : 0 };
    } catch (e) {
      error = e;
    }
  }
  throw error ?? new Error('Este navegador no puede correr el modelo');
}

async function detectar(m) {
  const t0 = performance.now();
  const { W, H } = m.lb;
  const entrada = new ort.Tensor('float32', aTensor(m.rgba, W, H), [1, 3, H, W]);
  const res = await sesion.run({ [sesion.inputNames[0]]: entrada });
  const salida = res[sesion.outputNames[0]];
  const dets = decodificar(salida.data, salida.dims, clases, m.umbrales, m.lb, m.ancho, m.alto);
  entrada.dispose?.();
  salida.dispose?.();
  return { dets, ms: performance.now() - t0 };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    const r = m.tipo === 'crear' ? await crear(m) : await detectar(m);
    self.postMessage({ tipo: 'ok', id: m.id, ...r });
  } catch (err) {
    self.postMessage({ tipo: 'error', id: m.id, mensaje: String(err?.message || err) });
  }
};
