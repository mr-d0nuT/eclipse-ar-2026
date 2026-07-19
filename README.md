# 🌑 Eclipse AR 2026

**Cuenta atrás, circunstancias locales y realidad aumentada para el eclipse solar total del 12 de agosto de 2026.**

El primer eclipse total visible desde la España peninsular en más de un siglo. Esta app te dice, **para tu posición GPS exacta**, a qué hora empieza, cuándo es el momento álgido, cuánto dura la totalidad y —lo más importante— **dónde tienes que mirar**, usando la cámara del móvil.

👉 **[Abrir la app](https://mr-d0nut.github.io/eclipse-ar-2026/)** (funciona en Android e iOS, se instala como app nativa)

---

## ✨ Qué hace

| | |
|---|---|
| ⏱️ **Cuenta atrás inteligente** | Cambia sola de objetivo: C1 → C2 → máximo → C3 → C4. Durante la totalidad cuenta el tiempo que te queda. |
| 📊 **Barra de progreso** | Todo el eclipse en una barra, con la ventana de totalidad marcada en blanco. |
| 🕐 **Circunstancias locales exactas** | Los cinco contactos calculados desde los elementos besselianos de la NASA para tu latitud, longitud y altitud. |
| 🌗 **Simulación en tiempo real** | El disco solar con la Luna en su posición real, corona incluida durante la totalidad. Con un cursor temporal para adelantar y ver cómo se verá en cualquier instante. |
| 🧭 **Posición del Sol en vivo** | Azimut y altura actualizados cada segundo, con brújula polar y la trayectoria que hará el Sol durante el eclipse. |
| 📱 **Modo Realidad Aumentada** | Botón aparte. Cámara + brújula + acelerómetro: superpone el Sol, su recorrido y los hitos horarios sobre lo que ves. Sirve para **comprobar hoy mismo** si tu balcón, tu monte o tu playa tienen el horizonte despejado el día del eclipse. |
| 🗺️ **Mapa de la franja de totalidad** | Banda y línea central calculadas en el navegador, con marcas horarias. Toca cualquier punto del mapa para ver sus circunstancias. |
| 🚗 **Cuánto tienes que moverte** | Si estás fuera de la totalidad, te dice a cuántos km y en qué dirección está la línea central. |
| ⛰️ **Avisos de horizonte** | En España el Sol estará muy bajo. La app te avisa si tu altura solar es crítica. |
| 🔔 **Alarmas** | Vibración y notificación en cada contacto, con avisos de «quítate el filtro» y «filtro puesto YA». |
| 📅 **Exportar a calendario** | Genera un `.ics` con los cuatro contactos y recordatorios a 15 minutos. |
| 📴 **Funciona sin conexión** | Service worker: el día del eclipse puede que no tengas cobertura en el campo. |
| 🗣️ **La app te habla** | Narra sola cada fase y te va diciendo qué mirar en cada momento. Clave durante la totalidad: son ~100 segundos irrepetibles en los que **no debes mirar el móvil**. Elige la mejor voz instalada en tu dispositivo (Siri, neuronales de Google, Premium/Enhanced) en vez de la robótica por defecto. Funciona sin conexión y sin servidor. |
| 🌐 **Cinco idiomas** | Català (por defecto), castellano, inglés, francés y alemán. Se cambia con las banderas de la cabecera y se recuerda la elección. |

---

## 🔭 Precisión de los cálculos

Nada está codificado a mano: **todo se calcula en tu dispositivo** a partir de los elementos besselianos publicados por la NASA.

- **Fuente:** [Besselian Elements for the Total Solar Eclipse of 2026 Aug 12](https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm2001/SE2026Aug12Tbeselm.html) — Fred Espenak, NASA/GSFC
- **Efemérides:** VSOP87 / ELP2000-85
- **ΔT:** 71.4 s (el mismo valor usado por la NASA, para que los resultados sean comparables)
- **Método:** circunstancias locales por iteración de Newton sobre el plano fundamental (*Explanatory Supplement to the Astronomical Almanac*), con corrección por elipsoide terrestre y altitud del observador.
- **Posición solar:** algoritmo de Meeus, precisión ≈ 0.01°, con paralaje diurna y refracción atmosférica (Bennett).

### Verificación

| Ciudad | App | Referencia oficial (IGN) |
|---|---|---|
| Oviedo — magnitud | 1.0150 | 1.015 |
| Oviedo — duración totalidad | 1m 48s | 1m 48s |
| Máximo del eclipse (punto sub-sombra) | 65.227°N, 25.228°O | 65°13.5'N, 025°13.7'O |

Madrid, Barcelona y Sevilla quedan correctamente fuera de la totalidad; Bilbao, Valencia, Zaragoza, Palma y Valladolid, correctamente dentro.

---

## 📅 Resumen del eclipse

- **Máximo global:** 12 de agosto de 2026, 17:45:54 UT, al sur de Islandia
- **Duración máxima:** 2m 18s en la línea central
- **Magnitud:** 1.0386 · **Gamma:** 0.8978 · **Saros:** 126
- **Recorrido:** Ártico → Groenlandia → Islandia → norte y este de España → Baleares
- **En España:** la parcialidad empieza hacia las **19:30 CEST** y la totalidad cruza el país entre las **20:27 y las 20:33**, con el Sol muy bajo sobre el horizonte oeste

Capitales de provincia dentro de la franja de totalidad: **A Coruña, Lugo, Oviedo, Santander, Bilbao, Vitoria, León, Palencia, Burgos, Logroño, Valladolid, Soria, Segovia, Guadalajara, Cuenca, Zaragoza, Teruel, Lleida, Tarragona, Castellón, Valencia y Palma.**

---

## ⚠️ Seguridad — léelo, en serio

> **Nunca mires al Sol sin filtro homologado ISO 12312-2.**
> Las gafas de sol, las radiografías, los CD y los cristales ahumados **no protegen** y pueden causar ceguera permanente e indolora.
>
> **La única excepción** es la fase de totalidad (entre C2 y C3), cuando el disco solar está completamente cubierto. Vuelve a ponerte el filtro **en cuanto asome el primer destello**.
>
> Cámaras, prismáticos y telescopios necesitan un filtro solar **delante del objetivo**, nunca en el ocular.

---

## 🚀 Uso e instalación

No hay nada que compilar ni instalar: es HTML, CSS y JavaScript sin dependencias de build.

```bash
git clone https://github.com/mr-d0nuT/eclipse-ar-2026.git
cd eclipse-ar-2026
python3 -m http.server 8000
# abre http://localhost:8000
```

> ⚠️ El GPS, la cámara y los sensores de orientación **requieren HTTPS** (o `localhost`).
> Publicado en GitHub Pages funciona todo.

**Instalar en el móvil:**
- **Android:** menú ⋮ → «Instalar aplicación»
- **iPhone:** Compartir → «Añadir a pantalla de inicio»

---

## 🧩 Estructura

```
├── index.html                 Interfaz
├── css/style.css              Estilos
├── js/
│   ├── i18n.js                Traducciones ca / es / en
│   ├── astro.js               Posición solar, tiempo sidéreo, refracción
│   ├── eclipse.js             Motor besseliano: contactos, magnitud, franja
│   ├── ar.js                  Realidad aumentada (cámara + IMU + brújula)
│   └── app.js                 Estado, UI, cuenta atrás, mapa, alarmas
├── sw.js                      Service worker (offline)
├── manifest.webmanifest       PWA
└── icons/                     Iconos
```

Dependencias externas: solo **Leaflet** para el mapa (vía CDN). Todo lo demás es código propio.

---

## 🛠️ Compatibilidad del modo AR

| Función | Android/Chrome | iOS/Safari |
|---|---|---|
| Cámara | ✅ | ✅ |
| Brújula absoluta | ✅ `deviceorientationabsolute` | ✅ `webkitCompassHeading` |
| Permiso de sensores | automático | requiere pulsar el botón (iOS 13+) |
| Vibración | ✅ | ❌ (no soportado por Safari) |

Si la brújula va desviada, usa el botón **«Calibrar»**: dibuja un 8 en el aire con el móvil, lejos de metales e imanes.

---

## 📄 Licencia

MIT — ver [LICENSE](LICENSE).

Predicciones de eclipse por **Fred Espenak, NASA's GSFC**. Datos de referencia del **Instituto Geográfico Nacional (IGN)**.

---

*Hecho para los que llevan décadas esperando este día. Que no haya nubes.* ☀️🌑
