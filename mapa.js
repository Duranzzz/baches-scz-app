// Mapa de Santa Cruz: MapLibre GL JS con teselas vectoriales de OpenFreeMap (datos © OpenStreetMap).

import * as maplibregl from './vendor/maplibre/maplibre-gl.mjs';

const ESTILO = 'https://tiles.openfreemap.org/styles/liberty';
const SCZ = [-63.1821, -17.7833];
const VACIO = { type: 'FeatureCollection', features: [] };
export const COLOR = { bache: '#e53935', grieta: '#fb8c00' };

export class Mapa {
  constructor(contenedor, { alClicPunto } = {}) {
    this.alClicPunto = alClicPunto;
    this.seguir = true;
    this.map = new maplibregl.Map({
      container: contenedor, style: ESTILO, center: SCZ, zoom: 12.4, maxPitch: 60,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.listo = new Promise((ok) => this.map.on('load', ok)).then(() => this.capas());
    this.map.on('dragstart', () => { this.seguir = false; this.alDejarDeSeguir?.(); });

    const el = document.createElement('div');
    el.className = 'vehiculo';
    el.innerHTML = '<div class="flecha"></div>';
    this.vehiculo = new maplibregl.Marker({ element: el, rotationAlignment: 'map' });
    this.popup = new maplibregl.Popup({ maxWidth: '270px', offset: 12 });
  }

  capas() {
    const m = this.map;
    m.addSource('ruta', { type: 'geojson', data: VACIO });
    m.addLayer({
      id: 'ruta', type: 'line', source: 'ruta', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#1e88e5', 'line-width': 5, 'line-opacity': 0.35 },
    });
    m.addSource('puntos', {
      type: 'geojson', data: VACIO, cluster: true, clusterRadius: 34, clusterMaxZoom: 15,
      clusterProperties: { baches: ['+', ['case', ['==', ['get', 'tipo'], 'bache'], 1, 0]] },
    });
    m.addLayer({
      id: 'grupos', type: 'circle', source: 'puntos', filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['case', ['>', ['get', 'baches'], 0], COLOR.bache, COLOR.grieta],
        'circle-radius': ['step', ['get', 'point_count'], 15, 10, 19, 50, 24],
        'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff', 'circle-opacity': 0.9,
      },
    });
    m.addLayer({
      id: 'grupos-n', type: 'symbol', source: 'puntos', filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['Noto Sans Bold'], 'text-size': 13 },
      paint: { 'text-color': '#ffffff' },
    });
    m.addLayer({
      id: 'puntos', type: 'circle', source: 'puntos', filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': ['match', ['get', 'tipo'], 'bache', COLOR.bache, COLOR.grieta],
        'circle-radius': ['match', ['get', 'severidad'], 'alta', 11, 'media', 8.5, 6.5],
        'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff',
      },
    });
    m.on('click', 'puntos', (e) => this.alClicPunto?.(e.features[0].properties.id));
    m.on('click', 'grupos', async (e) => {
      const f = e.features[0];
      const zoom = await m.getSource('puntos').getClusterExpansionZoom(f.properties.cluster_id);
      m.easeTo({ center: f.geometry.coordinates, zoom });
    });
    for (const capa of ['puntos', 'grupos']) {
      m.on('mouseenter', capa, () => { m.getCanvas().style.cursor = 'pointer'; });
      m.on('mouseleave', capa, () => { m.getCanvas().style.cursor = ''; });
    }
  }

  async ponerPuntos(puntos) {
    await this.listo;
    this.map.getSource('puntos').setData({
      type: 'FeatureCollection',
      features: puntos.map((p) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { id: p.id, tipo: p.tipo, severidad: p.severidad },
      })),
    });
  }

  async ponerRuta(coords) {
    await this.listo;
    this.map.getSource('ruta').setData(coords ? {
      type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {},
    } : VACIO);
  }

  moverVehiculo(pos) {
    if (!pos) { this.vehiculo.remove(); return; }
    this.vehiculo.setLngLat([pos.lon, pos.lat]).setRotation(pos.rumbo ?? 0);
    if (!this.vehiculo._map) this.vehiculo.addTo(this.map);
    this.vehiculo.getElement().classList.toggle('sin-rumbo', pos.rumbo == null);
    if (this.seguir) this.map.easeTo({ center: [pos.lon, pos.lat], zoom: Math.max(this.map.getZoom(), 15.5), duration: 400 });
  }

  encuadrar(puntos) {
    if (!puntos.length) return;
    if (puntos.length === 1) { this.map.flyTo({ center: [puntos[0].lon, puntos[0].lat], zoom: 17 }); return; }
    const lons = puntos.map((p) => p.lon), lats = puntos.map((p) => p.lat);
    this.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 60, maxZoom: 17 });
  }

  mostrarPopup(p, html) {
    this.popup.setLngLat([p.lon, p.lat]).setDOMContent(html).addTo(this.map);
  }

  irA(p) {
    this.seguir = false;
    this.map.flyTo({ center: [p.lon, p.lat], zoom: 17.5 });
  }

  redimensionar() { this.map.resize(); }
}
