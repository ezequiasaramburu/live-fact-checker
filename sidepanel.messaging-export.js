// ============================================================
// Live Fact Checker — Messaging & Report Export
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

  // ==========================================================
  // MESSAGE LISTENER
  // ==========================================================
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'CAPTION_UPDATE') app.handleTranscriptText(msg.text);
      else if (msg.type === 'CONTEXT_UPDATE' && msg.context) {
        if (msg.context.channel && !dom.ctxSpeaker.value) { dom.ctxSpeaker.value = msg.context.channel; }
        if (msg.context.title && !dom.ctxEvent.value) { dom.ctxEvent.value = msg.context.title; }
      }
      else if (msg.type === 'CONTENT_STATUS') {
        app.setStatus(msg.message, 'checking');
      }
    });
  }

  // ==========================================================
  // EXPORT REPORT
  // ==========================================================
  function exportReport() {
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const speaker = dom.ctxSpeaker.value.trim() || 'Unknown';
    const event = dom.ctxEvent.value.trim() || state.context.title || 'Untitled';
    const videoDate = state.context.date || '';
    const url = state.context.url || '';
    const platform = state.context.platform || '';
    const description = state.context.description || '';
    const duration = state.startTime ? Math.round((Date.now() - state.startTime) / 60000) : 0;

    // Gather claim stats
    let trueCount = 0, falseCount = 0, uncertainCount = 0;
    const claimList = [];
    for (const c of state.claims.values()) {
      if (c.verdict === 'TRUE') trueCount++;
      else if (c.verdict === 'FALSE') falseCount++;
      else uncertainCount++;
      claimList.push(c);
    }

    // Build transcript HTML with inline claim highlights
    let transcriptHtml = '';
    for (const entry of state.transcript) {
      const tStr = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      let text = escapeHtml(entry.text);
      // Highlight claims inline
      for (const c of claimList) {
        const escaped = escapeRegExp(escapeHtml(c.text));
        const v = (c.verdict || 'uncertain').toLowerCase();
        const cls = v === 'true' ? 'claim-true' : v === 'false' ? 'claim-false' : 'claim-uncertain';
        const label = v === 'true' ? 'TRUE' : v === 'false' ? 'FALSE' : 'UNCERTAIN';
        text = text.replace(new RegExp(`(${escaped})`, 'i'), `<mark class="${cls}" title="${label}: ${escapeHtml(c.explanation?.substring(0, 100) || '')}">$1</mark>`);
      }
      transcriptHtml += `<div class="t-entry"><span class="t-time">${tStr}</span>${text}</div>\n`;
    }

    // Build claims detail HTML
    let claimsHtml = '';
    for (const c of claimList) {
      const v = (c.verdict || 'uncertain').toLowerCase();
      const cls = v === 'true' ? 'v-true' : v === 'false' ? 'v-false' : 'v-uncertain';
      const icon = v === 'true' ? '\u2713' : v === 'false' ? '\u2717' : '?';
      const label = (c.verdict || 'PENDING').toUpperCase();
      const pct = c.confidence ? Math.round(c.confidence * 100) : 0;
      const sourcesHtml = (c.sources || []).map(s => `<a href="${escapeHtml(s.url || s)}" target="_blank">${escapeHtml(s.title || s.url || s)}</a>`).join('');
      claimsHtml += `
      <div class="claim-card ${cls}">
        <div class="claim-header">
          <span class="verdict-badge ${cls}"><span class="v-icon">${icon}</span> ${label}</span>
          <span class="confidence">${pct}% confidence</span>
        </div>
        <blockquote>"${escapeHtml(c.text)}"</blockquote>
        <p class="explanation">${escapeHtml(c.explanation || '')}</p>
        ${sourcesHtml ? '<div class="sources">Sources: ' + sourcesHtml + '</div>' : ''}
      </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fact Check Report — ${escapeHtml(event)}</title>
<style>
::root { --bg:#0f1117; --bg2:#181a24; --bg3:#1e2130; --border:#2a2e3f; --text:#e2e4ed; --dim:#8b8fa3; --muted:#5c6078; --accent:#6366f1; --green:#22c55e; --yellow:#eab308; --red:#ef4444; }
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:0}
.container{max-width:860px;margin:0 auto;padding:32px 24px 48px}
/* Header */
.report-header{text-align:center;padding:40px 24px 32px;background:linear-gradient(135deg,#1a1040 0%,#0f1117 50%,#0a1628 100%);border-bottom:1px solid var(--border);margin-bottom:32px}
.report-header h1{font-size:28px;font-weight:800;letter-spacing:-0.5px;margin-bottom:4px}
.report-header .subtitle{color:var(--dim);font-size:15px;margin-bottom:16px}
.meta-row{display:flex;gap:20px;justify-content:center;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.meta-row span{display:flex;align-items:center;gap:4px}
.meta-row a{color:var(--accent);text-decoration:none}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:32px}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
.stat-card .num{font-size:28px;font-weight:800}
.stat-card .label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-top:2px}
.stat-card.st-true .num{color:var(--green)} .stat-card.st-false .num{color:var(--red)} .stat-card.st-uncertain .num{color:var(--yellow)}
/* Sections */
h2{font-size:18px;font-weight:700;margin-bottom:16px;padding-bottom:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
h2 .count{font-size:13px;font-weight:500;color:var(--muted);background:var(--bg3);padding:2px 10px;border-radius:12px}
/* Claims */
.claim-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;border-left:4px solid var(--muted)}
.claim-card.v-true{border-left-color:var(--green)} .claim-card.v-false{border-left-color:var(--red)} .claim-card.v-uncertain{border-left-color:var(--yellow)}
.claim-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.verdict-badge{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:4px;padding:3px 10px;border-radius:6px}
.verdict-badge.v-true{background:rgba(34,197,94,.15);color:var(--green)} .verdict-badge.v-false{background:rgba(239,68,68,.15);color:var(--red)} .verdict-badge.v-uncertain{background:rgba(234,179,8,.15);color:var(--yellow)}
.v-icon{font-size:14px}
.confidence{font-size:11px;color:var(--muted)}
blockquote{font-style:italic;color:var(--text);padding:8px 14px;margin:8px 0;border-left:3px solid var(--border);background:var(--bg3);border-radius:0 6px 6px 0;font-size:14px}
.explanation{font-size:13px;color:var(--dim);margin-top:6px;line-height:1.5}
.sources{font-size:12px;margin-top:8px;color:var(--muted)}
.sources a{color:var(--accent);text-decoration:none;margin-right:12px}
.sources a:hover{text-decoration:underline}
/* Transcript */
.transcript-section{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:32px}
.t-entry{margin-bottom:6px;font-size:13.5px;line-height:1.7}
.t-time{font-size:10px;color:var(--muted);margin-right:8px;font-variant-numeric:tabular-nums}
mark{padding:1px 3px;border-radius:3px;border-bottom:2px solid transparent}
.claim-true{background:rgba(34,197,94,.15);border-bottom-color:var(--green)}
.claim-false{background:rgba(239,68,68,.15);border-bottom-color:var(--red)}
.claim-uncertain{background:rgba(234,179,8,.15);border-bottom-color:var(--yellow)}
/* Footer */
.report-footer{text-align:center;padding:24px;color:var(--muted);font-size:12px;border-top:1px solid var(--border);margin-top:24px}
.report-footer a{color:var(--accent);text-decoration:none}
/* Print */
@media print{body{background:#fff;color:#111}.report-header{background:#f5f5f5}.stat-card,.claim-card,.transcript-section{border-color:#ddd;background:#fafafa}mark{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
@media(max-width:600px){.stats-grid{grid-template-columns:repeat(3,1fr)}.container{padding:16px}}
</style>
</head>
<body>
<div class="report-header">
  <h1>Fact Check Report</h1>
  <div class="subtitle">${escapeHtml(event)}</div>
  <div class="meta-row">
    <span><strong>By:</strong> ${escapeHtml(speaker)}</span>
    ${videoDate ? '<span><strong>Date:</strong> ' + escapeHtml(videoDate) + '</span>' : ''}
    ${platform ? '<span><strong>Platform:</strong> ' + escapeHtml(platform) + '</span>' : ''}
    <span><strong>Analyzed:</strong> ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)}</span>
    ${duration ? '<span><strong>Duration:</strong> ' + duration + ' min</span>' : ''}
  </div>
  ${url ? '<div class="meta-row" style="margin-top:8px"><a href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(url) + '</a></div>' : ''}
</div>
<div class="container">
  <div class="stats-grid">
    <div class="stat-card"><div class="num">${state.wordCount.toLocaleString()}</div><div class="label">Words</div></div>
    <div class="stat-card"><div class="num">${state.claims.size}</div><div class="label">Claims</div></div>
    <div class="stat-card st-true"><div class="num">${trueCount}</div><div class="label">True</div></div>
    <div class="stat-card st-false"><div class="num">${falseCount}</div><div class="label">False</div></div>
    <div class="stat-card st-uncertain"><div class="num">${uncertainCount}</div><div class="label">Uncertain</div></div>
  </div>

  ${claimList.length > 0 ? `
  <h2>Claims Analysis <span class="count">${claimList.length} claims</span></h2>
  ${claimsHtml}
  ` : '<p style="color:var(--muted);text-align:center;padding:20px">No claims were identified during this session.</p>'}

  <h2 style="margin-top:32px">Full Transcript <span class="count">${state.transcript.length} segments</span></h2>
  <div class="transcript-section">
    ${transcriptHtml || '<p style="color:var(--muted)">No transcript recorded.</p>'}
  </div>

  ${description ? `
  <h2>Video Description</h2>
  <div class="transcript-section" style="font-size:13px;color:var(--dim)">
    ${escapeHtml(description)}
  </div>
  ` : ''}
</div>
<div class="report-footer">
  Live Fact Checker by <a href="https://twitter.com/ezequias" target="_blank">@ezequias</a><br>
  Report generated on ${escapeHtml(dateStr)} at ${escapeHtml(timeStr)} &middot; Powered by Gemini + Whisper
</div>
</body>
</html>`;

    // Download as HTML
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    const filename = 'fact-check-' + event.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 40).replace(/-+$/, '') + '-' + now.toISOString().slice(0, 10) + '.html';
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    app.setStatus(t('status_report_exported'));
  }

  // ==========================================================
  // EXPORTS
  // ==========================================================
  app.setupMessageListener = setupMessageListener;
  app.exportReport = exportReport;

})(window.LiveFactChecker || {});

