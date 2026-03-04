// ============================================================
// Live Fact Checker — Transcription Modes & Whisper Sandbox
// ============================================================

(function (app) {
  'use strict';

  app = Object.assign(window.LiveFactChecker || {}, app);
  window.LiveFactChecker = app;

  const state = app.state;
  const dom = app.dom;
  const t = app.t;
  const sleep = app.sleep;
  const getEffectiveLanguage = app.getEffectiveLanguage;

  // ==========================================================
  // MODE 1: YOUTUBE CAPTIONS
  // ==========================================================
  async function startYouTubeMode() {
    if (!state.tabId) { app.setStatus('No active tab', 'error'); return; }

    app.setStatus(t('status_connecting_yt'), 'checking');

    // First check content script is alive
    const alive = await pingContent();
    if (!alive) {
      app.setStatus('Injecting content script...', 'checking');
      await injectContentScript();
      await sleep(1000);
    }

    chrome.runtime.sendMessage({ type: 'START_CAPTIONS', tabId: state.tabId }, resp => {
      if (resp?.error) {
        app.setStatus('Content script error: ' + resp.error + '. Try reloading the YouTube page.', 'error');
      } else if (resp?.success) {
        const info = [];
        if (resp.ccStatus === 'enabled') info.push('CC turned on');
        else if (resp.ccStatus === 'already_on') info.push('CC is on');
        else if (resp.ccStatus === 'no_button') info.push('CC button not found — enable manually');
        if (resp.isLive) info.push('LIVE');
        app.setStatus(t('status_listening_yt') + (info.length ? ' (' + info.join(', ') + ')' : ''), 'live');
      }
    });
  }

  function stopYouTubeMode() {
    if (state.tabId) chrome.runtime.sendMessage({ type: 'STOP_CAPTIONS', tabId: state.tabId });
  }

  function pingContent() {
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'PING_CONTENT', tabId: state.tabId }, resp => {
        r(resp?.alive === true);
      });
    });
  }

  function injectContentScript() {
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'INJECT_CONTENT_SCRIPT', tabId: state.tabId }, resp => {
        r(resp?.success === true);
      });
    });
  }

  // ==========================================================
  // WHISPER SANDBOX (local model via transformers.js)
  // ==========================================================
  function initWhisperSandbox() {
    if (state.whisperIframe) return;

    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('whisper-sandbox.html');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    state.whisperIframe = iframe;

    // Listen for messages from the sandbox
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || !msg.type) return;

      switch (msg.type) {
        case 'SANDBOX_ALIVE':
          console.log('[Whisper] Sandbox iframe alive');
          break;

        case 'WHISPER_STATUS':
          console.log('[Whisper]', msg.status, msg.message);
          if (msg.status === 'ready') {
            state.whisperReady = true;
            state.whisperLoading = false;
            dom.progressWrap.classList.add('hidden');
            app.setStatus(t('status_whisper_loaded'), 'live');
          } else if (msg.status === 'error') {
            state.whisperLoading = false;
            dom.progressWrap.classList.add('hidden');
            app.setStatus('Whisper error: ' + msg.message, 'error');
          } else if (msg.status === 'downloading' && msg.progress != null) {
            dom.progressWrap.classList.remove('hidden');
            dom.progressFill.style.width = msg.progress + '%';
            dom.progressLabel.textContent = msg.progress + '%';
            app.setStatus(t('status_downloading_whisper'), 'checking');
          } else if (msg.status === 'loading') {
            dom.progressWrap.classList.remove('hidden');
            dom.progressFill.style.width = '0%';
            dom.progressLabel.textContent = '...';
            app.setStatus(msg.message, 'checking');
          }
          break;

        case 'WHISPER_RESULT':
          if (msg.requestId && state.whisperCallbacks[msg.requestId]) {
            state.whisperCallbacks[msg.requestId](msg);
            delete state.whisperCallbacks[msg.requestId];
          }
          break;

        case 'PONG':
          console.log('[Whisper] Pong:', msg);
          break;
      }
    });
  }

  function loadWhisperModel() {
    const lang = getEffectiveLanguage();
    const isEnglish = (lang === 'en');
    const modelName = isEnglish ? 'Xenova/whisper-tiny.en' : 'Xenova/whisper-tiny';

    // If already loaded with the right model, skip
    if (state.whisperReady && state.whisperCurrentModel === modelName) return;
    if (state.whisperLoading) return;

    state.whisperLoading = true;
    state.whisperReady = false;
    state.whisperCurrentModel = modelName;

    state.whisperIframe.contentWindow.postMessage({
      type: 'INIT_WHISPER',
      model: modelName,
      language: lang
    }, '*');
  }

  function whisperTranscribe(audioFloat32) {
    return new Promise((resolve) => {
      const requestId = 'wr-' + (++state.whisperRequestId);
      state.whisperCallbacks[requestId] = (result) => {
        resolve(result.text || '');
      };
      state.whisperIframe.contentWindow.postMessage({
        type: 'TRANSCRIBE',
        audio: audioFloat32,
        requestId,
        language: getEffectiveLanguage()
      }, '*');
      // Timeout after 30 seconds
      setTimeout(() => {
        if (state.whisperCallbacks[requestId]) {
          delete state.whisperCallbacks[requestId];
          resolve('');
        }
      }, 30000);
    });
  }

  // ==========================================================
  // MODE 2: TAB AUDIO → LOCAL WHISPER TRANSCRIPTION
  // ==========================================================
  async function startTabAudioMode() {
    app.setStatus('Setting up local Whisper...', 'checking');

    // 1. Initialize the Whisper sandbox iframe
    initWhisperSandbox();
    await sleep(500);
    loadWhisperModel();

    // 2. Capture tab audio
    app.setStatus('Requesting tab audio (select the tab to share)...', 'checking');

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: 1, height: 1, frameRate: 1 },
        audio: true
      });

      // Drop video
      stream.getVideoTracks().forEach(t => t.stop());
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        app.setStatus('No audio — make sure you check "Share tab audio"', 'error');
        return;
      }

      state.audioStream = new MediaStream(audioTracks);

      // 3. Set up AudioContext at 16kHz (Whisper requirement)
      state.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = state.audioContext.createMediaStreamSource(state.audioStream);
      const processor = state.audioContext.createScriptProcessor(4096, 1, 1);
      state.audioBuffer = [];

      source.connect(processor);
      processor.connect(state.audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (!state.isRunning) return;
        const data = e.inputBuffer.getChannelData(0);
        state.audioBuffer.push(new Float32Array(data));
      };

      app.setStatus(state.whisperReady ? t('status_whisper_loaded') : t('status_downloading_whisper'), state.whisperReady ? 'live' : 'checking');

      // 4. Every 5 seconds, send accumulated audio to Whisper
      state.audioTimer = setInterval(async () => {
        if (!state.isRunning || state.audioBuffer.length === 0) return;
        if (!state.whisperReady) return; // Wait for model to load

        // Combine all buffered Float32Arrays into one
        const totalLength = state.audioBuffer.reduce((sum, buf) => sum + buf.length, 0);
        const combined = new Float32Array(totalLength);
        let offset = 0;
        for (const buf of state.audioBuffer) {
          combined.set(buf, offset);
          offset += buf.length;
        }
        state.audioBuffer = [];

        // Skip if too short (< 0.5 seconds at 16kHz)
        if (combined.length < 8000) return;

        app.setStatus('Transcribing (local Whisper)...', 'checking');

        const text = await whisperTranscribe(combined);
        if (text && text.trim().length > 1) {
          app.handleTranscriptText(text.trim());
        }

        app.setStatus('Capturing & transcribing (local Whisper)...', 'live');
      }, 5000);

      // Handle user revoking share
      audioTracks[0].onended = () => {
        app.setStatus('Tab audio share ended', 'error');
        stopTabAudioMode();
      };

    } catch (err) {
      console.error('Tab audio error:', err);
      if (err.name === 'NotAllowedError') {
        app.setStatus('Tab share cancelled — click Start again', 'error');
      } else {
        app.setStatus('Audio error: ' + err.message, 'error');
      }
      state.isRunning = false;
      dom.startBtn.classList.remove('hidden');
      dom.stopBtn.classList.add('hidden');
    }
  }

  function stopTabAudioMode() {
    if (state.audioTimer) { clearInterval(state.audioTimer); state.audioTimer = null; }
    if (state.audioContext) {
      try { state.audioContext.close(); } catch { /* ignore */ }
      state.audioContext = null;
    }
    if (state.audioStream) {
      state.audioStream.getTracks().forEach(t => t.stop());
      state.audioStream = null;
    }
    state.audioBuffer = [];
  }

  // ==========================================================
  // MODE 3: MICROPHONE (Web Speech API)
  // ==========================================================
  function startMicMode() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      app.setStatus('Speech recognition not supported in this browser', 'error');
      return;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.recognition = new SR();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    const lang = getEffectiveLanguage();
    const langRegion = { en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE', it: 'it-IT', nl: 'nl-NL', pl: 'pl-PL', ru: 'ru-RU', uk: 'uk-UA', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR', vi: 'vi-VN', th: 'th-TH', sv: 'sv-SE' };
    state.recognition.lang = langRegion[lang] || lang;

    let lastFinal = '';

    state.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (text && text !== lastFinal) {
            lastFinal = text;
            app.handleTranscriptText(text);
          }
        }
      }
    };

    state.recognition.onerror = (e) => {
      if (e.error === 'no-speech') return;
      if (e.error === 'not-allowed') app.setStatus('Microphone access denied — allow in browser', 'error');
      else console.warn('Speech error:', e.error);
    };

    state.recognition.onend = () => {
      if (state.isRunning && state.mode === 'mic') {
        try { state.recognition.start(); } catch { /* ignore */ }
      }
    };

    try {
      state.recognition.start();
      app.setStatus(t('status_listening_mic'), 'live');
    } catch {
      app.setStatus('Could not start microphone', 'error');
    }
  }

  function stopMicMode() {
    if (state.recognition) {
      state.recognition.onend = null;
      try { state.recognition.stop(); } catch { /* ignore */ }
      state.recognition = null;
    }
  }

  // ==========================================================
  // EXPORTS
  // ==========================================================
  app.startYouTubeMode = startYouTubeMode;
  app.stopYouTubeMode = stopYouTubeMode;
  app.pingContent = pingContent;
  app.injectContentScript = injectContentScript;

  app.initWhisperSandbox = initWhisperSandbox;
  app.loadWhisperModel = loadWhisperModel;
  app.whisperTranscribe = whisperTranscribe;

  app.startTabAudioMode = startTabAudioMode;
  app.stopTabAudioMode = stopTabAudioMode;

  app.startMicMode = startMicMode;
  app.stopMicMode = stopMicMode;

})(window.LiveFactChecker || {});

