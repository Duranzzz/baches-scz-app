# Baches SCZ

App web que detecta **baches y grietas** con la cámara del celular (o con un video de prueba) y los marca
en el **mapa de Santa Cruz de la Sierra**. El modelo de IA corre **dentro del teléfono**: no hay servidor
y no se sube video.

**Abrir:** https://duranzzz.github.io/baches-scz-app/

Proyecto del 2.º parcial de Inteligencia Artificial (UCB). El código de los modelos, la evaluación y el
entrenamiento está en un repositorio aparte.

## Cómo se usa

1. **Recorrido**: permitir la **ubicación**, elegir **Cámara** (trasera) o **Video** (un archivo del
   teléfono) y tocar **Detectar**. Cada daño se dibuja sobre la imagen. Cuando aparece en 2 de 3 cuadros
   seguidos, se vuelve al instante un punto en el mapa, en tu ubicación, y queda guardado en el teléfono.
2. **Mapa**: los puntos (rojo = bache, naranja = grieta; más grande = más severo). Al tocar uno se ve el
   recorte del daño, la confianza, cuántas veces se vio y la calle.
3. **Datos**: la lista de puntos, y **Exportar GeoJSON / CSV** (se abren en QGIS, Google Earth o My Maps).
4. **Descargar app**: la instala en el teléfono como una app (es la misma página; ver abajo).

En **Ajustes** (⚙) se elige el modelo, las confianzas mínimas y la resolución de análisis. Ahí también
está el **recorrido de prueba**: en vez del GPS, un vehículo virtual recorre una ruta real de Santa Cruz a
la velocidad elegida, para probar videos sin moverse. Por defecto se usa la ubicación real.

Con un video y la ubicación real, el teléfono no se mueve: cada daño nuevo es un punto aparte en tu
ubicación (no se unen por cercanía).

### Instalar

- **Android (Chrome):** botón **Descargar app**, o menú ⋮ → **Instalar app**.
- **iPhone (Safari):** Compartir → **Agregar a inicio**.

Queda un ícono, abre a pantalla completa y funciona sin conexión, salvo el mapa. La primera vez baja el
modelo (38 MB) y el motor (29 MB); conviene hacerlo con wifi.

## Cómo funciona

```
cámara o video ─► cuadro (letterbox) ─► worker: ONNX Runtime Web (GPU con WebGPU, o CPU) ─► cajas
   cajas ─► ¿en 2 de 3 cuadros? ─► mismo daño que hace < 1 s, o un punto a < 15 m ─► se actualiza
                                 └─► si no, un punto nuevo en la posición del vehículo ─► mapa (MapLibre)
```

- **Modelo en el teléfono:** YOLO exportado a ONNX y ejecutado con ONNX Runtime Web dentro de un Web Worker,
  así la pantalla no se congela. Usa la GPU del teléfono (WebGPU) si hay; si no, la CPU con varios hilos.
  - El preprocesado y el NMS replican a ultralytics. En Node, con ONNX Runtime Web, dan las mismas cajas,
    clases y confianzas que ultralytics en Python (diferencia 0,000 px en 3 casos de prueba).
  - En una laptop (GPU integrada) va a ~10 cuadros por segundo a 640 px con el YOLO26s.
- **Mapa:** MapLibre GL JS con teselas vectoriales de OpenFreeMap (datos de OpenStreetMap), sin clave.
  - Los puntos son una capa GeoJSON con agrupamiento.
  - La calle de un punto se pregunta a Nominatim (OpenStreetMap) solo al tocarlo.
- **Datos:** los puntos se guardan en el teléfono (IndexedDB), con un recorte JPEG de cada daño.
  - No salen de ahí salvo que se exporten.
  - A la red solo van las teselas del mapa y, al tocar un punto, sus coordenadas a Nominatim.
- **Sin conexión:** `sw.js` guarda la app. Además agrega las cabeceras COOP/COEP que GitHub Pages no deja
  configurar, para que la CPU pueda usar varios hilos.

## Modelos

AP50 en el test congelado del proyecto, a 640 px (el tamaño de la app). Ninguna foto de test se usó para
entrenar, elegir el modelo ni elegir umbrales.

