/* =========================================================================
   spots.js — Sitios de verdad, no coordenadas de una rejilla

   Un punto de rejilla puede caer en mitad de un campo de cultivo, dentro de
   una finca vallada o al fondo de un barranco. Lo que hace falta es un sitio
   con nombre, al que se llegue en coche y desde el que se vea el horizonte:
   miradores, collados, cimas con carretera y áreas de descanso.

   Fuente: OpenStreetMap vía Overpass. Sin clave, CORS abierto.

   Dos consultas separadas a propósito:
     1. Los sitios de una zona. Tarda unos segundos, así que se guarda un mes
        (un mirador no se mueve).
     2. Si hay carretera a 300 m de cada finalista. Una sola consulta con un
        `out count` por punto: medio segundo para una docena.

   Filtrar por carretera dentro de la consulta grande también funciona, pero
   obliga al servidor a materializar todos los nodos de todas las vías de la
   zona y pasa de 1 a 25 segundos. Por eso van aparte.
   ========================================================================= */
(function (global) {
  'use strict';

  const API = 'https://overpass-api.de/api/interpreter';

  // Vías por las que pasa un coche normal. Fuera «track», que suele ser
  // camino agrícola sin asfaltar.
  const DRIVABLE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)$';

  const SPOTS_TTL = 30 * 24 * 3600 * 1000;   // un mes
  const ROAD_M = 300;                        // metros hasta la carretera
  const MAX_SPAN = 2.2;                      // grados de lado máximo de la caja

  function ask(query, timeoutMs) {
    return Net.getJSON(API + '?data=' + encodeURIComponent(query), timeoutMs || 50000, 1);
  }

  /** Qué clase de sitio es, según sus etiquetas */
  function kindOf(tags) {
    if (tags.tourism === 'viewpoint') return 'viewpoint';
    if (tags.mountain_pass === 'yes') return 'pass';
    if (tags.tourism === 'picnic_site') return 'picnic';
    if (tags.highway === 'rest_area') return 'rest';
    if (tags.natural === 'peak') return 'peak';
    return 'other';
  }

  /**
   * Caja de búsqueda: el círculo del usuario, recortado con la franja de
   * totalidad. Sin recortar, un radio de 200 km da una caja enorme y la
   * consulta se va a un minuto; con el recorte se queda en la banda, que es
   * justo donde están los sitios que interesan.
   */
  function boundingBox(lat, lon, radiusKm) {
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.max(0.15, Math.cos(lat * Math.PI / 180)));
    let s = lat - dLat, n = lat + dLat, w = lon - dLon, e = lon + dLon;

    /* Recorte a la franja, pero solo con el tramo que cae CERCA. La banda va
       del Ártico a Baleares: su caja global no recorta nada. Y sin recortar,
       Overpass devuelve los primeros 900 nodos que encuentra —que en Cataluña
       son todos del Pirineo— y la banda, que queda al suroeste, se pierde. */
    try {
      const lim = Eclipse.totalityLimits(6);
      const near = lim.north.concat(lim.south)
        .filter(p => Places.distKm(lat, lon, p.lat, p.lon) <= radiusKm + 40);
      if (near.length) {
        const bs = Math.min.apply(null, near.map(p => p.lat)) - 0.25;
        const bn = Math.max.apply(null, near.map(p => p.lat)) + 0.25;
        const bw = Math.min.apply(null, near.map(p => p.lon)) - 0.25;
        const be = Math.max.apply(null, near.map(p => p.lon)) + 0.25;
        if (bn > s && bs < n && be > w && bw < e) {
          s = Math.max(s, bs); n = Math.min(n, bn);
          w = Math.max(w, bw); e = Math.min(e, be);
        }
      }
    } catch (err) {}

    // Techo duro: por encima de esto la consulta tarda demasiado
    if (n - s > MAX_SPAN) { const c = (n + s) / 2; s = c - MAX_SPAN / 2; n = c + MAX_SPAN / 2; }
    if (e - w > MAX_SPAN) { const c = (e + w) / 2; w = c - MAX_SPAN / 2; e = c + MAX_SPAN / 2; }

    return { s, w, n, e };
  }

  /**
   * Sitios de la zona con nombre y, si la tienen, altitud.
   * @returns {Promise<Array|null>} null si Overpass no responde
   */
  async function find(lat, lon, radiusKm) {
    const b = boundingBox(lat, lon, radiusKm);
    const r = v => v.toFixed(2);
    const key = `spots:${r(b.s)},${r(b.w)},${r(b.n)},${r(b.e)}`;
    const box = `(${r(b.s)},${r(b.w)},${r(b.n)},${r(b.e)})`;

    const q = `[out:json][timeout:50];(` +
      `node["tourism"="viewpoint"]${box};` +
      `node["mountain_pass"="yes"]${box};` +
      `node["natural"="peak"]${box};` +
      `node["tourism"="picnic_site"]${box};` +
      `node["highway"="rest_area"]${box};` +
      `);out body 900;`;

    try {
      const res = await Net.cached(key, SPOTS_TTL, async () => {
        const j = await ask(q);
        if (!j || !Array.isArray(j.elements)) throw new Error('respuesta Overpass inesperada');
        return j.elements.map(e => {
          const t = e.tags || {};
          const ele = parseFloat(t.ele);
          return {
            lat: e.lat, lon: e.lon,
            name: t.name || null,
            kind: kindOf(t),
            ele: isFinite(ele) ? Math.round(ele) : null
          };
        }).filter(s => s.kind !== 'other' && isFinite(s.lat) && isFinite(s.lon));
      });
      return res.value;
    } catch (e) {
      return null;
    }
  }

  /**
   * ¿Hay carretera cerca de cada uno de estos puntos?
   * Una sola consulta: un conjunto `around` por punto y un `out count` por
   * conjunto, que salen en el mismo orden.
   * @returns {Promise<Array<number|null>>} vías encontradas, o null si no se sabe
   */
  async function checkRoads(points) {
    if (!points.length) return [];
    const key = 'roads:' + points.map(p => p.lat.toFixed(4) + ',' + p.lon.toFixed(4)).join(';');

    const lines = ['[out:json][timeout:40];'];
    points.forEach((p, i) => {
      lines.push(`way(around:${ROAD_M},${p.lat.toFixed(5)},${p.lon.toFixed(5)})["highway"~"${DRIVABLE}"]->.a${i};`);
    });
    points.forEach((p, i) => lines.push(`.a${i} out count;`));

    try {
      const res = await Net.cached(key, SPOTS_TTL, async () => {
        const j = await ask(lines.join('\n'), 40000);
        const counts = (j.elements || []).filter(e => e.type === 'count');
        if (counts.length !== points.length) throw new Error('cuentas incompletas');
        return counts.map(c => parseInt(c.tags.ways, 10) || 0);
      });
      return res.value;
    } catch (e) {
      return points.map(() => null);
    }
  }

  global.Spots = { find, checkRoads, kindOf, boundingBox, ROAD_M };
})(window);
