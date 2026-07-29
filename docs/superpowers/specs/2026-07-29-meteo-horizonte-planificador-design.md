# Nubes, horizonte real y planificador

**Fecha:** 29 de julio de 2026 · **Eclipse:** 12 de agosto de 2026 (quedan 14 días)

## Problema

La app responde muy bien a *cuándo* y *hacia dónde* mirar. No responde a las dos
preguntas que deciden de verdad si ves el eclipse:

1. **¿Habrá nubes?** El 12 de agosto a las 20:29 en la cornisa cantábrica el
   estrato bajo es el enemigo número uno. La app no dice nada del tiempo.
2. **¿Me tapa el terreno?** El Sol estará a 3-10° de altura. Un cerro a 5 km
   te come la totalidad entera. El modo AR sirve para comprobarlo *estando
   allí*, no para decidir desde casa.

Además hay un error de producto: el aviso «estás a X km de la línea central»
optimiza hacia la línea central en vez de hacia el borde de la banda. Desde
Barcelona manda 180 km al sur (mar adentro, hacia Baleares) cuando bastan ~80 km
al suroeste para pisar totalidad en Tarragona.

## Datos de referencia

Calculados con el motor actual, hora local de Madrid:

| Punto | Cobertura | Totalidad | Alt. Sol máx | Az. máx |
|---|---|---|---|---|
| Barcelona | 99,83 % | — | 3,9° | 286,5° |
| Mataró | 99,60 % | — | 3,8° | 286,6° |
| Tarragona | 100 % | 60 s | 4,4° | 286,0° |
| Lleida | 100 % | 28 s | 5,0° | 285,5° |

Ventana de azimut C1→C4: **277° → 295°** (18°). El Sol **se pone a las 20:55**,
antes de C4 (21:21): la mitad final del eclipse no se ve desde el este peninsular.

## Arquitectura

Sigue siendo estático, sin build. Módulos nuevos con el mismo patrón
IIFE + global que los existentes. El motor besseliano (`eclipse.js`), la
astronomía (`astro.js`), el AR (`ar.js`) y la voz (`voice.js`) **no se tocan**.

```
js/horizon.js    Perfil de horizonte desde datos de elevación
js/weather.js    Nubosidad prevista + climatología histórica
js/planner.js    Rejilla de candidatos, puntuación y ranking
js/i18n2.js      Cadenas nuevas en los 5 idiomas (vía I18N.extend)
```

Única modificación a `i18n.js`: exponer `extend(more)` para fusionar tablas.

## 1. Estructura en pestañas

Barra inferior fija de 3 pestañas. El dock actual (AR + ↑) se integra en ella.

| Pestaña | Contenido |
|---|---|
| **AHORA** | Cuenta atrás · Veredicto · nubes · horizonte · avisos · herramientas · AR |
| **PLANIFICAR** | Mapa con franja y capa de calidad · ranking top-10 · ciudades · cuánto moverte |
| **CIELO** | Simulación · brújula · fases · circunstancias locales · seguridad |

Las tarjetas actuales se reparten entre pestañas; no se reescriben. La pestaña
activa se guarda en `localStorage`.

## 2. Tarjeta de veredicto

Vive arriba de AHORA y responde de un vistazo con un semáforo global
(bueno / regular / malo) derivado de tres factores:

- **Totalidad**: sí/no y duración.
- **Horizonte**: ángulo del terreno en la dirección del máximo frente a la
  altura del Sol, con el margen en grados.
- **Nubes**: porcentaje previsto en la ventana 19-22 h, con la nubosidad baja
  destacada aparte, y etiqueta de fiabilidad según los días que falten.

Cada factor se degrada por separado: si no hay red, el veredicto se emite con lo
que haya y dice qué le falta.

## 3. `horizon.js`

**Fuente:** API de elevación de Open-Meteo (DEM Copernicus GLO-90, sin clave,
CORS abierto, hasta 100 coordenadas por petición). Verificada en vivo.

