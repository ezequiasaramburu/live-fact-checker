// ============================================================
// Live Fact Checker — Gemini API & Fact-Checking Pipeline
// ============================================================

(function (app) {
  'use strict';

  app = Object.assign(window.LiveFactChecker || {}, app);
  window.LiveFactChecker = app;

  const state = app.state;
  const dom = app.dom;
  const t = app.t;
  const sleep = app.sleep;
  const getContextString = app.getContextString;
  const highlightClaimInTranscript = app.highlightClaimInTranscript;
  const updateClaimInTranscript = app.updateClaimInTranscript;
  const updateStats = app.updateStats;

  // ==========================================================
  // GEMINI API — budget-based rate limiter
  // ==========================================================
  // Gemini 2.0 Flash free tier limits:
  //   - 15 requests per minute (RPM)
  //   - 1,000,000 tokens per minute (TPM)
  //   - 1,500 requests per day (RPD)
  // We track a sliding window of request timestamps to NEVER exceed these.
  // ==========================================================
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

  const RPM_LIMIT = 14;           // stay 1 under the 15 RPM hard limit
  const RPD_LIMIT = 1400;         // stay under the 1500 RPD hard limit
  const requestLog = [];          // timestamps of all API calls
  let dailyRequestCount = 0;
  let dailyResetTime = Date.now() + 86400000;
  let serverBackoffUntil = 0;     // if we DO get a 429, respect server's retry-after
  let pendingVerifications = [];
  let isProcessingQueue = false;

  /** How many requests can we make right now? */
  function availableRequests() {
    const now = Date.now();
    // Prune entries older than 60s
    while (requestLog.length && requestLog[0] < now - 60000) requestLog.shift();
    // Reset daily counter if needed
    if (now > dailyResetTime) { dailyRequestCount = 0; dailyResetTime = now + 86400000; }
    const minuteAvail = RPM_LIMIT - requestLog.length;
    const dayAvail = RPD_LIMIT - dailyRequestCount;
    return Math.max(0, Math.min(minuteAvail, dayAvail));
  }

  /** Minimum ms to wait before the next request is allowed */
  function msUntilNextSlot() {
    const now = Date.now();
    // Server-imposed backoff takes priority
    if (serverBackoffUntil > now) return serverBackoffUntil - now;
    if (availableRequests() > 0) return 0;
    // Earliest slot opens when oldest request in window expires
    if (requestLog.length >= RPM_LIMIT) return requestLog[0] + 60000 - now + 200; // +200ms buffer
    return 1000; // fallback
  }

  /** Wait until we have budget, then record the request */
  async function acquireSlot() {
    let wait = msUntilNextSlot();
    while (wait > 0) {
      console.log(`[Budget] Waiting ${Math.round(wait / 1000)}s for API slot (${requestLog.length}/${RPM_LIMIT} RPM used)`);
      app.setStatus(`Waiting for API slot (${Math.round(wait / 1000)}s)...`, 'checking');
      await sleep(wait);
      wait = msUntilNextSlot();
    }
    requestLog.push(Date.now());
    dailyRequestCount++;
  }

  async function callGemini(prompt, { grounded = false, temperature = 0.1, maxTokens = 1024, jsonMode = false, jsonSchema = null } = {}) {
    await acquireSlot();

    const model = 'gemini-2.0-flash';
    const url = `${GEMINI}/${model}:generateContent?key=${state.apiKey}`;
    const genConfig = { temperature, maxOutputTokens: maxTokens };

    // Force JSON output when not using grounding (grounding + JSON mode is unsupported)
    if (jsonMode && !grounded) {
      genConfig.responseMimeType = 'application/json';
      if (jsonSchema) genConfig.responseSchema = jsonSchema;
    }

    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: genConfig
    };
    if (grounded) body.tools = [{ google_search: {} }];

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (r.status === 429) {
      // Parse server-suggested retry delay
      let waitMs = 30000;
      try {
        const errBody = await r.json();
        const retryInfo = errBody.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
        if (retryInfo?.retryDelay) {
          const s = retryInfo.retryDelay.match(/([\d.]+)s/);
          if (s) waitMs = Math.ceil(parseFloat(s[1]) * 1000) + 1000;
        }
      } catch { /* ignore */ }
      serverBackoffUntil = Date.now() + waitMs;
      console.log(`[Budget] 429 received. Server says wait ${Math.round(waitMs / 1000)}s`);
      throw new Error(`RATE_LIMITED:${waitMs}`);
    }

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Gemini ${r.status}: ${errText.substring(0, 200)}`);
    }

    const d = await r.json();
    if (!d.candidates?.length) throw new Error('No candidates');
    const c = d.candidates[0];
    const text = c.content?.parts?.[0]?.text || '';
    let sources = [];
    if (c.groundingMetadata?.groundingChunks)
      sources = c.groundingMetadata.groundingChunks
        .filter(x => x.web)
        .map(x => ({ url: x.web.uri, title: x.web.title || x.web.uri }));
    return { text, sources };
  }

  function parseJSON(text) {
    if (!text) return null;
    // Strip markdown code fences (```json ... ``` or ``` ... ```)
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    // Try direct parse
    try { return JSON.parse(cleaned); } catch { /* ignore */ }
    // Try to extract JSON object or array from surrounding text
    // Use the LAST { or [ that leads to valid JSON (Gemini often adds preamble)
    for (const startChar of ['{', '[']) {
      const endChar = startChar === '{' ? '}' : ']';
      const lastStart = cleaned.lastIndexOf(startChar);
      if (lastStart === -1) continue;
      const firstStart = cleaned.indexOf(startChar);
      // Try from the first occurrence (most common)
      for (const idx of [firstStart, lastStart]) {
        const lastEnd = cleaned.lastIndexOf(endChar);
        if (lastEnd > idx) {
          try { return JSON.parse(cleaned.substring(idx, lastEnd + 1)); } catch { /* ignore */ }
        }
      }
    }
    return null;
  }

  /**
   * Fallback for grounded verification calls (which can't use JSON mode).
   * When Gemini returns a prose response instead of JSON, this extracts
   * the verdict, confidence, and explanation from the natural language text.
   */
  function extractVerdictFromProse(text) {
    if (!text || text.length < 5) return null;

    // --- 1. Detect verdict ---
    const upper = text.toUpperCase();
    let verdict = 'UNCERTAIN';

    // Look for explicit verdict patterns first (strongest signal)
    const verdictPatterns = [
      // English patterns
      { re: /\bverdict\s*[:=]\s*"?(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)"?/i, group: 1 },
      { re: /\bmarked?\s+(?:as\s+)?(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)\b/i, group: 1 },
      { re: /\bclaim\s+is\s+(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)\b/i, group: 1 },
      { re: /\brating\s*[:=]\s*"?(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)"?/i, group: 1 },
      // Spanish patterns
      { re: /\bveredicto\s*[:=]\s*"?(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)"?/i, group: 1 },
      { re: /\bla\s+afirmaci[oó]n\s+es\s+(VERDADERA|FALSA|INCIERTA|TRUE|FALSE|UNCERTAIN)\b/i, group: 1 },
    ];

    for (const { re, group } of verdictPatterns) {
      const m = text.match(re);
      if (m) {
        const raw = m[group].toUpperCase();
        if (raw === 'VERDADERO' || raw === 'VERDADERA') verdict = 'TRUE';
        else if (raw === 'FALSO' || raw === 'FALSA') verdict = 'FALSE';
        else if (raw === 'INCIERTO' || raw === 'INCIERTA') verdict = 'UNCERTAIN';
        else verdict = raw;
        break;
      }
    }

    // If no explicit pattern found, use keyword heuristics
    if (verdict === 'UNCERTAIN') {
      const falseSignals = [
        /\bis\s+(false|incorrect|wrong|inaccurate|misleading)\b/i,
        /\bes\s+(falso|falsa|incorrecta?|errónea?|inexacta?)\b/i,
        /\bcontradicts?\b/i, /\bcontradice\b/i,
        /\bthe\s+(?:real|actual)\s+(?:number|figure|data)\b.*?\bdifferent\b/i,
        /\blos\s+datos\s+(?:reales|oficiales)\b.*?\bdiferente\b/i,
        /\bnot\s+(?:true|accurate|correct|supported)\b/i,
        /\bno\s+es\s+(?:cierto|correcto|preciso)\b/i,
      ];
      const trueSignals = [
        /\bis\s+(true|correct|accurate|supported|confirmed)\b/i,
        /\bes\s+(verdadera?|correcta?|precisa?|cierta?)\b/i,
        /\bconfirms?\b/i, /\bconfirma\b/i,
        /\bdata\s+supports?\b/i, /\blos\s+datos\s+(?:confirman|respaldan)\b/i,
      ];

      let falseScore = 0, trueScore = 0;
      for (const re of falseSignals) if (re.test(text)) falseScore++;
      for (const re of trueSignals) if (re.test(text)) trueScore++;

      if (falseScore > trueScore && falseScore >= 1) verdict = 'FALSE';
      else if (trueScore > falseScore && trueScore >= 1) verdict = 'TRUE';
      // else stays UNCERTAIN
    }

    // --- 2. Extract confidence ---
    let confidence = verdict === 'UNCERTAIN' ? 0.4 : 0.6;
    const confMatch = text.match(/\bconfidence\s*[:=]\s*(0(?:\.\d+)?|1(?:\.0)?)\b/i)
                   || text.match(/\bconfianza\s*[:=]\s*(0(?:\.\d+)?|1(?:\.0)?)\b/i);
    if (confMatch) confidence = parseFloat(confMatch[1]);

    // --- 3. Build explanation ---
    let explanation = text
      .replace(/^(?:Okay|Ok|Bien|Entiendo|Voy a)[^.]*\.\s*/i, '')
      .replace(/^(?:Let me|Déjame|Permíteme|I'll|Vamos a)[^.]*\.\s*/i, '')
      .trim();
    if (explanation.length > 500) explanation = explanation.substring(0, 497) + '...';
    if (!explanation) explanation = text.substring(0, 300);

    return {
      verdict,
      confidence,
      explanation,
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  // ==========================================================
  // CLAIM IDENTIFICATION
  // ==========================================================
  async function runClaimCheck(force = false) {
    if (!state.isRunning && !force) return;
    const text = state.pendingText.trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < (force ? 5 : state.minWords)) return;

    // Don't even try if no budget (unless forced — acquireSlot will wait)
    if (!force && availableRequests() < 1) {
      const wait = msUntilNextSlot();
      app.setStatus(`Buffering transcript (API slot in ${Math.round(wait / 1000)}s)...`, 'checking');
      return; // keep text in pendingText, try next tick
    }

    state.pendingText = '';
    const prevStatus = dom.statusText.textContent;
    app.setStatus(t('status_analyzing'), 'checking');

    try {
      const claims = await identifyClaims(text);
      if (claims?.length) {
        for (const cl of claims) {
          const id = 'c-' + (++state.claimIdCounter);
          const obj = {
            id,
            text: cl.claim || cl.text || '',
            summary: cl.summary || cl.claim || '',
            searchQuery: cl.searchQuery || '',
            status: 'pending',
            verdict: null,
            explanation: '',
            sources: [],
            confidence: 0,
            needsClarification: false,
            clarificationQuestion: null
          };
          state.claims.set(id, obj);
          highlightClaimInTranscript(obj);
          updateStats();
          queueVerification(obj);
        }
      }
      app.setStatus(state.isRunning ? prevStatus : 'Stopped', state.isRunning ? 'live' : '');
    } catch (err) {
      console.error('Claim ID error:', err);
      if (err.message.startsWith('RATE_LIMITED')) {
        app.setStatus(t('status_rate_limited'), 'checking');
      } else {
        app.setStatus('API error: ' + err.message.substring(0, 80), 'error');
      }
      state.pendingText = text + ' ' + state.pendingText;
    }
  }

  // ── Verification queue — one at a time, respects budget ──
  function queueVerification(claim) {
    pendingVerifications.push(claim);
    if (!isProcessingQueue) processVerificationQueue();
  }

  async function processVerificationQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (pendingVerifications.length > 0) {
      const claim = pendingVerifications.shift();
      await verifyClaim(claim);
    }
    isProcessingQueue = false;
  }

  async function identifyClaims(text) {
    const lang = app.getEffectiveLanguage();
    const langNames = { en: 'English', es: 'Spanish' };
    const langName = langNames[lang] || 'the same language as the transcript';
    const prompt = `You are a fact-checking analyst. Extract ALL verifiable claims from the transcript.

CONTEXT:
${getContextString()}

TRANSCRIPT:
"""
${text}
"""

RULES:
1. Extract ANY claim that contains: a number, percentage, date, statistic, named event, historical assertion, economic figure, comparison, or attribution — even if approximate ("cerca del 60%", "más de 100 años").
2. INCLUDE sweeping claims that reference time periods or magnitudes ("100 years of X", "the worst in history", "never created a single job") — these ARE checkable against historical data.
3. INCLUDE claims with approximate numbers ("cerca de", "alrededor de", "más de") — the approximation itself can be verified.
4. EXCLUDE ONLY: pure opinions with no factual anchor, predictions about the future, greetings, emotional expressions, applause, procedural statements.
5. Max 5 claims per chunk. Prioritize claims with concrete numbers, but also include broader historical/economic assertions.
6. If the text is only greetings/filler with NO factual content at all, return [].
7. Write "summary" as a precise, testable assertion in ${langName}.
8. Write "searchQuery" as a specific search query to find data that confirms or denies the claim.

JSON array (or []):
[{"claim":"verbatim quote from transcript","summary":"testable assertion in ${langName}","searchQuery":"specific data-finding query"}]`;
    const claimSchema = {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          claim: { type: 'STRING' },
          summary: { type: 'STRING' },
          searchQuery: { type: 'STRING' }
        },
        required: ['claim', 'summary', 'searchQuery']
      }
    };
    const r = await callGemini(prompt, { temperature: 0.05, maxTokens: 512, jsonMode: true, jsonSchema: claimSchema });
    const parsed = parseJSON(r.text);
    if (!Array.isArray(parsed)) {
      console.warn('[FactChecker] Failed to parse identification response. Raw text:', r.text);
    }
    return Array.isArray(parsed) ? parsed : [];
  }

  // ==========================================================
  // CLAIM VERIFICATION
  // ==========================================================
  async function verifyClaim(claim) {
    const lang = app.getEffectiveLanguage();
    const langNames = { en: 'English', es: 'Spanish' };
    const langName = langNames[lang] || 'the same language as the claim';
    const prompt = `You are an aggressive fact-checker. Your job: FIND THE DATA. Do NOT say "difficult to verify" — SEARCH for it. Respond in ${langName}.

CONTEXT: ${getContextString()}
CLAIM: "${claim.summary || claim.text}"
Original: "${claim.text}"

YOU HAVE GOOGLE SEARCH. USE IT. Most economic, demographic, and political claims CAN be verified using:
- Official statistics agencies (INDEC, BLS, Eurostat, World Bank, IMF)
- Central bank reports (BCRA, Fed, ECB)
- Fact-checking organizations (Chequeado, PolitiFact, FullFact)
- News archives and government reports
Do NOT assume data is unavailable. SEARCH for it. If you truly cannot find ANY data after searching, only THEN mark UNCERTAIN.

DECISION RULES:
1. SEARCH for the specific data point (the number, date, percentage, statistic).
2. You found data that MATCHES the claim (within reasonable margin ±10-15%) → TRUE.
3. You found data that CONTRADICTS the claim (the real number is substantially different) → FALSE. Example: claim says "60% poverty" but official data shows 42% → FALSE. Claim says "7500% inflation" but data shows 211% → FALSE.
4. The claim is a SWEEPING NARRATIVE with no single verifiable data point ("100 years of decline", "the worst in history") → UNCERTAIN.
5. You genuinely cannot find ANY relevant data after searching → UNCERTAIN.
6. Partially true but with misleading exaggeration or missing critical context that changes the meaning → FALSE.

ABSOLUTE RULES:
- NEVER say "difficult to verify" for claims with specific numbers. Numbers are ALWAYS verifiable — search for them.
- NEVER mark TRUE if your own explanation shows different numbers than the claim. If claim says X but you found Y, and X ≠ Y, that is FALSE.
- ALWAYS state: "Claim says [X]. Official data shows [Y]." in your explanation.
- The explanation MUST be consistent with the verdict. If you write "data shows a different figure", the verdict MUST be FALSE, not TRUE or UNCERTAIN.
- Political speeches routinely exaggerate. When the real number exists but differs significantly, that's FALSE — not "hard to verify".
- Write the "explanation" field in ${langName}. Keep it 2-3 sentences. Always compare claimed vs real numbers.

CRITICAL: Your ENTIRE response must be a single JSON object. No text before or after. All analysis goes inside "explanation".

{"verdict":"TRUE|FALSE|UNCERTAIN","confidence":0.0-1.0,"explanation":"Claim says [X]. Official data from [source] shows [Y]. Therefore [verdict reasoning]","needsClarification":false,"clarificationQuestion":null}`;

    try {
      const r = await callGemini(prompt, { grounded: true, maxTokens: 1024 });
      let p = parseJSON(r.text);
      // Grounded calls can't use JSON mode, so Gemini sometimes responds in prose.
      // If parseJSON fails, try to extract verdict from the natural language response.
      if (!p && r.text && r.text.length > 10) {
        console.warn('[FactChecker] Grounded response was not JSON, extracting from prose:', r.text.substring(0, 200));
        p = extractVerdictFromProse(r.text);
      }
      // Self-consistency check: if the explanation mentions contradicting data but verdict is TRUE, override
      if (p && p.verdict) {
        const v = p.verdict.toUpperCase();
        if (v === 'TRUE') {
          const contradictionSignals = [
            /(?:data|datos|cifra|oficial|indec|bcra)\s+(?:shows?|muestra|indica|registr[aó]|señala)\s+(?:un |una |el |la |los |las )?(?:\d|diferente|distint)/i,
            /(?:sin embargo|however|but|pero)\s.*?(?:\d+[.,]?\d*\s*%)/i,
            /(?:real|actual|oficial)\s+(?:figure|number|dato|cifra|porcentaje)\s.*?(?:differ|distint|no coincid)/i,
          ];
          for (const re of contradictionSignals) {
            if (re.test(p.explanation || '')) {
              console.warn('[FactChecker] Self-consistency override: TRUE→UNCERTAIN (explanation contradicts verdict)');
              p.verdict = 'UNCERTAIN';
              p.confidence = Math.min(p.confidence || 0.5, 0.5);
              break;
            }
          }
        }
      }
      if (p) {
        claim.status = 'verified';
        claim.verdict = (p.verdict || 'UNCERTAIN').toUpperCase();
        claim.confidence = p.confidence || 0.5;
        claim.explanation = p.explanation || '';
        claim.sources = r.sources || [];
        if (p.needsClarification && p.clarificationQuestion) {
          const existing = findClarification(p.clarificationQuestion);
          if (existing) {
            claim.status = 'pending';
            await reVerify(claim, p.clarificationQuestion, existing);
            return;
          } else {
            claim.needsClarification = true;
            claim.clarificationQuestion = p.clarificationQuestion;
            showClarification(claim.id, p.clarificationQuestion);
          }
        }
      } else {
        console.warn('[FactChecker] Failed to parse verification response. Raw text:', r.text);
        claim.status = 'verified'; claim.verdict = 'UNCERTAIN';
        const preview = (r.text || '').substring(0, 200).trim();
        claim.explanation = preview ? 'API returned unexpected format: "' + preview + '..."' : 'API returned empty response';
      }
    } catch (err) {
      console.error('Verification error:', err);
      if (err.message.startsWith('RATE_LIMITED')) {
        claim.explanation = 'Rate limited — queued for retry...';
        updateClaimInTranscript(claim);
        pendingVerifications.unshift(claim);
        const waitMs = parseInt(err.message.split(':')[1]) || 30000;
        await sleep(waitMs);
        return;
      }
      claim.status = 'verified'; claim.verdict = 'UNCERTAIN'; claim.explanation = 'Error: ' + err.message.substring(0, 100);
    }
    updateClaimInTranscript(claim);
    updateStats();
  }

  async function reVerify(claim, question, answer) {
    const prompt = `Verify claim with context. ${getContextString()}\nQ: ${question} A: ${answer}\nCLAIM: "${claim.text}"\nJSON: {"verdict":"TRUE|FALSE|UNCERTAIN","confidence":0-1,"explanation":"..."}`;
    try {
      const r = await callGemini(prompt, { grounded: true, maxTokens: 512 });
      const p = parseJSON(r.text);
      if (p) {
        claim.status = 'verified';
        claim.verdict = (p.verdict || 'UNCERTAIN').toUpperCase();
        claim.confidence = p.confidence || 0.5;
        claim.explanation = p.explanation || '';
        claim.sources = r.sources || [];
        claim.needsClarification = false;
      }
    } catch {
      claim.status = 'verified';
      claim.verdict = 'UNCERTAIN';
      claim.explanation = 'Re-verification failed.';
    }
    updateClaimInTranscript(claim);
    updateStats();
  }

  // ==========================================================
  // CLARIFICATIONS
  // ==========================================================
  function findClarification(q) {
    const ql = q.toLowerCase();
    for (const [k, v] of Object.entries(state.clarifications)) {
      if (ql.includes(k.toLowerCase()) || k.toLowerCase().includes(ql)) return v;
    }
    return null;
  }

  function showClarification(claimId, question) {
    state.pendingClarification = { claimId, question };
    dom.clarQuestion.textContent = question;
    dom.clarInput.value = '';
    dom.clarBanner.classList.remove('hidden');
    dom.clarInput.focus();
  }

  function submitClarification() {
    const answer = dom.clarInput.value.trim();
    if (!answer || !state.pendingClarification) return;
    const { claimId, question } = state.pendingClarification;
    state.clarifications[question] = answer;
    chrome.storage.local.set({ clarifications: state.clarifications });
    dom.clarBanner.classList.add('hidden');
    state.pendingClarification = null;
    const claim = state.claims.get(claimId);
    if (claim) {
      claim.status = 'pending';
      updateClaimInTranscript(claim);
      reVerify(claim, question, answer);
    }
  }

  // ==========================================================
  // EXPORTS
  // ==========================================================
  app.GEMINI = GEMINI;
  app.RPM_LIMIT = RPM_LIMIT;
  app.RPD_LIMIT = RPD_LIMIT;
  app.availableRequests = availableRequests;
  app.msUntilNextSlot = msUntilNextSlot;
  app.acquireSlot = acquireSlot;
  app.callGemini = callGemini;
  app.parseJSON = parseJSON;
  app.extractVerdictFromProse = extractVerdictFromProse;
  app.runClaimCheck = runClaimCheck;
  app.queueVerification = queueVerification;
  app.processVerificationQueue = processVerificationQueue;
  app.identifyClaims = identifyClaims;
  app.verifyClaim = verifyClaim;
  app.reVerify = reVerify;
  app.findClarification = findClarification;
  app.showClarification = showClarification;
  app.submitClarification = submitClarification;

})(window.LiveFactChecker || {});

