// ============================================================
// Live Fact Checker — Main Entry Point
// Init, start/stop, scheduling, and batch analysis.
// ============================================================

(function (app) {
  'use strict';

  app = Object.assign(window.LiveFactChecker || {}, app);
  window.LiveFactChecker = app;

  const state = app.state;
  const dom = app.dom;
  const t = app.t;

  // ==========================================================
  // INIT
  // ==========================================================
  async function init() {
    await app.loadSettings();
    app.applyLanguage();
    app.setupUI();
    app.setupMessageListener();
    await app.fetchActiveTab();
    await app.fetchPageContext();
    app.setStatus(t('status_ready'));
  }

  // ==========================================================
  // START / STOP
  // ==========================================================
  async function startFactChecking() {
    state.mode = document.querySelector('input[name="mode"]:checked')?.value || 'youtube';
    app.saveSettings();
    state.isRunning = true;
    state.startTime = Date.now();
    dom.startBtn.classList.add('hidden');
    dom.stopBtn.classList.remove('hidden');
    dom.statsBar.classList.remove('hidden');

    state.context.speaker = dom.ctxSpeaker.value.trim();
    state.context.event = dom.ctxEvent.value.trim();
    state.context.custom = dom.ctxCustom.value.trim();

    if (state.mode === 'youtube') {
      await app.startYouTubeMode();
    } else if (state.mode === 'tab_audio') {
      await app.startTabAudioMode();
    } else {
      app.startMicMode();
    }

    // Use adaptive timer instead of fixed interval
    // Free tier: 15 RPM = 1 call every 4s. With identify (1) + verify (up to 3),
    // that's 4 calls per round = need ~16s minimum between rounds.
    scheduleNextClaimCheck();
  }

  function getAdaptiveInterval() {
    // Base: user-configured interval (default 10s)
    let interval = state.checkInterval;
    // If budget is tight (fewer than 4 slots = can't do 1 identify + 3 verify), slow down
    const avail = app.availableRequests();
    if (avail < 4) interval = Math.max(interval, 15000);
    if (avail < 2) interval = Math.max(interval, 30000);
    if (avail < 1) interval = Math.max(interval, app.msUntilNextSlot() + 2000);
    return Math.min(interval, 120000);
  }

  function scheduleNextClaimCheck() {
    if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
    if (!state.isRunning) return;
    const interval = getAdaptiveInterval();
    state.checkTimer = setTimeout(async () => {
      await app.runClaimCheck();
      scheduleNextClaimCheck(); // schedule next after this one finishes
    }, interval);
  }

  function stopFactChecking() {
    state.isRunning = false;
    dom.startBtn.classList.remove('hidden');
    dom.stopBtn.classList.add('hidden');
    app.setStatus(t('status_stopped'));
    if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }

    if (!state.batchMode) {
      if (state.mode === 'youtube') app.stopYouTubeMode();
      else if (state.mode === 'tab_audio') app.stopTabAudioMode();
      else app.stopMicMode();
    }
    state.batchMode = false;
    dom.progressWrap.classList.add('hidden');
  }

  // ==========================================================
  // FULL VIDEO ANALYSIS
  // ==========================================================
  async function analyzeNow() {
    // ── Full-video batch analysis ──
    // 1. Fetch the complete transcript from YouTube
    app.setStatus(t('status_fetching_transcript'), 'checking');
    dom.progressWrap.classList.remove('hidden');
    dom.progressFill.style.width = '0%';
    dom.progressLabel.textContent = '0%';

    const lang = app.getEffectiveLanguage();
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'GET_FULL_TRANSCRIPT', tabId: state.tabId, language: lang },
          resp => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
            else resolve(resp);
          }
        );
      });
    } catch (err) {
      app.setStatus(t('status_no_transcript'), 'error');
      dom.progressWrap.classList.add('hidden');
      return;
    }

    if (!result?.success || !result?.segments?.length) {
      app.setStatus(result?.error || t('status_no_transcript'), 'error');
      dom.progressWrap.classList.add('hidden');
      return;
    }

    // 2. Stop any ongoing live monitoring
    if (state.isRunning) {
      state.isRunning = false;
      if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
      if (state.mode === 'youtube') app.stopYouTubeMode();
      else if (state.mode === 'tab_audio') app.stopTabAudioMode();
      else app.stopMicMode();
    }

    // 3. Enter batch mode
    app.clearTranscript();
    state.batchMode = true;
    state.isRunning = true;
    state.startTime = Date.now();
    dom.startBtn.classList.add('hidden');
    dom.stopBtn.classList.remove('hidden');
    dom.statsBar.classList.remove('hidden');

    // 4. Merge tiny caption segments into ~20-second paragraphs
    const merged = [];
    let buf = '', bufStart = 0;
    for (const seg of result.segments) {
      if (!buf) {
        bufStart = seg.startMs; buf = seg.text;
      } else if (seg.startMs - bufStart < 20000) {
        buf += ' ' + seg.text;
      } else {
        merged.push({ text: buf.trim(), startMs: bufStart });
        bufStart = seg.startMs; buf = seg.text;
      }
    }
    if (buf) merged.push({ text: buf.trim(), startMs: bufStart });

    // 5. Render the full transcript at once
    let fullText = '';
    for (const seg of merged) {
      const entry = {
        id: 't-' + seg.startMs + '-' + Math.random().toString(36).slice(2, 6),
        text: seg.text,
        timestamp: seg.startMs
      };
      state.transcript.push(entry);
      fullText += (fullText ? ' ' : '') + seg.text;
      state.wordCount += seg.text.split(/\s+/).filter(Boolean).length;
      app.renderTranscriptEntry(entry, true);
    }
    state.fullText = fullText;
    app.updateStats();

    // 6. Phase 1 — Identify claims chunk by chunk (0 → 40% progress)
    const CHUNK_WORDS = 150;
    const words = fullText.split(/\s+/).filter(Boolean);
    const totalChunks = Math.ceil(words.length / CHUNK_WORDS);

    for (let i = 0; i < totalChunks; i++) {
      if (!state.isRunning) break;

      const chunkText = words.slice(i * CHUNK_WORDS, (i + 1) * CHUNK_WORDS).join(' ');
      const pct = Math.round(((i + 1) / totalChunks) * 40);
      dom.progressFill.style.width = pct + '%';
      dom.progressLabel.textContent = pct + '%';
      app.setStatus(
        t('status_identifying_phase').replace('{current}', i + 1).replace('{total}', totalChunks),
        'checking'
      );

      try {
        const claims = await app.identifyClaims(chunkText);
        if (claims?.length) {
          for (const cl of claims) {
            const id = 'c-' + (++state.claimIdCounter);
            const obj = {
              id, text: cl.claim || cl.text || '',
              summary: cl.summary || cl.claim || '',
              searchQuery: cl.searchQuery || '',
              status: 'pending', verdict: null,
              explanation: '', sources: [], confidence: 0,
              needsClarification: false, clarificationQuestion: null
            };
            state.claims.set(id, obj);
            app.highlightClaimInTranscript(obj);
            app.updateStats();
          }
        }
      } catch (err) {
        if (err.message.startsWith('RATE_LIMITED')) {
          const waitMs = parseInt(err.message.split(':')[1]) || 30000;
          app.setStatus(t('status_rate_limited'), 'checking');
          await app.sleep(waitMs);
          i--; // retry this chunk
          continue;
        }
        console.error('Batch identification error:', err);
      }
    }

    // 7. Phase 2 — Verify each claim one by one (40 → 100% progress)
    const claimsToVerify = [...state.claims.values()].filter(c => c.status === 'pending');
    const totalClaims = claimsToVerify.length;
    let verified = 0;

    for (let i = 0; i < claimsToVerify.length; i++) {
      if (!state.isRunning) break;
      const claim = claimsToVerify[i];

      const pct = 40 + Math.round(((verified + 1) / totalClaims) * 60);
      dom.progressFill.style.width = Math.min(pct, 99) + '%';
      dom.progressLabel.textContent = Math.min(pct, 99) + '%';
      app.setStatus(
        t('status_verifying_phase').replace('{current}', verified + 1).replace('{total}', totalClaims),
        'checking'
      );

      await app.verifyClaim(claim);

      if (claim.status === 'verified') {
        verified++;
      } else {
        // Rate limited — verifyClaim already waited, retry
        if (!claim._retries) claim._retries = 0;
        claim._retries++;
        if (claim._retries > 5) {
          claim.status = 'verified';
          claim.verdict = 'UNCERTAIN';
          claim.explanation = 'Could not verify — rate limit exceeded';
          app.updateClaimInTranscript(claim);
          app.updateStats();
          verified++;
        } else {
          i--; // retry this claim
          continue;
        }
      }
    }

    // 8. Done!
    dom.progressFill.style.width = '100%';
    dom.progressLabel.textContent = '100%';
    app.setStatus(t('status_analysis_complete'));
    state.isRunning = false;
    state.batchMode = false;
    dom.startBtn.classList.remove('hidden');
    dom.stopBtn.classList.add('hidden');
    setTimeout(() => dom.progressWrap.classList.add('hidden'), 4000);
  }

  // ==========================================================
  // EXPORTS & BOOT
  // ==========================================================
  app.init = init;
  app.startFactChecking = startFactChecking;
  app.stopFactChecking = stopFactChecking;
  app.analyzeNow = analyzeNow;
  app.getAdaptiveInterval = getAdaptiveInterval;
  app.scheduleNextClaimCheck = scheduleNextClaimCheck;

  // Boot
  init();

})(window.LiveFactChecker || {});