**Muestreo:** 11 rayos de 276° a 296° (paso 2°), 24 muestras por rayo de 200 m a
40 km con paso logarítmico → 264 sondeos ≈ 3 peticiones.

**Ángulo de horizonte**, con curvatura terrestre y refracción:

```
α = atan2(Δh − d²/(2·R_ef), d)      R_ef = R / (1 − 0,13)
```

Por cada rayo se queda el α máximo del perfil. El resultado se cachea en
`localStorage` por punto redondeado a ~200 m; el terreno no cambia.

**Salida visual:** silueta del terreno con la trayectoria del Sol superpuesta.
Se ve de un golpe si el monte se lo come y a qué hora.

## 4. `weather.js`

**Previsión:** Open-Meteo forecast, sin clave. `cloud_cover` total/baja/media/alta
y `visibility`, hora a hora, `timezone=Europe/Madrid`. Ventana 19-22 h del 12 de
agosto. La ventana de 16 días alcanza justo la fecha desde hoy.

La nubosidad **baja** va destacada: es la que arruina un Sol a 4° de altura.

**Fiabilidad:** etiqueta según días restantes (>10 orientativa, 4-10 razonable,
<4 fiable). Una previsión a 14 días no es accionable y la app no debe fingir que sí.

**Climatología:** media de los últimos 10 años del 12 de agosto a la misma hora
en el mismo punto, vía `archive-api.open-meteo.com` (una petición corta por año,
cacheada indefinidamente: el histórico no cambia). Da lo único accionable hoy:
«7 de cada 10 años el cielo estaba despejado aquí a esta hora». Bajo demanda.

**Sin cobertura:** último dato cacheado, con su fecha visible.

## 5. `planner.js` + `spots.js`

El usuario no quiere coordenadas de una rejilla: quiere **sitios concretos a
los que pueda ir en coche y desde los que se vea el horizonte**. Un punto de
rejilla puede caer en un campo de cultivo, una finca vallada o un barranco.

**Candidatos** (`spots.js`, OpenStreetMap vía Overpass, sin clave):
miradores, collados, cimas, áreas de pícnic y áreas de descanso. Con nombre y,
cuando la llevan, con altitud.

1. Consulta de sitios en la caja de búsqueda. La caja es el círculo del usuario
   **recortado con el tramo de la franja que cae cerca**: sin ese recorte,
   Overpass devuelve sus primeros 900 nodos —en Cataluña, todos del Pirineo— y
   la banda de totalidad, que queda al suroeste, se pierde entera.
2. Circunstancias locales de cada sitio **en local, sin red**, usando su
   altitud real.
3. Puntuación previa → 12 finalistas, separados al menos 3 km.
4. Para los finalistas: acceso rodado (una consulta con un `out count` por
   punto, medio segundo), horizonte del terreno y nubes.
5. Los que no tienen carretera a 300 m se caen de la lista, salvo que
   quedasen tan pocos que la respuesta dejara de ser útil.
6. Capa de calor sobre el mapa con la rejilla local (no cuesta red).

Si Overpass no responde, se cae con elegancia a una búsqueda por rejilla que no
depende de nada externo.

**Puntuación multiplicativa**, no promediada: un factor malo debe hundir el
resultado, no compensarse con los buenos. De nada sirve la totalidad más larga
del país si tienes una montaña delante o no puedes llegar.

```
calidad = valorEclipse × extinción × horizonte × cielo × acceso × tipo × edificios
```

### Bandas de distancia

El selector no ofrece un radio máximo sino cuatro bandas: **< 1 km, 1-2 km,
2-5 km y 5-25 km**. A esas distancias la duración de la totalidad no cambia
(un kilómetro son décimas de segundo), así que dentro de una banda el orden lo
deciden el relieve, la altitud del sitio y los edificios: exactamente lo que
hace falta para elegir dónde ponerse cerca de casa.

En una banda estrecha puede no haber ni un sitio catalogado. Antes que
responder «nada», se rellena con puntos de una rejilla fina dentro de la banda:
sin nombre, pero con su relieve y sus edificios mirados igual.

