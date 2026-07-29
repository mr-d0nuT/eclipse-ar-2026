/* =========================================================================
   places.js — Referencias geográficas

   Sirven para dos cosas: los botones de ciudades y, sobre todo, para poder
   decir «14 km al noroeste de Tarragona» en vez de soltar unas coordenadas.
   Con esto el planificador no necesita ningún geocoder en línea, que sería
   una dependencia más que se cae justo el día que no hay cobertura.

   Cobertura: capitales de provincia y poblaciones destacadas de la franja de
   totalidad y su entorno. Coordenadas del núcleo urbano, altitud aproximada.
   ========================================================================= */
(function (global) {
  'use strict';

  // n = nombre · lat · lon · h = altitud (m) · band: dentro de la franja
  const PLACES = [
    // ---- Galicia / Asturias / Cantabria ----
    { n: 'A Coruña',       lat: 43.3623, lon: -8.4115, h: 5 },
    { n: 'Ferrol',         lat: 43.4840, lon: -8.2330, h: 30 },
    { n: 'Santiago',       lat: 42.8805, lon: -8.5457, h: 260 },
    { n: 'Lugo',           lat: 43.0121, lon: -7.5559, h: 454 },
    { n: 'Ribadeo',        lat: 43.5370, lon: -7.0410, h: 40 },
    { n: 'Ourense',        lat: 42.3358, lon: -7.8639, h: 139 },
    { n: 'Ponferrada',     lat: 42.5460, lon: -6.5960, h: 543 },
    { n: 'Oviedo',         lat: 43.3619, lon: -5.8494, h: 232 },
    { n: 'Gijón',          lat: 43.5322, lon: -5.6611, h: 12 },
    { n: 'Avilés',         lat: 43.5560, lon: -5.9250, h: 300 },
    { n: 'Llanes',         lat: 43.4210, lon: -4.7560, h: 25 },
    { n: 'Santander',      lat: 43.4623, lon: -3.8100, h: 15 },
    { n: 'Torrelavega',    lat: 43.3490, lon: -4.0480, h: 25 },
    { n: 'Reinosa',        lat: 43.0000, lon: -4.1370, h: 850 },
    { n: 'Castro Urdiales',lat: 43.3830, lon: -3.2200, h: 20 },

    // ---- País Vasco / Navarra / La Rioja ----
    { n: 'Bilbao',         lat: 43.2630, lon: -2.9350, h: 19 },
    { n: 'San Sebastián',  lat: 43.3183, lon: -1.9812, h: 6 },
    { n: 'Vitoria',        lat: 42.8467, lon: -2.6716, h: 525 },
    { n: 'Pamplona',       lat: 42.8125, lon: -1.6458, h: 449 },
    { n: 'Tudela',         lat: 42.0650, lon: -1.6060, h: 275 },
    { n: 'Logroño',        lat: 42.4627, lon: -2.4450, h: 384 },
    { n: 'Calahorra',      lat: 42.3040, lon: -1.9640, h: 358 },
    { n: 'Haro',           lat: 42.5770, lon: -2.8470, h: 479 },

    // ---- Castilla y León ----
    { n: 'León',           lat: 42.5987, lon: -5.5671, h: 837 },
    { n: 'Astorga',        lat: 42.4580, lon: -6.0560, h: 869 },
    { n: 'Palencia',       lat: 42.0096, lon: -4.5288, h: 749 },
    { n: 'Burgos',         lat: 42.3439, lon: -3.6969, h: 856 },
    { n: 'Aranda de Duero',lat: 41.6700, lon: -3.6890, h: 798 },
    { n: 'Miranda de Ebro',lat: 42.6870, lon: -2.9460, h: 463 },
    { n: 'Valladolid',     lat: 41.6523, lon: -4.7245, h: 698 },
    { n: 'Zamora',         lat: 41.5030, lon: -5.7440, h: 652 },
    { n: 'Salamanca',      lat: 40.9700, lon: -5.6630, h: 802 },
    { n: 'Ávila',          lat: 40.6560, lon: -4.7000, h: 1132 },
    { n: 'Segovia',        lat: 40.9429, lon: -4.1088, h: 1005 },
    { n: 'Soria',          lat: 41.7665, lon: -2.4790, h: 1063 },
    { n: 'El Burgo de Osma',lat: 41.5860, lon: -3.0670, h: 895 },

    // ---- Madrid / Castilla-La Mancha ----
    { n: 'Madrid',         lat: 40.4168, lon: -3.7038, h: 667 },
    { n: 'Alcalá de Henares',lat: 40.4820, lon: -3.3640, h: 588 },
    { n: 'Guadalajara',    lat: 40.6329, lon: -3.1669, h: 685 },
    { n: 'Sigüenza',       lat: 41.0680, lon: -2.6410, h: 1013 },
    { n: 'Molina de Aragón',lat: 40.8440, lon: -1.8850, h: 1063 },
    { n: 'Cuenca',         lat: 40.0704, lon: -2.1374, h: 946 },
    { n: 'Toledo',         lat: 39.8628, lon: -4.0273, h: 529 },
    { n: 'Albacete',       lat: 38.9940, lon: -1.8580, h: 686 },

    // ---- Aragón ----
    { n: 'Zaragoza',       lat: 41.6488, lon: -0.8891, h: 208 },
    { n: 'Huesca',         lat: 42.1400, lon: -0.4090, h: 488 },
    { n: 'Jaca',           lat: 42.5700, lon: -0.5490, h: 820 },
    { n: 'Barbastro',      lat: 42.0350, lon:  0.1270, h: 341 },
    { n: 'Teruel',         lat: 40.3456, lon: -1.1065, h: 915 },
    { n: 'Alcañiz',        lat: 41.0500, lon: -0.1320, h: 338 },
    { n: 'Calatayud',      lat: 41.3530, lon: -1.6430, h: 534 },

    // ---- Cataluña ----
    { n: 'Lleida',         lat: 41.6176, lon:  0.6200, h: 155 },
    { n: 'La Seu d\'Urgell',lat: 42.3580, lon: 1.4590, h: 691 },
    { n: 'Tremp',          lat: 42.1660, lon:  0.8950, h: 468 },
    { n: 'Tàrrega',        lat: 41.6470, lon:  1.1400, h: 373 },
    { n: 'Manresa',        lat: 41.7250, lon:  1.8260, h: 238 },
    { n: 'Vic',            lat: 41.9300, lon:  2.2550, h: 494 },
    { n: 'Girona',         lat: 41.9794, lon:  2.8214, h: 70 },
    { n: 'Figueres',       lat: 42.2660, lon:  2.9610, h: 39 },
    { n: 'Barcelona',      lat: 41.3874, lon:  2.1686, h: 12 },
    { n: 'Mataró',         lat: 41.5381, lon:  2.4445, h: 20 },
    { n: 'Sabadell',       lat: 41.5480, lon:  2.1070, h: 190 },
    { n: 'Vilafranca',     lat: 41.3460, lon:  1.6990, h: 218 },
    { n: 'Tarragona',      lat: 41.1189, lon:  1.2445, h: 68 },
    { n: 'Reus',           lat: 41.1550, lon:  1.1070, h: 118 },
    { n: 'Tortosa',        lat: 40.8120, lon:  0.5210, h: 12 },

    // ---- Comunidad Valenciana / Baleares / Murcia ----
    { n: 'Castellón',      lat: 39.9864, lon: -0.0513, h: 30 },
    { n: 'Morella',        lat: 40.6190, lon: -0.0900, h: 984 },
    { n: 'València',       lat: 39.4699, lon: -0.3763, h: 15 },
    { n: 'Gandia',         lat: 38.9680, lon: -0.1810, h: 22 },
    { n: 'Alacant',        lat: 38.3452, lon: -0.4810, h: 3 },
    { n: 'Palma',          lat: 39.5696, lon:  2.6502, h: 13 },
    { n: 'Manacor',        lat: 39.5700, lon:  3.2090, h: 110 },
    { n: 'Maó',            lat: 39.8890, lon:  4.2650, h: 44 },
    { n: 'Eivissa',        lat: 38.9090, lon:  1.4320, h: 10 },
    { n: 'Murcia',         lat: 37.9922, lon: -1.1307, h: 43 },

    // ---- Resto peninsular y fuera ----
    { n: 'Sevilla',        lat: 37.3891, lon: -5.9845, h: 7 },
    { n: 'Lisboa',         lat: 38.7223, lon: -9.1393, h: 2 },
    { n: 'Reikiavik',      lat: 64.1466, lon: -21.9426, h: 0 }
  ];

  const DEG = Math.PI / 180;

  /** Distancia en km entre dos puntos */
  function distKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG, dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Rumbo inicial de un punto a otro, en grados */
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
    const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
              Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  }

  /** Referencia más cercana a un punto: {place, km, bearing} */
  function nearest(lat, lon) {
    let best = null, bd = Infinity;
    for (const p of PLACES) {
      const d = distKm(lat, lon, p.lat, p.lon);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return null;
    return { place: best, km: bd, bearing: bearing(best.lat, best.lon, lat, lon) };
  }

  global.Places = { PLACES, nearest, distKm, bearing };
})(window);
