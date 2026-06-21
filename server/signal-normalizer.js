function nowText() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function normalizeSignals(agentKey, output, input, companyId) {
  const signals = [];
  const add = (type, title, summary, extra = {}) => {
    if (!title) return;
    signals.push({
      signal_type: type,
      entity_type: extra.entityType || (companyId ? 'company' : ''),
      entity_id: extra.entityId || companyId || null,
      company_id: extra.companyId || companyId || null,
      title: String(title).slice(0, 240),
      summary: String(summary || '').slice(0, 2000),
      confidence: extra.confidence ?? 0.65,
      source_url: extra.sourceUrl || '',
      source_name: extra.sourceName || agentKey,
      actionable: extra.actionable ? 1 : 0,
      observed_at: extra.observedAt || nowText(),
      data_json: extra.data || {},
    });
  };

  if (Array.isArray(output)) {
    for (const item of output.slice(0, 50)) {
      const title = item.company_name || item.name || item.title || item.company || item.investor;
      const type = item.signal_type || (item.event_url ? 'event' : item.company_id || item.company_name ? 'company' : item.investor || item.firm ? 'person' : 'claim');
      add(type, title, item.timing || item.description || item.summary || JSON.stringify(item), {
        companyId: item.company_id || companyId,
        sourceUrl: item.event_url || item.source_url || item.url || '',
        confidence: item.confidence,
        actionable: item.actionable === undefined
          ? Boolean(item.timing || item.warm || item.cold || item.investor || item.recommended_action)
          : Boolean(item.actionable),
        observedAt: item.observed_at,
        data: item,
      });
    }
  } else if (output && typeof output === 'object') {
    const title = output.title || output.name || input?.name || input?.company?.name || agentKey;
    add(output.event_url ? 'event' : 'recommendation', title, output.summary || output.message || JSON.stringify(output), {
      sourceUrl: output.event_url || output.url || '',
      confidence: output.confidence,
      actionable: true,
      data: output,
    });
  } else if (typeof output === 'string' && output.trim()) {
    const title = input?.company?.name || input?.name || input?.firm || agentKey.replace(/-/g, ' ');
    add(agentKey.includes('draft') ? 'draft' : agentKey.includes('recap') ? 'recommendation' : 'claim', title, output, {
      actionable: /next action|outreach|priorit|recommend|timing/i.test(output),
      data: { excerpt: output.slice(0, 4000) },
    });
  }
  return signals;
}

module.exports = { normalizeSignals };
