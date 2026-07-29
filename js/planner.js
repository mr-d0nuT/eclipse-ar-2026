/* =========================================================================
   planner.js — ¿Dónde me pongo?

   El aviso que traía la app («estás a X km de la línea central») optimiza
   hacia el sitio equivocado. Desde Barcelona manda 180 km al sur, mar adentro
   hacia Baleares, cuando con 80 km al suroeste ya pisas totalidad en
   Tarragona. Lo que hay que responder no es «dónde está el centro» sino
   «cuál es el mejor sitio al que puedo llegar».

   Y ese «mejor» tiene cuatro factores, no uno:
     · duración de la totalidad
     · altura del Sol (a 4° la atmósfera ya se come mucha luz)
     · horizonte del terreno (a 4° un cerro te tapa el eclipse entero)
     · nubes previstas

   Fase 1 (rejilla completa) es local y cuesta milisegundos. Solo los veinte
   finalistas gastan red.
   ========================================================================= */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;

  /* Estos números están atados al presupuesto real de la API: 600 sondeos de
     elevación por minuto. Una búsqueda gasta la rejilla (para saber qué es
     mar) más el horizonte de cada finalista, 31 sondeos cada uno. Si la cuota
     no da para todo, la búsqueda se encoge sola en vez de negarse: cuatro
     sitios bien mirados valen más que un mensaje de error. */
  const GRID_TARGET = 150;    // puntos de la rejilla
  const N_FINALISTS = 12;     // candidatos que pasan a consultar red
  const N_RESULTS = 8;        // los que se enseñan
  const MIN_FINALISTS = 4;    // por debajo de esto no merece la pena buscar
  const MIN_SEP_KM = 8;       // separación mínima entre finalistas

  // ---------------------------------------------------------------------
  // Puntuación
  // ---------------------------------------------------------------------
  /* Multiplicativa a propósito: un factor malo debe hundir el resultado, no
     promediarse con los buenos. De nada sirve la totalidad más larga del país
     si tienes una montaña delante. */

  /** Valor del eclipse en sí: 0,30 como mucho sin totalidad, 0,60-1 con ella */
  function baseValue(isTotal, durSec, obscuration) {
    return isTotal ? 0.60 + 0.40 * Math.min(1, durSec / 120)
                   : 0.30 * obscuration;
  }

  /** Extinción atmosférica: el Sol muy bajo llega apagado y enrojecido */
  function extFactor(altDeg) {
    return 0.75 + 0.25 * Math.min(1, Math.max(0, altDeg) / 8);
  }

  /** Horizonte: sin margen no hay eclipse. null = aún no se sabe */
  function horizonFactor(marginDeg) {
    if (marginDeg == null) return 0.75;
    if (marginDeg <= 0) return 0.05;
    return Math.min(1, 0.35 + 0.325 * marginDeg);   // 2° de margen ya es pleno
  }

  /** Nubes. Con suelo de 0,15: una previsión a 14 días no puede vetar un sitio */
  function skyFactor(score) {
    return score == null ? 0.75 : 0.15 + 0.85 * score;
  }

  /**
   * Acceso rodado. Si no hay carretera a 300 m no es un sitio al que ir en
   * coche, por bueno que sea el cielo.
   * @param {number|null} ways vías encontradas, o null si no se ha comprobado
   */
  function roadFactor(ways, kind) {
    if (ways == null) {
      // Sin comprobar: un mirador o un collado están en una carretera por
      // definición; una cima, casi nunca.
      return kind === 'peak' ? 0.75 : 1;
    }
    return ways > 0 ? 1 : 0.12;
  }

  /**
   * Empujón pequeño por tipo de sitio. Un mirador lo ha elegido alguien
   * precisamente porque desde ahí se ve: eso es información que el modelo de
   * elevaciones no tiene, porque no sabe de árboles ni de edificios.
   */
  function kindFactor(kind) {
    return kind === 'viewpoint' ? 1
         : kind === 'pass' ? 0.98
         : kind === 'peak' ? 0.96
         : kind ? 0.94 : 1;
  }

  /**
   * Edificios. El modelo de elevación no los ve, así que sin esto el
   * planificador manda a una calle de pueblo: el terreno está llano, el
   * horizonte sale a 0° y puntúa perfecto, mientras las casas te tapan un Sol
   * que estará a cuatro grados.
   *
   * Lo que veta es lo que hay EN LA LÍNEA DE VISIÓN; la densidad alrededor
   * solo resta un poco, porque un mirador al borde de un pueblo puede tener
   * cien casas detrás y las vistas perfectamente libres.
   * @param {{sight:number, around:number}|null} b null = no se ha podido mirar
   */
  function buildingFactor(b) {
    if (!b) return 0.9;                    // sin comprobar: duda razonable
    if (b.sight >= 10) return 0.06;        // estás dentro del casco urbano
    if (b.sight >= 3)  return 0.18;
    if (b.sight >= 1)  return 0.45;
    if (b.around >= 40) return 0.75;       // pegado a un pueblo, pero despejado
    return 1;
  }

  function quality(p) {
    return baseValue(p.total, p.dur, p.obs) * extFactor(p.alt) *
           horizonFactor(p.margin) * skyFactor(p.sky) *
           roadFactor(p.roads, p.kind) * kindFactor(p.kind) *
           buildingFactor(p.buildings);
  }

  // ---------------------------------------------------------------------
  // Fase 1 — rejilla local
  // ---------------------------------------------------------------------
  /**
   * Rejilla de puntos dentro de un radio, con paso ajustado para que salgan
   * del orden de `target` puntos.
   */
  function grid(lat, lon, radiusKm, target) {
    target = target || 320;
    // El suelo es bajo a propósito: con una banda de un kilómetro hace falta
    // un paso de unos 150 m, no de kilómetro y medio.
    const step = Math.max(0.15, Math.sqrt(Math.PI * radiusKm * radiusKm / target));
    const dLat = step / 111.32;
    const dLon = step / (111.32 * Math.max(0.15, Math.cos(lat * DEG)));
    const n = Math.ceil(radiusKm / step);
    const out = [];
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const la = lat + i * dLat, lo = lon + j * dLon;
        const km = Places.distKm(lat, lon, la, lo);
        if (km > radiusKm) continue;
        out.push({ lat: la, lon: lo, km });
      }
    }
    return { points: out, step };
  }

  /** Evalúa la rejilla entera con el motor besseliano. Todo local. */
  function evaluateGrid(lat, lon, radiusKm, target) {
    const g = grid(lat, lon, radiusKm, target || GRID_TARGET);
    const pts = [];
    for (const p of g.points) {
      const lc = Eclipse.localCircumstances(p.lat, p.lon, 0);
      if (!lc) continue;
      p.total = lc.type === 'total';
      p.dur = lc.totalityDuration;
      p.alt = lc.max.altRefracted;
      p.obs = lc.obscuration;
      p.maxDate = lc.max.date;
      p.azMax = lc.max.az;
      p.margin = null;          // se rellena en la fase 2
      p.sky = null;
      p.q = quality(p);
      pts.push(p);
    }
    return { points: pts, step: g.step, radiusKm };
  }

  /**
   * Los mejores N, obligándolos a estar separados entre sí.
   * Sin esto los veinte finalistas caen todos en el mismo valle y comparten
   * exactamente el mismo problema de horizonte.
   */
  function topDiverse(points, n, minSepKm) {
    const sorted = points.slice().sort((a, b) => b.q - a.q);
    const out = [];
    for (const p of sorted) {
      if (out.length >= n) break;
      let clash = false;
      for (const q of out) {
        if (Places.distKm(p.lat, p.lon, q.lat, q.lon) < minSepKm) { clash = true; break; }
      }
      if (!clash) out.push(p);
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Fase 2 — finalistas: horizonte y nubes
  // ---------------------------------------------------------------------
  /**
   * @param {function} [onProgress] recibe ('horizon'|'weather', hechas, totales)
   */
  async function refine(finalists, onProgress) {
    const rep = (what) => (a, b) => { if (onProgress) onProgress(what, a, b); };

    const [hz, wx] = await Promise.all([
      Horizon.horizonMany(finalists, rep('horizon')).catch(() => []),
      Weather.forecastMany(finalists).catch(() => [])
    ]);

    for (let i = 0; i < finalists.length; i++) {
      const p = finalists[i];

      if (hz[i]) {
        p.horizon = hz[i].horizon;
        p.elev = hz[i].obsElev;
        p.margin = p.alt - hz[i].horizon;
      }

      if (wx[i] && wx[i].hours) {
        const h = Weather.hourNear(wx[i].hours, p.maxDate);
        if (h) {
          p.cloud = h;
          p.sky = Weather.skyScore(h.low, h.mid, h.high);
        }
      }

      p.q = quality(p);
    }

    return finalists.sort((a, b) => b.q - a.q);
  }

  /**
   * Marca qué puntos están en el agua y les pone su altitud real.
   * @returns {Promise<boolean>} false si no se ha podido comprobar (sin red)
   */
  async function markLand(points, onProgress) {
    try {
      const elev = await Horizon.elevations(points, onProgress);
      if (elev.length !== points.length) return false;
      let any = false;
      for (let i = 0; i < points.length; i++) {
        if (elev[i] == null) continue;
        any = true;
        points[i].elev = elev[i];
        points[i].sea = Horizon.isSea(elev[i]);
      }
      return any;
    } catch (e) {
      if (e && e.rate) throw e;
      return false;
    }
  }

  /**
   * Búsqueda completa.
   * @param {number} lat @param {number} lon
   * @param {number} radiusKm
   * @param {function} [onProgress] recibe (fase, hechas, totales)
   * @returns {Promise<{results:Array, grid:object, from:{lat,lon}, landChecked:boolean}>}
   */
  async function search(lat, lon, radiusKm, onProgress) {
    const g = evaluateGrid(lat, lon, radiusKm);

    /* Se reparte la cuota ANTES de gastar nada. El horizonte de los finalistas
       es lo que de verdad decide el ranking, así que tiene prioridad sobre la
       comprobación de mar: si hay que renunciar a algo, se renuncia a esa y se
       avisa, en vez de entregar ocho sitios sin mirarles el relieve. */
    let spare = Net.spare();
    const perSpot = Horizon.COARSE_PER_SPOT + 3;   // elevación + su parte de nubes
    const gridCost = g.points.length;

    let doLand = spare >= gridCost + MIN_FINALISTS * perSpot;
    if (doLand) spare -= gridCost;

    const nFinal = Math.max(0, Math.min(N_FINALISTS, Math.floor(spare / perSpot)));
    if (nFinal < MIN_FINALISTS) {
      throw Net.rateError(Net.waitFor(gridCost + N_FINALISTS * perSpot));
    }

    const landChecked = doLand && await markLand(g.points,
      (a, b) => { if (onProgress) onProgress('land', a, b); });
    const usable = landChecked ? g.points.filter(p => !p.sea) : g.points;

    const finalists = topDiverse(usable, nFinal, MIN_SEP_KM);

    // Con la altitud real ya conocida, las circunstancias de los finalistas se
    // recalculan bien: a 1.000 m los contactos no caen en el mismo segundo.
    for (const p of finalists) {
      if (p.elev == null) continue;
      const lc = Eclipse.localCircumstances(p.lat, p.lon, p.elev);
      if (!lc) continue;
      p.total = lc.type === 'total';
      p.dur = lc.totalityDuration;
      p.alt = lc.max.altRefracted;
      p.obs = lc.obscuration;
      p.maxDate = lc.max.date;
      p.azMax = lc.max.az;
    }

    await refine(finalists, onProgress);

    const results = finalists.slice(0, N_RESULTS).map(p => {
      const near = Places.nearest(p.lat, p.lon);
      return Object.assign({}, p, {
        near,
        fromKm: Places.distKm(lat, lon, p.lat, p.lon),
        fromBearing: Places.bearing(lat, lon, p.lat, p.lon)
      });
    });

    return { results, grid: g, from: { lat, lon }, landChecked };
  }

  /**
   * Destinos para el aviso de la portada. Sustituye al «estás a X km de la
   * línea central», que apuntaba al sitio equivocado.
   *
   * Devuelve dos respuestas porque son dos preguntas distintas y a menudo
   * tienen soluciones diferentes: el sitio con totalidad MÁS CERCANO (el
   * mínimo esfuerzo) y el MEJOR del radio (más segundos y el Sol más alto).
   *
   * El cálculo es local e instantáneo. Si se le pasa `elevations` (mapa de
   * altitudes ya descargadas), descarta los puntos que caen en el mar; sin
   * ellas responde igual pero avisando de que no lo ha comprobado.
   */
  function bestNearby(lat, lon, radiusKm, elevations) {
    const g = evaluateGrid(lat, lon, radiusKm || 150, 1000);
    let closest = null, best = null;
    for (const p of g.points) {
      if (!p.total) continue;
      if (elevations) {
        const e = elevations[key(p)];
        if (e == null || Horizon.isSea(e)) continue;
        p.elev = e;
      }
      if (!closest || p.km < closest.km) closest = p;
      if (!best || p.q > best.q) best = p;
    }
    if (!closest) return null;

    const decorate = p => p && Object.assign({}, p, {
      near: Places.nearest(p.lat, p.lon),
      fromKm: Places.distKm(lat, lon, p.lat, p.lon),
      fromBearing: Places.bearing(lat, lon, p.lat, p.lon)
    });

    // Si el mejor está prácticamente donde el más cercano, es una sola opción
    const same = best && closest &&
      Places.distKm(best.lat, best.lon, closest.lat, closest.lon) < g.step * 1.5;

    return { closest: decorate(closest), best: same ? null : decorate(best) };
  }

  // ---------------------------------------------------------------------
  // Búsqueda sobre sitios reales
  // ---------------------------------------------------------------------
  /**
   * Como `search`, pero los candidatos son miradores, collados, cimas y áreas
   * de descanso de OpenStreetMap en vez de puntos de una rejilla. Da una
   * respuesta a la que de verdad se puede ir: con nombre, con altitud y con
   * carretera comprobada.
   *
   * Si Overpass no responde, se cae con elegancia a la búsqueda por rejilla,
   * que no depende de nada externo.
   */
  /**
   * @param {{min:number, max:number}} range banda de distancia, en km
   *
   * A pocos kilómetros la totalidad no cambia (un kilómetro son décimas de
   * segundo), así que dentro de una banda estrecha el orden lo deciden el
   * relieve, la altitud del sitio y los edificios: justo lo que hace falta
   * para elegir dónde ponerse cerca de casa.
   */
  async function searchSpots(lat, lon, range, onProgress) {
    const rep = (phase, a, b) => { if (onProgress) onProgress(phase, a, b); };
    const min = range.min || 0, max = range.max;
    const inBand = km => km >= min && km <= max;

    /** Un punto cualquiera, con sus circunstancias locales resueltas */
    function candidate(p, extra) {
      const lc = Eclipse.localCircumstances(p.lat, p.lon, p.ele || 0);
      if (!lc) return null;
      return Object.assign({
        lat: p.lat, lon: p.lon,
        km: Places.distKm(lat, lon, p.lat, p.lon),
        total: lc.type === 'total',
        dur: lc.totalityDuration,
        alt: lc.max.altRefracted,
        obs: lc.obscuration,
        maxDate: lc.max.date,
        azMax: lc.max.az,
        margin: null, sky: null, roads: null, buildings: null, q: 0
      }, extra || {});
    }

    rep('spots', 0, 1);
    const raw = await Spots.find(lat, lon, max);

    const cands = [];
    for (const s of (raw || [])) {
      const km = Places.distKm(lat, lon, s.lat, s.lon);
      if (!inBand(km)) continue;
      const c = candidate(s, { name: s.name, kind: s.kind, ele: s.ele });
      if (c) cands.push(c);
    }

    /* En una banda estrecha puede no haber ni un solo sitio catalogado, y con
       Overpass caído tampoco hay ninguno. Antes que responder «nada», se
       rellena con puntos de una rejilla fina dentro de la banda: no tendrán
       nombre, pero se les mira el relieve y los edificios igual, y al menos
       dicen hacia dónde tirar. */
    const filled = cands.length < MIN_FINALISTS;
    let seaChecked = true;
    if (filled) {
      const fromGrid = [];
      for (const p of grid(lat, lon, max, 240).points) {
        if (!inBand(p.km)) continue;
        const c = candidate(p);
        if (c) fromGrid.push(c);
      }

      /* Los puntos de rejilla, a diferencia de los sitios de OpenStreetMap, no
         están necesariamente en tierra: a ocho kilómetros de la costa media
         banda cae en el mar. Se comprueba la altitud de un puñado repartido
         —el DEM da exactamente 0 en el agua— y se tira lo que flota.
         Solo de unos pocos: el grueso de la cuota lo necesita el horizonte. */
      for (const p of fromGrid) p.q = quality(p);
      const probe = topDiverse(fromGrid, 60, Math.max(0.15, max / 14));
      seaChecked = await markLand(probe,
        (a, b) => { if (onProgress) onProgress('land', a, b); });
      for (const p of (seaChecked ? probe.filter(x => !x.sea) : probe)) cands.push(p);
    }

    if (!cands.length) {
      return { results: [], spots: 0, from: { lat, lon }, grid: null, range };
    }
    for (const p of cands) p.q = quality(p);

    // Cuántos finalistas caben en la cuota de elevación que quede
    const perSpot = Horizon.COARSE_PER_SPOT + 3;
    const nFinal = Math.max(0, Math.min(N_FINALISTS, Math.floor(Net.spare() / perSpot)));
    if (nFinal < MIN_FINALISTS) throw Net.rateError(Net.waitFor(N_FINALISTS * perSpot));

    // La separación mínima escala con la banda: en un radio de un kilómetro,
    // exigir tres de distancia dejaría un solo resultado.
    const finalists = topDiverse(cands, nFinal, Math.max(0.15, max / 8));

    // Carreteras y edificios, en una sola consulta
    rep('roads', 0, 1);
    const access = await Spots.checkAccess(finalists);
    for (let i = 0; i < finalists.length; i++) {
      if (!access[i]) continue;
      finalists[i].roads = access[i].roads;
      finalists[i].buildings = { sight: access[i].sight, around: access[i].around };
    }

    await refine(finalists, onProgress);

    /* Se pidieron sitios a los que llegar en coche y con las vistas libres,
       así que los que no tienen carretera, o tienen casas metidas en la línea
       de visión, se caen de la lista —salvo que quedasen tan pocos que la
       respuesta dejara de ser útil, y entonces se enseñan bien marcados. */
    /* Red de seguridad contra el mar: al calcularles el horizonte, los
       finalistas traen su altitud real del DEM. Un cero ahí es agua, y eso no
       admite matices: se cae de la lista pase lo que pase, aunque nos quedemos
       sin resultados. Un punto en el Mediterráneo no es una respuesta. */
    const dry = finalists.filter(p => !(p.elev === 0 && !p.kind));

    const good = dry.filter(p =>
      p.roads !== 0 && !(p.buildings && p.buildings.sight >= 3));
    const shown = good.length >= MIN_FINALISTS ? good : dry;
    shown.sort((a, b) => b.q - a.q);

    const results = shown.slice(0, N_RESULTS).map(p => Object.assign({}, p, {
      near: Places.nearest(p.lat, p.lon),
      fromKm: Places.distKm(lat, lon, p.lat, p.lon),
      fromBearing: Places.bearing(lat, lon, p.lat, p.lon)
    }));

    // Rejilla local solo para el mapa de calor: no cuesta red
    const g = max >= 10 ? evaluateGrid(lat, lon, max) : null;
    return {
      results, grid: g, from: { lat, lon }, range,
      spots: cands.length, filled, fellBack: !raw, landChecked: !filled || seaChecked
    };
  }

  /** Identificador estable de un punto de la rejilla */
  const key = p => p.lat.toFixed(3) + ',' + p.lon.toFixed(3);

  /**
   * `bestNearby` comprobando que los destinos son tierra firme.
   *
   * Solo consulta la altitud de los candidatos plausibles —los más cercanos y
   * los mejores—, no de la rejilla entera: una o dos peticiones. El origen se
   * redondea para que la rejilla sea siempre la misma y la caché sirva de una
   * visita a otra aunque el GPS baile unos metros.
   */
  async function bestNearbyChecked(lat, lon, radiusKm) {
    lat = +lat.toFixed(2); lon = +lon.toFixed(2);
    radiusKm = radiusKm || 150;

    const g = evaluateGrid(lat, lon, radiusKm, 1000);
    const totals = g.points.filter(p => p.total);
    if (!totals.length) return null;

    // Pocos, y solo los que pueden ganar: esto es una nota bajo el mapa, no
    // puede comerse la cuota que necesita la búsqueda de verdad.
    const byDist = totals.slice().sort((a, b) => a.km - b.km).slice(0, 30);
    const byQ = totals.slice().sort((a, b) => b.q - a.q).slice(0, 20);
    const seen = {}, probe = [];
    for (const p of byDist.concat(byQ)) {
      const k = key(p);
      if (seen[k]) continue;
      seen[k] = true;
      probe.push(p);
    }

    let map = null;
    try {
      const res = await Net.cached(`land:${lat},${lon},${radiusKm}`, null, async () => {
        const elev = await Horizon.elevations(probe);
        const m = {};
        for (let i = 0; i < probe.length; i++) if (elev[i] != null) m[key(probe[i])] = elev[i];
        return m;
      });
      map = res.value && Object.keys(res.value).length ? res.value : null;
    } catch (e) {}

    let out = map ? bestNearby(lat, lon, radiusKm, map) : null;
    if (out) { out.landChecked = true; return out; }

    // Sin altitudes, o con todos los candidatos descartados: respondemos igual
    // pero diciendo que no se ha verificado que sea tierra firme.
    out = bestNearby(lat, lon, radiusKm, null);
    if (out) out.landChecked = false;
    return out;
  }

  global.Planner = {
    search, searchSpots, refine, evaluateGrid, topDiverse, grid, markLand,
    bestNearby, bestNearbyChecked,
    quality, baseValue, extFactor, horizonFactor, skyFactor,
    roadFactor, kindFactor, buildingFactor,
    N_RESULTS, N_FINALISTS
  };
})(window);
