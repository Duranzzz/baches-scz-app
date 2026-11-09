// Puntos guardados en el teléfono (IndexedDB). Nada sale del teléfono salvo que se exporte.

const BASE = 'baches-scz';
const TABLA = 'puntos';
let db;

function abrir() {
  if (db) return Promise.resolve(db);
  return new Promise((ok, mal) => {
    const pedido = indexedDB.open(BASE, 1);
    pedido.onupgradeneeded = () => pedido.result.createObjectStore(TABLA, { keyPath: 'id' });
    pedido.onsuccess = () => { db = pedido.result; ok(db); };
    pedido.onerror = () => mal(pedido.error);
  });
}

function hacer(modo, accion) {
  return abrir().then((d) => new Promise((ok, mal) => {
    const tx = d.transaction(TABLA, modo);
    const r = accion(tx.objectStore(TABLA));
    tx.oncomplete = () => ok(r?.result);
    tx.onerror = () => mal(tx.error);
  }));
}

export const todos = () => hacer('readonly', (t) => t.getAll());
export const guardar = (p) => hacer('readwrite', (t) => t.put(p));
export const borrar = (id) => hacer('readwrite', (t) => t.delete(id));
export const borrarTodo = () => hacer('readwrite', (t) => t.clear());
