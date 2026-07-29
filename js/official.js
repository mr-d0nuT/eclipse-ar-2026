/* =========================================================================
   official.js — Puntos de observación oficiales

   La Generalitat, junto con los ayuntamientos de la franja de totalidad, ha
   seleccionado estos emplazamientos por seguridad, capacidad, accesibilidad y
   BUENAS CONDICIONES DE VISIBILIDAD.

   Fuente: https://eclipsicatalunya.cat/es/puntos-de-observacion/

   Esto sustituye a la búsqueda por miradores de OpenStreetMap, y con razón:
   aquella se guiaba por la etiqueta `tourism=viewpoint`, que en Montbrió del
   Camp está puesta en un cruce de calles. Aquí alguien ha ido al sitio, ha
   mirado al oeste y ha contado cuántos coches caben. No hay heurística que
   compita con eso.

   Las coordenadas salen de los enlaces de mapa de la propia web. La de
   Tarragona no las trae (su enlace es una búsqueda por nombre), así que se ha
   tomado de OpenStreetMap: way «Anella Mediterrània», centro del recinto.

   Van incrustadas en la app, no se descargan: el día del eclipse puede que no
   haya cobertura, y esta es justo la lista que hará falta entonces.
   ========================================================================= */
(function (global) {
  'use strict';

  const SOURCE = 'https://eclipsicatalunya.cat/es/puntos-de-observacion/';

  // n = emplazamiento · m = municipio · people/cars = aforo · dur = totalidad
  // publicada por la organización, en segundos
  const POINTS = [
    { n: 'Plaça de bous',                       m: 'Alcanar',             lat: 40.539453, lon: 0.480626, people: 1025, cars: 680,  dur: 97 },
    { n: 'Font del Mirador',                    m: 'Altafulla',           lat: 41.137522, lon: 1.388106, people: 600,  cars: 240,  dur: 53 },
    { n: 'Polígon Industrial l’Oriola',    m: 'Amposta',             lat: 40.694124, lon: 0.576496, people: 4400, cars: 2000, dur: 93 },
    { n: 'Pla de Camarles',                     m: 'Camarles',            lat: 40.770309, lon: 0.665040, people: 3000, cars: 1750, dur: 91 },
    { n: 'Cooperativa Agrícola de Cambrils',    m: 'Cambrils',            lat: 41.085408, lon: 1.033529, people: 1800, cars: 1080, dur: 69 },
    { n: 'Carrer Joan Miró',                    m: 'Constantí',           lat: 41.151986, lon: 1.213322, people: 1600, cars: 680,  dur: 57 },
    { n: 'Polígon Industrial la Plana',         m: 'Gandesa',             lat: 41.055689, lon: 0.453167, people: 2300, cars: 1100, dur: 84 },
    { n: 'Can Gironès',                         m: 'L’Aldea',        lat: 40.745636, lon: 0.627495, people: 4500, cars: 3300, dur: 92 },
    { n: 'Camp de futbol municipal',            m: 'L’Ametlla de Mar', lat: 40.886840, lon: 0.793046, people: 1250, cars: 500, dur: 85 },
    { n: 'Zona esportiva',                      m: 'les Borges Blanques', lat: 41.513023, lon: 0.873788, people: 2500, cars: 1400, dur: 23 },
    { n: 'Magraners',                           m: 'Lleida',              lat: 41.605207, lon: 0.660072, people: 4300, cars: 1950, dur: 25 },
    { n: 'les Palomeres / Granja Gira-Sol',     m: 'Montbrió del Camp',   lat: 41.126072, lon: 1.005966, people: 2400, cars: 670,  dur: 67 },
    { n: 'Carrer Tortosa',                      m: 'Móra la Nova',        lat: 41.097638, lon: 0.652944, people: 3800, cars: 1500, dur: 77 },
    { n: 'Barri Immaculada',                    m: 'Reus',                lat: 41.150817, lon: 1.091624, people: 2450, cars: 1740, dur: 61 },
    { n: 'Crta de la Galera, Zona Esportiva',   m: 'Santa Bàrbara',       lat: 40.713731, lon: 0.487085, people: 1100, cars: 790,  dur: 94 },
    { n: 'L’Anella Mediterrània',          m: 'Tarragona',           lat: 41.122104, lon: 1.203755, people: null, cars: null, dur: 60 },
    { n: 'Polígon Industrial de Roques Planes', m: 'Torredembarra',       lat: 41.152866, lon: 1.390924, people: 1300, cars: 1000, dur: 52 },
    { n: 'Carrer Fuster, Polígon Industrial',   m: 'Valls',               lat: 41.307329, lon: 1.257345, people: 4100, cars: 1900, dur: 39 }
  ];

  /**
   * Los puntos oficiales ordenados de más cerca a más lejos, cada uno con sus
   * circunstancias calculadas para su posición exacta.
   *
   * Todo local: ni una petición de red, así que funciona sin cobertura y es
   * instantáneo.
   */
  function nearest(lat, lon) {
    return POINTS.map(p => {
      const lc = Eclipse.localCircumstances(p.lat, p.lon, 0);
      return Object.assign({}, p, {
        official: true,
        fromKm: Places.distKm(lat, lon, p.lat, p.lon),
        fromBearing: Places.bearing(lat, lon, p.lat, p.lon),
        // Lo calculado por nosotros, para poder contrastarlo con lo publicado
        total: !!(lc && lc.type === 'total'),
        calcDur: lc ? lc.totalityDuration : 0,
        alt: lc ? lc.max.altRefracted : null,
        obs: lc ? lc.obscuration : 0,
        maxDate: lc ? lc.max.date : null,
        azMax: lc ? lc.max.az : null
      });
    }).sort((a, b) => a.fromKm - b.fromKm);
  }

  global.Official = { POINTS, nearest, SOURCE };
})(window);
