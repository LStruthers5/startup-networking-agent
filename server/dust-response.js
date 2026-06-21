function parseJson(text, fallback = null) {
  if (text && typeof text === 'object') return text;
  const raw = String(text || '').trim();
  const match = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) return fallback;
  try { return JSON.parse(match[1]); } catch (_) { return fallback; }
}

function collectDustTexts(value, texts = [], depth = 0) {
  if (value == null || depth > 10) return texts;
  if (typeof value === 'string') {
    if (value.trim()) texts.push(value.trim());
    return texts;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDustTexts(item, texts, depth + 1);
    return texts;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['content', 'text', 'value', 'message', 'messages', 'assistantMessage', 'assistant_message'].includes(key)) {
        collectDustTexts(item, texts, depth + 1);
      } else if (depth < 4) {
        collectDustTexts(item, texts, depth + 1);
      }
    }
  }
  return texts;
}

function extractDustPayload(response) {
  if (response?.company && response?.investigation) return response;
  const texts = collectDustTexts(response);
  for (let i = texts.length - 1; i >= 0; i--) {
    const parsed = parseJson(texts[i], null);
    if (parsed?.company || parsed?.investigation || parsed?.verified_signals) return parsed;
  }
  return null;
}

function extractDustText(response) {
  const texts = collectDustTexts(response);
  return texts.length ? texts[texts.length - 1] : '';
}

function dustPayloadToSignals(payload, company) {
  if (!payload) return [];
  const findings = [];
  for (const signal of payload.verified_signals || []) {
    findings.push({
      company_id: company.id,
      company_name: company.name,
      title: signal.title || `${company.name} verified development`,
      summary: signal.summary || '',
      signal_type: signal.signal_type || 'company',
      source_url: signal.source_url || '',
      observed_at: signal.observed_at,
      confidence: Number(signal.confidence || payload.investigation?.confidence || 0.65),
      actionable: Boolean(signal.new_information),
      recommended_action: payload.recommended_next_step?.action || '',
      data: signal,
    });
  }
  const assessment = payload.investigation?.overall_assessment || payload.company?.summary;
  if (assessment) {
    findings.unshift({
      company_id: company.id,
      company_name: company.name,
      title: `${company.name}: ${payload.investigation?.status || 'investigation complete'}`,
      summary: assessment,
      signal_type: 'recommendation',
      confidence: Number(payload.investigation?.confidence || 0.65),
      actionable: ['promote', 'monitor'].includes(payload.investigation?.status),
      recommended_action: payload.recommended_next_step?.action || '',
      data: {
        preference_alignment: payload.preference_alignment || {},
        networking_context: payload.networking_context || {},
        information_gaps: payload.information_gaps || [],
        recommended_next_step: payload.recommended_next_step || {},
      },
    });
  }
  return findings;
}

module.exports = { extractDustPayload, extractDustText, dustPayloadToSignals };