### Edificios: lo que el modelo de elevación no ve

El primer despliegue recomendó **«Els Quatre Cantons»**, en Montbrió del Camp:
un **cruce de calles** etiquetado en OSM como `tourism=viewpoint`. El terreno
allí es llano, el horizonte sale a 0° y puntuaba perfecto — con las casas
delante. El nº 1 de aquella lista, el Balcó del Mediterrani de Tarragona,
tenía 49 edificios en la línea de visión: mira al sureste sobre el mar, y el
eclipse está al oeste-noroeste, detrás de toda la ciudad.

El DEM da la forma del terreno, no lo que hay encima, y `tourism=viewpoint` no
es garantía de nada. Así que se cuentan los edificios **en la dirección del
Sol**, que es la única que importa: las casas que tengas a la espalda dan igual.

Con el Sol a 4°, un edificio de altura *h* tapa hasta *h*/tan(4°) ≈ 14·*h*
metros: ocho metros de casa tapan 115 m, y un bloque de cinco plantas, 215 m.
Se sondea un círculo de 180 m centrado a 160 m en el azimut del máximo, lo que
cubre de 0 a 340 m. Aparte, un sondeo de 250 m alrededor detecta que estás
dentro de un casco urbano.

| Edificios en la línea de visión | Factor |
|---|---|
| 0 (y poca edificación alrededor) | 1,00 |
| 1-2 | 0,45 |
| 3-9 | 0,18 |
| 10 o más | 0,06 |

Los sitios con tres o más se caen de la lista, salvo que quedasen tan pocos que
la respuesta dejara de ser útil.

### Overpass falla de dos maneras

Y hay que tratarlas distinto. **Servidor ocupado** (504, o un 200 con un error
de texto donde esperabas JSON) se le pasa en segundos: se reintenta una vez.
**Cuota de la IP agotada** (429) no se arregla reintentando, y deja al usuario
dos minutos mirando «Buscando miradores…»: se abandona al momento y el
planificador tira de rejilla.

Carreteras y edificios van en **una sola consulta**. Separadas eran dos
peticiones seguidas al mismo servidor, y la segunda se llevaba el «servidor
ocupado» con bastante frecuencia: el usuario veía la mitad de las etiquetas
en blanco.

Sustituye el aviso de «distancia a la línea central» por «distancia al mejor
sitio alcanzable», que es la pregunta real.

## 6. Presupuesto de peticiones

Medido contra el servicio real: **Open-Meteo corta a los 600 sondeos de
elevación por minuto** y devuelve un 429. El primer diseño pedía casi el doble.

`netcache.js` lleva la cuenta del gasto (persistida, porque el límite es por IP
y recargar la página no lo reinicia), deduplica peticiones idénticas en vuelo y
avisa con los segundos que faltan en vez de dejar medio resultado vacío. La
búsqueda **se encoge sola** si no hay cuota para todo: cuatro sitios bien
mirados valen más que un mensaje de error.

| Operación | Sondeos |
|---|---|
| Perfil de horizonte completo | 14 rayos × 22 distancias = 309 |
| Horizonte de un finalista | 3 rayos × 10 distancias = 31 |
| Rejilla del mapa de calor | 150 |

## Degradación y riesgo

Todo es aditivo. Sin red, las funciones nuevas muestran su último valor conocido
o un estado vacío explícito, y el resto de la app queda exactamente como hoy.

Versionado: `?v=7` en todos los assets y caché del service worker a `v9`,
siguiendo el patrón ya establecido en el repo para que la actualización llegue
al instante.

Todas las cadenas nuevas, en los cinco idiomas.

## Fuera de alcance (YAGNI)

- Routing por carretera (OSRM): dependencia frágil, con límite de peticiones y
  sin funcionamiento offline. Se comprueba que hay carretera cerca, que es lo
  que decide si puedes ir, pero no se calcula el tiempo de conducción.
- Reverse geocoding online: la lista local de ciudades da la referencia.
- Precacheado de tiles del mapa.
- Suite de tests del motor astronómico.
