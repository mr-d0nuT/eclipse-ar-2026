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
     2. Carreteras y edificios de los finalistas, con un `out count` por
        conjunto: medio segundo para una docena de sitios.

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

  /* Edificios: lo que el modelo de elevación no ve.

     El DEM da la forma del terreno, no lo que hay encima. Una calle de pueblo
     tiene el horizonte del terreno a 0° y puntúa perfecto, mientras las casas
     tapan un Sol que estará a 4°. Y la etiqueta `tourism=viewpoint` de OSM no
     salva de eso: «Els Quatre Cantons», en Montbrió del Camp, es un cruce de
     calles etiquetado como mirador.

     Con el Sol a 4°, un edificio de altura h tapa hasta h/tan(4°) ≈ 14·h
     metros: ocho metros de casa tapan 115 m, y un bloque de cinco plantas,
     215 m. Por eso se sondea hasta unos 340 m EN LA DIRECCIÓN DEL SOL, que es
     la única que importa: las casas que tengas a la espalda dan igual. */
  const SIGHT_OFFSET = 160;                  // metros hacia el Sol
  const SIGHT_R = 180;                       // radio del sondeo -> cubre 0-340 m
  const DENSITY_R = 250;                     // para detectar casco urbano

  /* Overpass es un servicio comunitario gratuito y se le nota. Falla de dos
     maneras distintas y hay que tratarlas distinto:

       · Servidor ocupado. Llega como 504, o como un 200 con un error de texto
         donde esperabas JSON. Se le pasa en segundos: se reintenta una vez.
       · Cuota de la IP agotada (429). Reintentar no sirve de nada, y encima
         deja al usuario dos minutos mirando «Buscando miradores…». Se abandona
         al momento y el planificador tira de rejilla.

     El tiempo límite es corto por lo mismo: más vale una respuesta peor que
     una espera eterna. */
  async function ask(query, timeoutMs) {
    const url = API + '?data=' + encodeURIComponent(query);
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 2500));
      try {
        return await Net.getJSON(url, timeoutMs || 30000, 0);
      } catch (e) {
        last = e;
        if (e && e.status === 429) break;
      }
    }
    throw last;
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
       son todos del Pirineo— y la banda, que queda al suroeste, se pierde.

       Por debajo de 30 km no hace falta: la caja ya es pequeña, y recortarla
       podría dejarla vacía si el usuario está fuera de la franja. */
    if (radiusKm > 30) try {
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
   * Todo lo que hay que saber de cada finalista, en UNA sola consulta:
   * si hay carretera cerca, cuántos edificios se interponen hacia el Sol y
   * cuánta edificación tiene alrededor.
   *
   * Van juntas a propósito. Separadas eran dos peticiones seguidas al mismo
   * servidor, y la segunda se llevaba el «servidor ocupado» con bastante
   * frecuencia: el usuario veía la mitad de las etiquetas en blanco.
   *
   * Overpass devuelve un `out count` por conjunto y en el mismo orden en que
   * se declaran, que es lo que permite atribuir cada cuenta a su punto.
   *
   * @returns {Promise<Array<{roads:number, sight:number, around:number}|null>>}
   */
  async function checkAccess(points) {
    if (!points.length) return [];
    const key = 'acc2:' + points.map(p =>
      p.lat.toFixed(4) + ',' + p.lon.toFixed(4) + ',' + Math.round(p.azMax || 286)).join(';');

    const lines = ['[out:json][timeout:60];'];
    points.forEach((p, i) => {
      const d = Horizon.destPoint(p.lat, p.lon, p.azMax || 286, SIGHT_OFFSET);
      const at = `${d.lat.toFixed(5)},${d.lon.toFixed(5)}`;
      lines.push(`way(around:${ROAD_M},${p.lat.toFixed(5)},${p.lon.toFixed(5)})["highway"~"${DRIVABLE}"]->.r${i};`);
      lines.push(`way(around:${SIGHT_R},${at})["building"]->.b${i};`);
      // Un pinar delante tapa igual que una casa, y el DEM tampoco lo ve
      lines.push(`(way(around:${SIGHT_R},${at})["natural"="wood"];` +
                 `way(around:${SIGHT_R},${at})["landuse"="forest"];)->.t${i};`);
      lines.push(`way(around:${DENSITY_R},${p.lat.toFixed(5)},${p.lon.toFixed(5)})["building"]->.v${i};`);
    });
    points.forEach((p, i) => {
      lines.push(`.r${i} out count;`); lines.push(`.b${i} out count;`);
      lines.push(`.t${i} out count;`); lines.push(`.v${i} out count;`);
    });

    try {
      const res = await Net.cached(key, SPOTS_TTL, async () => {
        const j = await ask(lines.join('\n'), 60000);
        const c = (j.elements || []).filter(e => e.type === 'count');
        if (c.length !== points.length * 4) throw new Error('cuentas incompletas');
        const n = i => parseInt(c[i].tags.ways, 10) || 0;
        return points.map((p, i) => ({
          roads: n(4 * i), sight: n(4 * i + 1), trees: n(4 * i + 2), around: n(4 * i + 3)
        }));
      });
      return res.value;
    } catch (e) {
      return points.map(() => null);
    }
  }

  global.Spots = { find, checkAccess, kindOf, boundingBox, ROAD_M, SIGHT_OFFSET, SIGHT_R };
})(window);