| Modelo | Baches: Egipto (celular) | Bucko (dashcam) | Brasil (vehículo) | Bisman (de cerca) | HRP4K (4K, China) | Grietas: Egipto / Brasil | Licencia |
|---|---:|---:|---:|---:|---:|---:|---|
| **Baches SCZ v1** (predeterminado) | **0,47** | **0,41** | **0,61** | **0,35** | 0,04 | **0,20** / 0,06 | AGPL-3.0 |
| YOLO26s descargado ([TamAko783](https://huggingface.co/TamAko783/YOLO26s_RDD_FRDC_Distilled_v2)) | 0,36 | 0,31 | 0,59 | 0,19 | 0,05 | 0,11 / 0,07 | AGPL-3.0 |
| YOLO12s RDD2022 ([rezzzq](https://huggingface.co/rezzzq/yolo12s-road-damage-rdd2022)) | 0,15 | 0,15 | 0,47 | 0,15 | 0,03 | 0,08 / 0,06 | MIT |
| YOLO del 1.er parcial (Bisman), solo baches de cerca | | | | 0,68 | | | ver el repo original |

- **Baches SCZ v1:** el modelo del proyecto, con su ficha (`MODEL_CARD.md`) en
  [Duranzzz/baches-scz](https://github.com/Duranzzz/baches-scz). Es un promedio de pesos
  ([WiSE-FT](https://arxiv.org/abs/2109.01903), α = 0,25) entre el YOLO26s descargado y el mismo modelo ajustado con 6.507 fotos del proyecto (limpias, con aumentos que imitan
  video de celular por WhatsApp). El ajuste solo subía mucho en los datasets que vio, pero bajaba en HRP4K,
  el único que ningún modelo vio (0,05 → 0,02): ajustar especializa. El promedio conserva buena parte de la
  mejora sin esa caída. Se eligió con una regla fijada antes de ver los resultados: el mejor en validación
  entre los que no empeoran en una mitad de HRP4K; la otra mitad quedó solo para informar.
- **Ojo:** en Bucko, Brasil y Bisman el ajuste vio fotos de los mismos caminos (o casi copias), así que sus
  números son optimistas. Egipto es el más limpio. En Santa Cruz no hay fotos etiquetadas: ver "Límites".
- **Los otros tres** quedan en la app solo para comparar: en Ajustes aparecen bajo "Para comparar".

Todos se entrenaron con [ultralytics](https://github.com/ultralytics/ultralytics) (AGPL-3.0).

## Límites

- **No hay fotos de Santa Cruz etiquetadas.** La precisión en estas calles no está medida; los números de
  arriba son de datasets públicos de otros países.
- Desde un vehículo todavía se escapan baches, sobre todo los lejanos y chicos: a 640 px casi no se ven
  (HRP4K, fotos 4K en perspectiva: 0,04). Las juntas de losas de hormigón, el adoquín y a veces la
  carrocería del propio auto pueden salir como grietas.
- La **severidad es provisional**: sale del tamaño de la caja en la imagen, no de una medida real.
- Con el **recorrido de prueba**, el punto no es la ubicación real del daño (se avisa en cada punto).
- El GPS del teléfono tiene unos 5 a 10 m de error, y la cámara mira hacia adelante: el daño suele estar
  unos metros más allá del punto.

## Actualizar los modelos

Desde el repositorio del proyecto:

```bash
python exportar_web.py --app ../baches-scz-app                                   # exporta y verifica contra el .pt
python exportar_web.py --app ../baches-scz-app --modelo a1=runs/a1/weights/best.pt   # sumar uno reentrenado
```

Después, subir `VERSION` en `sw.js` para que los teléfonos bajen los archivos nuevos.

Para probar en la PC: `python servir.py` y abrir http://127.0.0.1:8123 (la cámara y el GPS piden
`localhost` o HTTPS).

## Créditos

- Mapa: © colaboradores de [OpenStreetMap](https://www.openstreetmap.org/copyright) (ODbL), teselas de
  [OpenFreeMap](https://openfreemap.org), [MapLibre GL JS](https://maplibre.org) (BSD-3).
- Rutas simuladas: [OSRM](https://project-osrm.org) sobre datos de OpenStreetMap.
- Motor: [ONNX Runtime Web](https://onnxruntime.ai) (MIT).
