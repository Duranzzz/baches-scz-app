// Geometría sobre la Tierra (lon, lat en grados) y recorrido simulado sobre una ruta.

const R = 6371008.8;
const rad = (g) => (g * Math.PI) / 180;

/** Distancia en metros entre [lon, lat] y [lon, lat]. */
export function distancia(a, b) {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Rumbo en grados (0 = norte, 90 = este) de a hacia b. */
export function rumbo(a, b) {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x = Math.cos(rad(a[1])) * Math.sin(rad(b[1])) - Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Prepara una ruta [[lon, lat], ...] para recorrerla: distancias acumuladas y largo total. */
export function prepararRuta(coords) {
  const acum = [0];
  for (let i = 1; i < coords.length; i++) acum.push(acum[i - 1] + distancia(coords[i - 1], coords[i]));
  return { coords, acum, largo: acum[acum.length - 1] };
}

/**
 * Posición tras recorrer `d` metros. Al llegar al final vuelve por el mismo camino (ida y vuelta),
 * así el recorrido simulado nunca salta.
 */
export function puntoEnRuta(ruta, d) {
  const { coords, acum, largo } = ruta;
  if (!largo) return { lon: coords[0][0], lat: coords[0][1], rumbo: 0 };
  let m = d % (2 * largo);
  let vuelta = false;
  if (m > largo) { m = 2 * largo - m; vuelta = true; }
  let i = 1;
  while (i < acum.length - 1 && acum[i] < m) i++;
  const a = coords[i - 1], b = coords[i];
  const tramo = acum[i] - acum[i - 1] || 1;
  const f = (m - acum[i - 1]) / tramo;
  const lon = a[0] + (b[0] - a[0]) * f, lat = a[1] + (b[1] - a[1]) * f;
  return { lon, lat, rumbo: vuelta ? rumbo(b, a) : rumbo(a, b) };
}
