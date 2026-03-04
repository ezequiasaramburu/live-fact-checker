// ============================================================
// Live Fact Checker — Settings & Page Context
// ============================================================

(function (app) {
  'use strict';

  app = Object.assign(window.LiveFactChecker || {}, app);
  window.LiveFactChecker = app;

  const state = app.state;
  const dom = app.dom;
  const t = app.t;

  // ==========================================================
  // SETTINGS
  // ==========================================================
  async function loadSettings() {
    return new Promise(r => {
      chrome.storage.local.get(['apiKey', 'checkInterval', 'mode', 'language', 'clarifications'], d => {
        if (d.apiKey) state.apiKey = d.apiKey;
        if (d.checkInterval) state.checkInterval = d.checkInterval;
        if (d.mode) state.mode = d.mode;
        if (d.language) state.language = d.language;
        if (d.clarifications) state.clarifications = d.clarifications;
        dom.apiKeyInput.value = state.apiKey;
        dom.langSelect.value = state.language;
        const intRadio = document.querySelector(`input[name="interval"][value="${state.checkInterval}"]`);
        if (intRadio) intRadio.checked = true;
        const modeRadio = document.querySelector(`input[name="mode"][value="${state.mode}"]`);
        if (modeRadio) modeRadio.checked = true;
        r();
      });
    });
  }

  function saveSettings() {
    state.apiKey = dom.apiKeyInput.value.trim() || state.apiKey;
    state.checkInterval = +(document.querySelector('input[name="interval"]:checked')?.value || 10000);
    state.mode = document.querySelector('input[name="mode"]:checked')?.value || 'youtube';
    state.language = dom.langSelect.value || 'en';
    chrome.storage.local.set({
      apiKey: state.apiKey,
      checkInterval: state.checkInterval,
      mode: state.mode,
      language: state.language,
      clarifications: state.clarifications
    });
    app.applyLanguage();
  }

  // ==========================================================
  // TAB & CONTEXT
  // ==========================================================
  async function fetchActiveTab() {
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, resp => {
        if (resp?.tab) {
          state.tabId = resp.tab.id;
          state.tabUrl = resp.tab.url || '';
          const isYT = state.tabUrl.includes('youtube.com');
          if (!isYT && state.mode === 'youtube') {
            state.mode = 'tab_audio';
            const radio = document.querySelector('input[name="mode"][value="tab_audio"]');
            if (radio) radio.checked = true;
          }
        }
        r();
      });
    });
  }

  async function fetchPageContext() {
    if (!state.tabId) return;
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT', tabId: state.tabId }, resp => {
        if (resp?.context) {
          const c = resp.context;
          state.context.platform = c.platform || '';
          state.context.title = c.title || '';
          state.context.url = c.url || '';
          state.context.description = c.description || '';
          state.context.date = c.date || '';
          if (c.channel && !dom.ctxSpeaker.value) { dom.ctxSpeaker.value = c.channel; state.context.speaker = c.channel; }
          if (c.title && !dom.ctxEvent.value) { dom.ctxEvent.value = c.title; state.context.event = c.title; }
          if (c.isLive) { dom.contextBadge.textContent = 'LIVE'; dom.contextBadge.style.color = '#22c55e'; }
        }
        r();
      });
    });
  }

  function getContextString() {
    const parts = [];
    const sp = dom.ctxSpeaker.value.trim();
    const ev = dom.ctxEvent.value.trim();
    const cu = dom.ctxCustom.value.trim();
    if (sp) parts.push('Speaker/Source: ' + sp);
    if (ev) parts.push('Event/Topic: ' + ev);
    if (cu) parts.push('Additional: ' + cu);
    if (state.context.platform) parts.push('Platform: ' + state.context.platform);
    if (state.context.url) parts.push('URL: ' + state.context.url);
    if (state.context.date) parts.push('Date: ' + state.context.date);
    if (state.context.description) parts.push('Video description: ' + state.context.description.substring(0, 300));
    const cl = Object.entries(state.clarifications);
    if (cl.length) { parts.push('Clarifications:'); cl.forEach(([q, a]) => parts.push('  Q: ' + q + ' A: ' + a)); }
    return parts.join('\n') || 'No context.';
  }

  // ==========================================================
  // STATUS
  // ==========================================================
  function setStatus(text, type) {
    dom.statusText.textContent = text;
    dom.statusDot.className = 'status-dot' + (type ? ' ' + type : '');
  }

  // ==========================================================
  // EXPORTS
  // ==========================================================
  app.loadSettings = loadSettings;
  app.saveSettings = saveSettings;
  app.fetchActiveTab = fetchActiveTab;
  app.fetchPageContext = fetchPageContext;
  app.getContextString = getContextString;
  app.setStatus = setStatus;

})(window.LiveFactChecker || {});

