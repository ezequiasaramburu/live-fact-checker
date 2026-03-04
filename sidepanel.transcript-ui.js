// ============================================================
// Live Fact Checker — UI Wiring, Transcript & Claims UI
// ============================================================

(function (app) {
  'use strict';

  app = Object.assign(window.LiveFactChecker || {}, app);
  window.LiveFactChecker = app;

  const state = app.state;
  const dom = app.dom;
  const t = app.t;
  const escapeHtml = app.escapeHtml;
  const escapeRegExp = app.escapeRegExp;
  const updateStats = app.updateStats;

  // ==========================================================
  // UI SETUP
  // ==========================================================
  function setupUI() {
    dom.settingsBtn.onclick = () => dom.settingsPanel.classList.toggle('hidden');
    dom.saveSettingsBtn.onclick = () => {
      app.saveSettings();
      dom.settingsPanel.classList.add('hidden');
      app.setStatus(t('status_settings_saved'));
    };
    dom.contextToggle.onclick = () => { dom.contextFields.classList.toggle('hidden'); dom.contextToggle.classList.toggle('open'); };
    dom.startBtn.onclick = () => app.startFactChecking && app.startFactChecking();
    dom.stopBtn.onclick = () => app.stopFactChecking && app.stopFactChecking();
    dom.clearBtn.onclick = () => app.clearTranscript && app.clearTranscript();
    dom.exportBtn.onclick = () => app.exportReport && app.exportReport();
    dom.analyzeNowBtn.onclick = () => app.analyzeNow && app.analyzeNow();
    dom.clarSubmit.onclick = () => app.submitClarification && app.submitClarification();
    dom.clarInput.onkeydown = e => { if (e.key === 'Enter' && app.submitClarification) app.submitClarification(); };
    dom.clarDismiss.onclick = () => { dom.clarBanner.classList.add('hidden'); state.pendingClarification = null; };
    dom.closeModal.onclick = closeModal;
    dom.modal.querySelector('.modal-backdrop').onclick = closeModal;
    dom.transcript.onclick = e => { const m = e.target.closest('.claim-mark'); if (m) openClaimDetail(m.dataset.claimId); };

    // Claim hover tooltip
    dom.transcript.addEventListener('mouseover', e => {
      const mark = e.target.closest('.claim-mark');
      if (!mark) { hideClaimTooltip(); return; }
      const claim = state.claims.get(mark.dataset.claimId);
      if (claim) showClaimTooltip(mark, claim);
    });
    dom.transcript.addEventListener('mouseout', e => {
      const related = e.relatedTarget;
      if (!related || !related.closest || !related.closest('.claim-mark')) hideClaimTooltip();
    });
  }

  // ==========================================================
  // TRANSCRIPT HANDLING
  // ==========================================================
  const recentTexts = [];
  const MAX_RECENT = 15;

  function handleTranscriptText(text) {
    if (!text || !state.isRunning) return;

    // Secondary dedup: skip if this exact text (normalized) was recently received
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm.length < 2) return;
    for (const prev of recentTexts) {
      if (prev === norm) return;
      // Skip if new text is entirely contained in a recent entry
      if (prev.includes(norm)) return;
    }
    recentTexts.push(norm);
    if (recentTexts.length > MAX_RECENT) recentTexts.shift();

    const entry = { id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), text, timestamp: Date.now() };
    state.transcript.push(entry);
    state.fullText += (state.fullText ? ' ' : '') + text;
    state.pendingText += (state.pendingText ? ' ' : '') + text;
    state.wordCount += text.split(/\s+/).filter(Boolean).length;
    renderTranscriptEntry(entry);
    updateStats();
    autoScroll();
  }

  function renderTranscriptEntry(entry, useVideoTime) {
    const ph = dom.transcript.querySelector('.placeholder-text');
    if (ph) ph.remove();
    const block = document.createElement('span');
    block.className = 'transcript-block';
    block.dataset.entryId = entry.id;
    const timeStr = useVideoTime
      ? app.formatVideoTime(entry.timestamp)
      : new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    block.innerHTML = `<span class="transcript-time">${timeStr}</span>${escapeHtml(entry.text)} `;
    dom.transcript.appendChild(block);
  }

  function autoScroll() {
    const el = dom.transcriptWrap;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }

  function clearTranscript() {
    state.transcript = []; state.fullText = ''; state.pendingText = '';
    state.wordCount = 0; state.claims.clear(); state.claimIdCounter = 0;
    dom.transcript.innerHTML = '<p class="placeholder-text">Transcript will appear here once you start...</p>';
    updateStats();
  }

  // ==========================================================
  // HIGHLIGHTING
  // ==========================================================
  function highlightClaimInTranscript(claim) {
    const blocks = dom.transcript.querySelectorAll('.transcript-block');
    const escaped = escapeRegExp(claim.text);

    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.parentElement.classList.contains('claim-mark')) nodes.push(walker.currentNode);
      }
      for (const node of nodes) {
        const match = node.textContent.match(new RegExp(`(${escaped})`, 'i'));
        if (match) {
          const idx = match.index;
          const before = node.textContent.substring(0, idx);
          const matched = node.textContent.substring(idx, idx + match[1].length);
          const after = node.textContent.substring(idx + match[1].length);
          const mark = document.createElement('mark');
          mark.className = 'claim-mark claim-pending';
          mark.dataset.claimId = claim.id;
          mark.dataset.tooltip = t('tooltip_verifying');
          mark.textContent = matched;
          const frag = document.createDocumentFragment();
          if (before) frag.appendChild(document.createTextNode(before));
          frag.appendChild(mark);
          if (after) frag.appendChild(document.createTextNode(after));
          node.parentNode.replaceChild(frag, node);
          return;
        }
      }
    }

    // Fuzzy fallback: find best matching block
    const claimWords = claim.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let best = null, bestScore = 0;
    for (const b of blocks) {
      const bt = b.textContent.toLowerCase();
      const score = claimWords.filter(w => bt.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best && bestScore >= Math.min(3, claimWords.length)) {
      const ind = document.createElement('mark');
      ind.className = 'claim-mark claim-pending';
      ind.dataset.claimId = claim.id;
      ind.dataset.tooltip = t('tooltip_verifying');
      ind.textContent = ` [${claim.summary.substring(0, 50)}...]`;
      ind.style.fontSize = '12px';
      best.appendChild(ind);
    }
  }

  function updateClaimInTranscript(claim) {
    const marks = dom.transcript.querySelectorAll(`[data-claim-id="${claim.id}"]`);
    for (const m of marks) {
      m.className = 'claim-mark';
      const v = (claim.verdict || 'uncertain').toLowerCase();
      if (v === 'true') { m.classList.add('claim-true'); m.dataset.tooltip = t('tooltip_true'); }
      else if (v === 'false') { m.classList.add('claim-false'); m.dataset.tooltip = t('tooltip_false'); }
      else { m.classList.add('claim-uncertain'); m.dataset.tooltip = t('tooltip_uncertain'); }
    }
  }

  // ==========================================================
  // CLAIM HOVER TOOLTIP
  // ==========================================================
  function showClaimTooltip(el, claim) {
    const tooltip = document.getElementById('claimTooltip');
    const v = (claim.verdict || 'pending').toLowerCase();
    const icons = { true: '\u2713', false: '\u2717', uncertain: '?', pending: '\u21BB' };

    const verdictDiv = tooltip.querySelector('.ct-verdict');
    verdictDiv.className = 'ct-verdict ' + v;
    verdictDiv.textContent = (icons[v] || '?') + ' ' + t('verdict_' + v);

    const summaryDiv = tooltip.querySelector('.ct-summary');
    if (claim.explanation) {
      const maxLen = 150;
      summaryDiv.textContent = claim.explanation.substring(0, maxLen) + (claim.explanation.length > maxLen ? '\u2026' : '');
    } else {
      summaryDiv.textContent = v === 'pending' ? t('tooltip_verifying') : '';
    }

    const sourcesDiv = tooltip.querySelector('.ct-sources');
    if (claim.sources?.length) {
      sourcesDiv.innerHTML = claim.sources.slice(0, 2).map(s => {
        const title = (s.title || s.url || '').substring(0, 55);
        return '<span class="ct-src">\uD83D\uDCC4 ' + escapeHtml(title) + '</span>';
      }).join('');
    } else {
      sourcesDiv.innerHTML = '';
    }

    const footerDiv = tooltip.querySelector('.ct-footer');
    footerDiv.textContent = claim.status === 'verified' ? t('tooltip_click') : '';

    // Position above the element
    tooltip.classList.remove('hidden');
    const rect = el.getBoundingClientRect();
    const tRect = tooltip.getBoundingClientRect();
    let top = rect.top - tRect.height - 8;
    let left = rect.left + (rect.width / 2) - (tRect.width / 2);

    if (top < 4) top = rect.bottom + 8;
    if (left < 4) left = 4;
    if (left + tRect.width > window.innerWidth - 4) left = window.innerWidth - tRect.width - 4;

    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  function hideClaimTooltip() {
    document.getElementById('claimTooltip').classList.add('hidden');
  }

  // ==========================================================
  // MODAL
  // ==========================================================
  function openClaimDetail(id) {
    const c = state.claims.get(id);
    if (!c) return;
    const v = (c.verdict || 'uncertain').toLowerCase();
    const icons = { true: '\u2713', false: '\u2717', uncertain: '?' };
    dom.modalVerdict.className = 'modal-verdict ' + v;
    dom.modalVerdict.innerHTML = `<span class="verdict-icon">${icons[v] || '?'}</span> ${t('verdict_' + v)}`;
    dom.modalClaim.textContent = c.text;
    dom.modalExplanation.textContent = c.explanation || 'Verification in progress...';
    if (c.sources?.length) {
      dom.modalSources.innerHTML = `<div class="source-label">${t('label_sources')}</div>` + c.sources.map(s => `<a href="${escapeHtml(s.url || s)}" target="_blank">${escapeHtml(s.title || s.url || s)}</a>`).join('');
    } else { dom.modalSources.innerHTML = ''; }
    if (c.confidence > 0) {
      const pct = Math.round(c.confidence * 100);
      const col = v === 'true' ? 'var(--green)' : v === 'false' ? 'var(--red)' : 'var(--yellow)';
      dom.modalConfidence.innerHTML = `${t('label_confidence')}: ${pct}%<div class="confidence-bar"><div class="confidence-fill" style="width:${pct}%;background:${col}"></div></div>`;
    } else { dom.modalConfidence.innerHTML = ''; }
    dom.modal.classList.remove('hidden');
  }

  function closeModal() { dom.modal.classList.add('hidden'); }

  // ==========================================================
  // EXPORTS
  // ==========================================================
  app.setupUI = setupUI;
  app.handleTranscriptText = handleTranscriptText;
  app.renderTranscriptEntry = renderTranscriptEntry;
  app.autoScroll = autoScroll;
  app.clearTranscript = clearTranscript;
  app.highlightClaimInTranscript = highlightClaimInTranscript;
  app.updateClaimInTranscript = updateClaimInTranscript;
  app.showClaimTooltip = showClaimTooltip;
  app.hideClaimTooltip = hideClaimTooltip;
  app.openClaimDetail = openClaimDetail;
  app.closeModal = closeModal;

})(window.LiveFactChecker || {});

