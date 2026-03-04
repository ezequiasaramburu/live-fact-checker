// ============================================================
// Live Fact Checker — Side Panel Core
// Shared namespace, state, DOM refs, i18n, and utilities.
// ============================================================

(function (app) {
  'use strict';

  // Ensure a single shared namespace
  app = Object.assign(window.LiveFactChecker || {}, app);
  window.LiveFactChecker = app;

  // ==========================================================
  // STATE
  // ==========================================================
  const state = {
    isRunning: false,
    mode: 'youtube',
    tabId: null,
    tabUrl: '',

    transcript: [],
    fullText: '',
    pendingText: '',
    wordCount: 0,

    claims: new Map(),
    claimIdCounter: 0,

    context: { speaker: '', event: '', custom: '', platform: '', title: '', url: '', description: '', date: '' },
    startTime: null,
    clarifications: {},
    pendingClarification: null,

    apiKey: '',  // user enters their own key in Settings
    checkInterval: 10000,
    minWords: 20,
    language: 'auto',  // 'auto' = use Chrome's language

    checkTimer: null,
    recognition: null,

    // Tab audio capture state
    audioStream: null,
    audioContext: null,
    audioTimer: null,
    audioBuffer: [],

    // Whisper sandbox
    whisperIframe: null,
    whisperReady: false,
    whisperLoading: false,
    whisperRequestId: 0,
    whisperCallbacks: {},
    whisperCurrentModel: '',
    batchMode: false,
  };

  // ==========================================================
  // DOM
  // ==========================================================
  const $ = (s) => document.querySelector(s);
  const dom = {
    statusDot: $('#statusDot'), statusText: $('#statusText'),
    settingsBtn: $('#settingsBtn'), settingsPanel: $('#settingsPanel'),
    apiKeyInput: $('#apiKeyInput'), langSelect: $('#langSelect'), saveSettingsBtn: $('#saveSettingsBtn'),
    contextToggle: $('#contextToggle'), contextFields: $('#contextFields'),
    contextBadge: $('#contextBadge'),
    ctxSpeaker: $('#ctxSpeaker'), ctxEvent: $('#ctxEvent'), ctxCustom: $('#ctxCustom'),
    startBtn: $('#startBtn'), stopBtn: $('#stopBtn'), clearBtn: $('#clearBtn'), exportBtn: $('#exportBtn'),
    progressWrap: $('#progressWrap'), progressFill: $('#progressFill'), progressLabel: $('#progressLabel'),
    statsBar: $('#statsBar'),
    statWords: $('#statWords'), statClaims: $('#statClaims'),
    statTrue: $('#statTrue'), statFalse: $('#statFalse'), statUncertain: $('#statUncertain'),
    clarBanner: $('#clarificationBanner'), clarQuestion: $('#clarificationQuestion'),
    clarInput: $('#clarificationInput'), clarSubmit: $('#submitClarification'),
    clarDismiss: $('#dismissClarification'),
    analyzeNowBtn: $('#analyzeNowBtn'),
    transcriptWrap: $('#transcriptContainer'), transcript: $('#transcript'),
    modal: $('#claimModal'), modalVerdict: $('#modalVerdict'), modalClaim: $('#modalClaim'),
    modalExplanation: $('#modalExplanation'), modalSources: $('#modalSources'),
    modalConfidence: $('#modalConfidence'), closeModal: $('#closeModal'),
  };

  // ==========================================================
  // i18n
  // ==========================================================
  const i18n = {
    en: {
      status_ready: 'Ready — pick a mode and press Start',
      settings_apikey: 'Gemini API Key',
      settings_interval: 'Check Interval',
      settings_language: 'Language',
      settings_language_hint: 'Affects transcription, analysis language, and the interface.',
      settings_mode: 'Transcription Mode',
      settings_mode_hint: '<b>YouTube Captions</b>: reads CC directly from the page — best for YouTube.<br><b>Tab Audio</b>: captures tab audio and transcribes locally with Whisper (~40MB model, first time only).<br><b>Microphone</b>: uses your mic to pick up audio from speakers.',
      settings_save: 'Save Settings',
      mode_youtube: 'YouTube Captions (reads CC text)',
      mode_tab_audio: 'Tab Audio (local Whisper — works on ANY tab)',
      mode_mic: 'Microphone (Web Speech API via your mic)',
      context_title: 'Context',
      context_badge: 'auto-detected',
      context_speaker: 'Speaker / Channel',
      context_speaker_ph: 'e.g. President Biden',
      context_event: 'Event / Topic',
      context_event_ph: 'e.g. State of the Union 2025',
      context_custom: 'Additional Context',
      context_custom_ph: 'Any extra info the AI should know...',
      btn_start: 'Start Fact-Checking',
      btn_stop: 'Stop',
      btn_clear: 'Clear',
      btn_export: 'Export',
      stat_words: 'words',
      stat_claims: 'claims',
      stat_true: 'true',
      stat_false: 'false',
      stat_unclear: 'unclear',
      clar_title: 'AI needs your help',
      clar_placeholder: 'Type your answer...',
      clar_send: 'Send',
      transcript_placeholder: 'Transcript will appear here once you start...',
      footer_built: 'Built by',
      status_settings_saved: 'Settings saved',
      status_listening_yt: 'Listening via YouTube captions',
      status_listening_mic: 'Listening via microphone...',
      status_analyzing: 'Analyzing for claims...',
      status_stopped: 'Stopped',
      status_rate_limited: 'Rate limited — will retry automatically',
      status_downloading_whisper: 'Downloading Whisper model...',
      status_whisper_loaded: 'Whisper model loaded! Capturing audio...',
      status_report_exported: 'Report exported!',
      status_connecting_yt: 'Connecting to YouTube...',
      status_no_captions: 'No captions detected yet. Make sure CC is on.',
      tooltip_verifying: 'Verifying...',
      tooltip_true: 'TRUE — click for details',
      tooltip_false: 'FALSE — click for details',
      tooltip_uncertain: 'UNCERTAIN — click for details',
      modal_sources: 'Sources',
      modal_confidence: 'Confidence',
      btn_analyze_now: 'Analyze Video',
      tooltip_click: 'Click for full details',
      status_fetching_transcript: 'Fetching full transcript...',
      status_no_transcript: 'No transcript available for this video',
      status_identifying_phase: 'Identifying claims... ({current}/{total})',
      status_verifying_phase: 'Verifying claims... ({current}/{total})',
      status_analysis_complete: 'Analysis complete',
      verdict_true: 'TRUE',
      verdict_false: 'FALSE',
      verdict_uncertain: 'UNCERTAIN',
      verdict_pending: 'VERIFYING...',
      label_confidence: 'Confidence',
      label_sources: 'Sources',
    },
    es: {
      status_ready: 'Listo — elegí un modo y presioná Iniciar',
      settings_apikey: 'Clave API de Gemini',
      settings_interval: 'Intervalo de chequeo',
      settings_language: 'Idioma',
      settings_language_hint: 'Afecta la transcripción, el idioma del análisis y la interfaz.',
      settings_mode: 'Modo de transcripción',
      settings_mode_hint: '<b>Subtítulos YouTube</b>: lee los CC directamente de la página — ideal para YouTube.<br><b>Audio de pestaña</b>: captura audio y transcribe localmente con Whisper (~40MB, solo la primera vez).<br><b>Micrófono</b>: usa tu micrófono para captar el audio.',
      settings_save: 'Guardar',
      mode_youtube: 'Subtítulos YouTube (lee texto CC)',
      mode_tab_audio: 'Audio de pestaña (Whisper local — funciona en CUALQUIER pestaña)',
      mode_mic: 'Micrófono (Web Speech API)',
      context_title: 'Contexto',
      context_badge: 'auto-detectado',
      context_speaker: 'Orador / Canal',
      context_speaker_ph: 'ej. Javier Milei',
      context_event: 'Evento / Tema',
      context_event_ph: 'ej. Discurso legislativas 2025',
      context_custom: 'Contexto adicional',
      context_custom_ph: 'Cualquier información extra que la IA deba saber...',
      btn_start: 'Iniciar Fact-Check',
      btn_stop: 'Detener',
      btn_clear: 'Limpiar',
      btn_export: 'Exportar',
      stat_words: 'palabras',
      stat_claims: 'claims',
      stat_true: 'verdad',
      stat_false: 'falso',
      stat_unclear: 'incierto',
      clar_title: 'La IA necesita tu ayuda',
      clar_placeholder: 'Escribí tu respuesta...',
      clar_send: 'Enviar',
      transcript_placeholder: 'La transcripción aparecerá acá al iniciar...',
      footer_built: 'Creado por',
      status_settings_saved: 'Configuración guardada',
      status_listening_yt: 'Escuchando subtítulos de YouTube',
      status_listening_mic: 'Escuchando micrófono...',
      status_analyzing: 'Analizando claims...',
      status_stopped: 'Detenido',
      status_rate_limited: 'Límite de tasa — reintentará automáticamente',
      status_downloading_whisper: 'Descargando modelo Whisper...',
      status_whisper_loaded: '¡Modelo Whisper cargado! Capturando audio...',
      status_report_exported: '¡Reporte exportado!',
      status_connecting_yt: 'Conectando a YouTube...',
      status_no_captions: 'Sin subtítulos detectados. Asegurate de activar CC.',
      tooltip_verifying: 'Verificando...',
      tooltip_true: 'VERDADERO — clic para detalles',
      tooltip_false: 'FALSO — clic para detalles',
      tooltip_uncertain: 'INCIERTO — clic para detalles',
      modal_sources: 'Fuentes',
      modal_confidence: 'Confianza',
      btn_analyze_now: 'Analizar Video',
      tooltip_click: 'Clic para ver detalles',
      status_fetching_transcript: 'Obteniendo transcripción completa...',
      status_no_transcript: 'No hay transcripción disponible para este video',
      status_identifying_phase: 'Identificando claims... ({current}/{total})',
      status_verifying_phase: 'Verificando claims... ({current}/{total})',
      status_analysis_complete: 'Análisis completado',
      verdict_true: 'VERDADERO',
      verdict_false: 'FALSO',
      verdict_uncertain: 'INCIERTO',
      verdict_pending: 'VERIFICANDO...',
      label_confidence: 'Confianza',
      label_sources: 'Fuentes',
    }
  };

  /** Get a translated string */
  function t(key) {
    const lang = getEffectiveLanguage();
    return (i18n[lang] && i18n[lang][key]) || i18n.en[key] || key;
  }

  /** Apply translations to all data-i18n elements */
  function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const val = t(key);
      if (val) el.innerHTML = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const val = t(key);
      if (val) el.placeholder = val;
    });
  }

  // Resolve effective language code
  function getEffectiveLanguage() {
    if (state.language === 'es' || state.language === 'en') return state.language;
    // Fallback: detect from browser
    const nav = (navigator.language || 'en').split('-')[0].toLowerCase();
    return nav === 'es' ? 'es' : 'en';
  }

  // ==========================================================
  // UTILS
  // ==========================================================
  function formatVideoTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ==========================================================
  // STATS
  // ==========================================================
  function updateStats() {
    dom.statWords.textContent = state.wordCount;
    dom.statClaims.textContent = state.claims.size;
    let tCount = 0, fCount = 0, uCount = 0;
    for (const c of state.claims.values()) {
      if (c.verdict === 'TRUE') tCount++;
      else if (c.verdict === 'FALSE') fCount++;
      else if (c.status === 'verified') uCount++;
    }
    dom.statTrue.textContent = tCount;
    dom.statFalse.textContent = fCount;
    dom.statUncertain.textContent = uCount;
  }

  // ==========================================================
  // EXPORT TO NAMESPACE
  // ==========================================================
  app.state = state;
  app.$ = $;
  app.dom = dom;
  app.i18n = i18n;
  app.t = t;
  app.applyLanguage = applyLanguage;
  app.getEffectiveLanguage = getEffectiveLanguage;
  app.formatVideoTime = formatVideoTime;
  app.escapeHtml = escapeHtml;
  app.escapeRegExp = escapeRegExp;
  app.sleep = sleep;
  app.updateStats = updateStats;

})(window.LiveFactChecker || {});

