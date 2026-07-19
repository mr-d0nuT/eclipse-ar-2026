/* =========================================================================
   voice.js — La app te habla

   Por qué la síntesis del sistema y no una voz de la nube:
   esta app es estática y pública, así que cualquier clave de API quedaría a
   la vista de todo el mundo; y el día del eclipse puede que estés en el campo
   sin cobertura, justo cuando más falta hace. La Web Speech API funciona sin
   red y sin servidor.

   El truco para que NO suene a robot: el navegador elige por defecto la
   primera voz de la lista, que suele ser la peor (compacta, tipo eSpeak).
   Aquí puntuamos todas las voces instaladas y nos quedamos con la mejor
   disponible: Siri en iOS, las neuronales de Google en Android, las Premium
   o Enhanced en macOS.
   ========================================================================= */
(function (global) {
  'use strict';

  const SUPPORTED = typeof speechSynthesis !== 'undefined' &&
                    typeof SpeechSynthesisUtterance !== 'undefined';

  const V = {
    enabled: false,
    unlocked: false,          // iOS exige un gesto del usuario antes de hablar
    voice: null,
    voiceName: '',
    quality: 'none',          // 'natural' | 'standard' | 'basic' | 'none'
    fallbackLang: null,       // idioma realmente usado si no hay voz del elegido
    supported: SUPPORTED,
    wakeLock: null
  };

  try { V.enabled = localStorage.getItem('eclipse-voice') === '1'; } catch (e) {}

  // ---------------------------------------------------------------------
  // Selección de la mejor voz instalada
  // ---------------------------------------------------------------------
  function scoreVoice(v, wantLang) {
    const n = (v.name || '') + ' ' + (v.voiceURI || '');
    let s = 0;

    // Calidad por familia de motor
    if (/siri/i.test(n))                      s += 60;
    if (/neural|natural/i.test(n))            s += 50;
    if (/premium|enhanced/i.test(n))          s += 35;
    if (/google/i.test(n))                    s += 25;
    if (/microsoft/i.test(n))                 s += 12;
    if (/compact|espeak|pico|festival/i.test(n)) s -= 60;

    // Coincidencia de idioma
    const lang = (v.lang || '').toLowerCase().replace('_', '-');
    if (lang === wantLang.full) s += 30;
    else if (lang.split('-')[0] === wantLang.base) s += 20;
    else return -1000;                        // idioma distinto: descartada

    if (v.localService) s += 4;               // funciona sin cobertura
    if (v.default) s += 2;
    return s;
  }

  /** Mapea el idioma de la app a un locale de voz, con alternativas */
  function localesFor(lang) {
    const M = {
      ca: ['ca-ES', 'ca'],
      es: ['es-ES', 'es-MX', 'es-US', 'es'],
      en: ['en-GB', 'en-US', 'en'],
      fr: ['fr-FR', 'fr-CA', 'fr'],
      de: ['de-DE', 'de-AT', 'de-CH', 'de']
    };
    return M[lang] || M.es;
  }

  function pickVoice(lang) {
    if (!SUPPORTED) return null;
    const voices = speechSynthesis.getVoices() || [];
    if (!voices.length) return null;

    V.fallbackLang = null;
    // Probamos el idioma pedido y, si no hay ninguna voz, degradamos:
    // el catalán es el que más papeletas tiene de faltar en Android.
    const chain = lang === 'ca' ? ['ca', 'es'] : [lang];

    for (const L of chain) {
      let best = null, bestScore = -999;
      for (const loc of localesFor(L)) {
        const want = { full: loc.toLowerCase(), base: loc.split('-')[0].toLowerCase() };
        for (const v of voices) {
          const sc = scoreVoice(v, want);
          if (sc > bestScore) { bestScore = sc; best = v; }
        }
        if (best && bestScore > -1000) break;
      }
      if (best && bestScore > -1000) {
        if (L !== lang) V.fallbackLang = L;
        V.voice = best;
        V.voiceName = best.name;
        V.quality = bestScore >= 45 ? 'natural' : bestScore >= 20 ? 'standard' : 'basic';
        return best;
      }
    }
    V.voice = null; V.voiceName = ''; V.quality = 'none';
    return null;
  }

  // La lista de voces llega de forma asíncrona en casi todos los navegadores
  let onReady = [];
  function refresh() {
    const lang = (global.I18N && I18N.lang) || 'ca';
    pickVoice(lang);
    if (V.voice) { onReady.forEach(f => { try { f(); } catch (e) {} }); onReady = []; }
  }
  if (SUPPORTED) {
    refresh();
    speechSynthesis.addEventListener('voiceschanged', refresh);
    setTimeout(refresh, 400);
    setTimeout(refresh, 1500);
  }

  // ---------------------------------------------------------------------
  // Habla
  // ---------------------------------------------------------------------
  /**
   * @param {string} text
   * @param {{urgent?:boolean, force?:boolean}} [opt]
   *        urgent: corta lo que se esté diciendo (avisos de seguridad)
   *        force:  habla aunque la voz esté desactivada (prueba manual)
   */
  function speak(text, opt) {
    opt = opt || {};
    if (!SUPPORTED) return false;
    if (!V.enabled && !opt.force) return false;
    if (!text) return false;

    if (!V.voice) pickVoice((global.I18N && I18N.lang) || 'ca');

    if (opt.urgent) speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(text);
    if (V.voice) { u.voice = V.voice; u.lang = V.voice.lang; }
    else u.lang = (global.I18N && I18N.locale) || 'ca-ES';

    // Un pelín más lento que el valor por defecto: se entiende mucho mejor
    // al aire libre y suena menos atropellado.
    u.rate = opt.urgent ? 1.05 : 0.96;
    u.pitch = 1.0;
    u.volume = 1.0;

    try { speechSynthesis.speak(u); } catch (e) { return false; }
    return true;
  }

  function cancel() { if (SUPPORTED) try { speechSynthesis.cancel(); } catch (e) {} }

  /**
   * Desbloqueo por gesto del usuario. iOS no deja hablar si la primera
   * llamada no viene de un toque, así que la activación es manual a propósito.
   */
  function unlock() {
    if (!SUPPORTED) return;
    V.unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Mantener la pantalla encendida mientras la voz está activa
  // (si el móvil se duerme, deja de avisarte justo el día que importa)
  // ---------------------------------------------------------------------
  async function keepAwake(on) {
    if (!('wakeLock' in navigator)) return;
    try {
      if (on && !V.wakeLock) {
        V.wakeLock = await navigator.wakeLock.request('screen');
        V.wakeLock.addEventListener('release', () => { V.wakeLock = null; });
      } else if (!on && V.wakeLock) {
        await V.wakeLock.release(); V.wakeLock = null;
      }
    } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && V.enabled) keepAwake(true);
  });

  function setEnabled(on) {
    V.enabled = !!on;
    try { localStorage.setItem('eclipse-voice', V.enabled ? '1' : '0'); } catch (e) {}
    if (V.enabled) { unlock(); keepAwake(true); } else { cancel(); keepAwake(false); }
  }

  function onVoiceReady(fn) {
    if (V.voice) fn(); else onReady.push(fn);
  }

  global.Voice = {
    get supported() { return SUPPORTED; },
    get enabled() { return V.enabled; },
    get voiceName() { return V.voiceName; },
    get quality() { return V.quality; },
    get fallbackLang() { return V.fallbackLang; },
    speak, cancel, setEnabled, pickVoice, refresh, onVoiceReady, unlock
  };
})(window);
