const { query, queryOne, execute, nowText, today, daysFromNow } = require('./db');
const {
  executeAgent,
  trackedAnthropicClient,
  trackedExaSearch,
  recordProviderUsage,
} = require('./agent-control');

const MODEL = 'claude-sonnet-4-6';

function parseJson(text, fallback) {
  if (text && typeof text === 'object') return text;
  const raw = String(text || '').trim();
  const match = raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!match) return fallback;
  try { return JSON.parse(match[1]); } catch (_) { return fallback; }
}

async function askJson(prompt, maxTokens = 1400) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const response = await trackedAnthropicClient().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJson(response.content?.[0]?.text, null);
}

function companySignal(item, company) {
  return {
    company_id: company.id,
    company_name: company.name,
    title: item.title || `${company.name} update`,
    summary: item.summary || item.text || '',
    url: item.url || item.source_url || '',
    confidence: Number(item.confidence || 0.65),
    timing: item.timing || item.why_now || '',
    signal_type: item.signal_type || 'company',
    observed_at: item.observed_at || nowText(),
  };
}

async function runCompanySignalMonitor(limit = 6) {
  const companies = await query(
    `SELECT * FROM companies
     WHERE status NOT IN ('passed','archived')
     ORDER BY last_touched ASC NULLS FIRST, score DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  if (!companies.length) return [];
  return executeAgent('company-signal-monitor', {
    trigger: 'scheduled',
    input: { companies: companies.map(c => ({ id: c.id, name: c.name, website: c.website, sector: c.sector })) },
  }, async () => {
    const findings = [];
    for (const company of companies) {
      const search = await trackedExaSearch({
        query: `"${company.name}" ${company.website || ''} funding hiring product partnership leadership`,
        num_results: 5,
        text: { maxCharacters: 900 },
        startPublishedDate: new Date(Date.now() - 45 * 86400000).toISOString(),
      });
      const evidence = (search.results || []).map(result => ({
        title: result.title,
        url: result.url,
        publishedDate: result.publishedDate,
        text: result.text,
      }));
      if (!evidence.length) continue;
      const parsed = await askJson(`Identify at most 3 recent, material company signals using only the evidence below.
Never invent a claim or URL. Prefer primary sources. Return only a JSON array:
[{"title":"","summary":"","url":"","signal_type":"funding|hiring|product|partnership|leadership|event|other","observed_at":"YYYY-MM-DD or unknown","confidence":0.0,"timing":""}]

COMPANY:
${JSON.stringify({ name: company.name, website: company.website, sector: company.sector })}

EVIDENCE:
${JSON.stringify(evidence)}`, 1100);
      for (const item of Array.isArray(parsed) ? parsed : []) findings.push(companySignal(item, company));
    }
    return findings;
  });
}

async function runEvidenceAuditor(limit = 30) {
  const signals = await query(
    `SELECT s.*, c.name AS company_name
     FROM agent_signals s
     LEFT JOIN companies c ON c.id=s.company_id
     WHERE s.status='new' AND s.duplicate_of_id IS NULL
       AND s.agent_key!='evidence-auditor'
     ORDER BY s.actionable DESC, s.confidence DESC, s.created_at DESC
     LIMIT $1`,
    [limit]
  );
  if (!signals.length) return [];
  return executeAgent('evidence-auditor', {
    trigger: 'scheduled',
    input: { signal_ids: signals.map(s => s.id) },
  }, async () => {
    const audits = [];
    const byCompany = new Map();
    for (const signal of signals) {
      const key = signal.company_id || `${signal.entity_type}:${signal.entity_id || signal.title}`;
      const group = byCompany.get(key) || [];
      group.push(signal);
      byCompany.set(key, group);
    }
    for (const group of byCompany.values()) {
      const seen = new Map();
      for (const signal of group) {
        const key = `${String(signal.title).toLowerCase().replace(/\W+/g, ' ').trim()}|${signal.source_url || ''}`;
        if (seen.has(key)) {
          await execute(
            `UPDATE agent_signals SET status='duplicate',duplicate_of_id=$1 WHERE id=$2`,
            [seen.get(key), signal.id]
          );
          continue;
        }
        seen.set(key, signal.id);
        const ageDays = signal.observed_at
          ? (Date.now() - new Date(String(signal.observed_at).replace(' ', 'T') + (String(signal.observed_at).includes('T') ? '' : 'Z')).getTime()) / 86400000
          : null;
        const hasSource = /^https?:\/\//.test(signal.source_url || '');
        let confidence = Number(signal.confidence || 0.5);
        if (!hasSource) confidence = Math.min(confidence, 0.35);
        if (ageDays != null && ageDays > 90) confidence *= 0.65;
        await execute('UPDATE agent_signals SET confidence=$1 WHERE id=$2', [Math.max(0.05, confidence), signal.id]);
        audits.push({
          company_id: signal.company_id,
          title: `Evidence audit: ${signal.title}`,
          summary: `${hasSource ? 'Sourced' : 'Missing a source'}${ageDays != null && ageDays > 90 ? '; evidence is stale' : ''}. Confidence ${Math.round(confidence * 100)}%.`,
          confidence,
          actionable: !hasSource || (ageDays != null && ageDays > 90),
          url: signal.source_url || '',
          source_signal_id: signal.id,
        });
      }
    }
    return audits;
  });
}

async function getDustInvestigator() {
  return queryOne(
    `SELECT * FROM agent_registry
     WHERE provider='dust' AND status='active'
       AND (LOWER(name) LIKE '%opportunity investigator%' OR LOWER(purpose) LIKE '%investigat%')
     ORDER BY id LIMIT 1`
  );
}

async function dustRequest(path, options = {}) {
  if (!process.env.DUST_API_KEY || !process.env.DUST_WORKSPACE_ID) {
    throw new Error('DUST_API_KEY and DUST_WORKSPACE_ID are required');
  }
  const response = await fetch(`https://dust.tt${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.DUST_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error || response.statusText);
  recordProviderUsage({ calls: 1 });
  return body;
}

async function runOpportunityInvestigator(companyId) {
  const company = await queryOne('SELECT * FROM companies WHERE id=$1', [companyId]);
  if (!company) throw new Error('Company not found');
  const dustAgent = await getDustInvestigator();
  if (!dustAgent) return [];
  const signals = await query(
    `SELECT title,summary,source_url,confidence,observed_at
     FROM agent_signals WHERE company_id=$1 AND status!='rejected'
     ORDER BY created_at DESC LIMIT 12`,
    [companyId]
  );
  const profile = await queryOne('SELECT taste_profile FROM user_profile ORDER BY id LIMIT 1');
  const config = typeof dustAgent.config_json === 'string' ? JSON.parse(dustAgent.config_json || '{}') : (dustAgent.config_json || {});
  const dustAgentId = config.dust_agent_id || dustAgent.agent_key.replace(/^dust:/, '');
  return executeAgent('opportunity-investigator', {
    trigger: 'agent-triggered',
    companyId,
    planBucket: 'dust_programmatic',
    input: { company, signals, taste_profile: profile?.taste_profile || '' },
  }, async () => {
    const response = await dustRequest(`/api/v1/w/${process.env.DUST_WORKSPACE_ID}/assistant/conversations`, {
      method: 'POST',
      body: JSON.stringify({
        message: {
          context: { timezone: 'America/Los_Angeles', username: 'networking-river' },
          content: `Investigate this opportunity using your required JSON schema.\n\nCOMPANY:\n${JSON.stringify(company)}\n\nEXISTING SIGNALS:\n${JSON.stringify(signals)}\n\nUSER TASTE PROFILE:\n${profile?.taste_profile || 'Not yet refined'}`,
          mentions: [{ configurationId: dustAgentId }],
        },
        blocking: true,
      }),
    });
    return response;
  });
}

async function runRelationshipPathfinder(limit = 8) {
  const [companies, contacts, investors] = await Promise.all([
    query(`SELECT * FROM companies WHERE status NOT IN ('passed','archived') ORDER BY score DESC NULLS LAST LIMIT $1`, [limit]),
    query('SELECT * FROM contacts ORDER BY firm,name'),
    query(`SELECT * FROM investors WHERE confirmed=1 ORDER BY relationship_status DESC,last_touched DESC NULLS LAST LIMIT 100`),
  ]);
  if (!companies.length) return [];
  return executeAgent('relationship-pathfinder', {
    trigger: 'scheduled',
    input: { company_ids: companies.map(c => c.id) },
  }, async () => {
    const result = await askJson(`Map the strongest realistic relationship path for each company.
Use only supplied records. Never invent a connection. Return only JSON:
[{"company_id":1,"title":"Path into Company","summary":"","path_type":"direct|warm|contextual|cold","confidence":0.0,"recommended_action":""}]

COMPANIES:
${JSON.stringify(companies)}
CONTACTS:
${JSON.stringify(contacts)}
INVESTORS:
${JSON.stringify(investors)}`, 1800);
    return Array.isArray(result) ? result.map(item => ({ ...item, actionable: true })) : [];
  });
}

async function runFollowUpStrategist(limit = 12) {
  const actions = await query(
    `SELECT a.*,c.name AS company_name,c.sector,c.stage,c.score
     FROM actions a JOIN companies c ON c.id=a.company_id
     WHERE a.completed=0 AND a.outreach_type!='agent-recommendation'
       AND (a.due_date IS NULL OR a.due_date <= $1)
     ORDER BY a.due_date ASC NULLS LAST LIMIT $2`,
    [daysFromNow(3), limit]
  );
  if (!actions.length) return [];
  return executeAgent('follow-up-strategist', {
    trigger: 'scheduled',
    input: { action_ids: actions.map(a => a.id) },
  }, async () => {
    const result = await askJson(`Recommend the next human-reviewed move for each action.
Never send outreach. Return only JSON:
[{"company_id":1,"action_id":1,"title":"Next step for Company","summary":"","recommended_action":"wait|follow_up_with_new_signal|change_channel|ask_for_intro|close_loop|stop","due_date":"YYYY-MM-DD","confidence":0.0}]

ACTIONS:
${JSON.stringify(actions)}`, 1500);
    const recommendations = Array.isArray(result) ? result.map(item => ({ ...item, actionable: true })) : [];
    for (const item of recommendations) {
      if (!item.company_id || !item.summary) continue;
      const exists = await queryOne(
        `SELECT id FROM actions
         WHERE company_id=$1 AND completed=0 AND outreach_type='agent-recommendation'
           AND suggested_action=$2 LIMIT 1`,
        [item.company_id, item.summary]
      );
      if (!exists) {
        await execute(
          `INSERT INTO actions
           (company_id,suggested_action,due_date,sequence_step,contact_context,outreach_type)
           VALUES ($1,$2,$3,1,$4,'agent-recommendation')`,
          [item.company_id, item.summary, item.due_date || today(), item.recommended_action || 'human review']
        );
      }
    }
    return recommendations;
  });
}

async function curateTunerFeed(limit = 20) {
  const candidates = await query(
    `SELECT s.id,s.signal_type,s.title,s.summary,s.confidence,s.source_name,s.company_id,
      c.name AS company_name,c.sector,c.stage,c.score
     FROM agent_signals s
     LEFT JOIN companies c ON c.id=s.company_id
     WHERE s.status='new' AND s.duplicate_of_id IS NULL
     ORDER BY
       CASE WHEN s.confidence BETWEEN 0.4 AND 0.8 THEN 0 ELSE 1 END,
       CASE WHEN c.score BETWEEN 2 AND 4 THEN 0 ELSE 1 END,
       s.actionable DESC,s.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return candidates.map(row => ({
    id: row.id,
    label: row.company_name || row.title,
    name: row.company_name || row.title,
    sample: [[row.sector, row.stage].filter(Boolean).join(' · '), row.summary, row.source_name ? `From ${row.source_name}` : ''].filter(Boolean).join('\n'),
    tags: [row.signal_type, row.sector, row.stage].filter(Boolean),
    signal_id: row.id,
    company_id: row.company_id,
    confidence: Number(row.confidence || 0),
    curation_reason: 'High decision value: useful preference uncertainty.',
  }));
}

async function createProposal(agentKey, proposalType, proposedConfig, evidence, impact, costDelta = 0) {
  const agent = await queryOne('SELECT * FROM agent_registry WHERE agent_key=$1', [agentKey]);
  if (!agent) return null;
  const pending = await queryOne(`SELECT id FROM adaptation_proposals WHERE agent_key=$1 AND proposal_type=$2 AND status='pending'`, [agentKey, proposalType]);
  if (pending) return pending.id;
  const result = await execute(
    `INSERT INTO adaptation_proposals
     (agent_key,proposal_type,current_version,proposed_config,diff_json,evidence_json,
      estimated_daily_cost_delta,expected_impact,trial_days,success_metric)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,7,$9) RETURNING id`,
    [
      agentKey, proposalType, agent.current_version,
      JSON.stringify(proposedConfig || {}), JSON.stringify(proposedConfig || {}),
      JSON.stringify(evidence || []), costDelta, impact,
      'accepted actionable opportunities per dollar',
    ]
  );
  return result.lastInsertRowid;
}

async function runOutcomeLearning() {
  const outcomes = await query(
    `SELECT o.*,c.name AS company_name,c.sector,c.stage,s.agent_key,s.signal_type
     FROM agent_outcomes o
     LEFT JOIN companies c ON c.id=o.company_id
     LEFT JOIN agent_signals s ON s.id=o.signal_id
     WHERE o.created_at >= to_char(CURRENT_DATE - INTERVAL '60 days','YYYY-MM-DD')
     ORDER BY o.created_at DESC LIMIT 200`
  );
  return executeAgent('outcome-learning', {
    trigger: 'scheduled',
    input: { outcome_count: outcomes.length },
  }, async () => {
    if (outcomes.length < 5) return [{ title: 'Outcome learning baseline', summary: `Only ${outcomes.length} outcomes are available; collect at least 5 before changing behavior.`, confidence: 1 }];
    const analysis = await askJson(`Find transparent, evidence-backed patterns in these networking outcomes.
Return only JSON: {"summary":"","patterns":[],"recommended_changes":[{"agent_key":"","change":"","reason":""}]}
Do not claim causality from small samples.\n\nOUTCOMES:\n${JSON.stringify(outcomes)}`, 1400);
    for (const change of analysis?.recommended_changes || []) {
      await createProposal(
        change.agent_key,
        'outcome-learning',
        { recommendation: change.change, proposed_at: nowText() },
        [{ source: 'agent_outcomes', count: outcomes.length, reason: change.reason }],
        change.reason || 'Improve decisions using observed outcomes.'
      );
    }
    return [{ title: 'Outcome learning review', summary: analysis?.summary || 'Outcome patterns reviewed.', confidence: 0.75, data: analysis }];
  });
}

async function runAgentPortfolioManager() {
  const economics = await query(
    `SELECT r.agent_key,reg.name,COUNT(r.id) AS runs,
      SUM(CASE WHEN r.status='completed' THEN 1 ELSE 0 END) AS successes,
      COALESCE(SUM(r.output_count),0) AS outputs,
      COALESCE(SUM(r.duplicate_count),0) AS duplicates,
      COALESCE(SUM(r.actionable_count),0) AS actionable,
      COALESCE(SUM(r.accepted_count),0) AS accepted,
      COALESCE(SUM(COALESCE(r.exact_cost_usd,r.estimated_cost_usd,0)),0) AS cost
     FROM agent_runs r JOIN agent_registry reg ON reg.agent_key=r.agent_key
     WHERE r.created_at >= to_char(CURRENT_DATE - INTERVAL '30 days','YYYY-MM-DD')
     GROUP BY r.agent_key,reg.name`
  );
  return executeAgent('agent-portfolio-manager', {
    trigger: 'scheduled',
    input: { agents: economics },
  }, async () => {
    const recommendations = [];
    for (const row of economics) {
      const runs = Number(row.runs || 0);
      if (runs < 3) continue;
      const duplicateRate = Number(row.duplicates || 0) / Math.max(1, Number(row.outputs || 0) + Number(row.duplicates || 0));
      const accepted = Number(row.accepted || 0);
      const cost = Number(row.cost || 0);
      if (duplicateRate > 0.5) {
        recommendations.push({ agent_key: row.agent_key, direction: 'decrease', reason: `Duplicate rate is ${Math.round(duplicateRate * 100)}%.` });
      } else if (accepted >= 2 && (!cost || cost / accepted < 0.5)) {
        recommendations.push({ agent_key: row.agent_key, direction: 'increase', reason: `${accepted} accepted outputs at $${cost.toFixed(2)} total cost.` });
      }
    }
    for (const rec of recommendations) {
      const agent = await queryOne('SELECT schedule_json FROM agent_registry WHERE agent_key=$1', [rec.agent_key]);
      const schedule = typeof agent?.schedule_json === 'string' ? JSON.parse(agent.schedule_json || '{}') : (agent?.schedule_json || {});
      const current = Number(schedule.frequency_multiplier || 1);
      const proposed = rec.direction === 'increase' ? Math.min(1.5, current * 1.25) : Math.max(0.5, current * 0.75);
      await createProposal(
        rec.agent_key,
        'portfolio-allocation',
        { schedule_json: { ...schedule, frequency_multiplier: proposed } },
        [{ source: '30-day-agent-economics', reason: rec.reason }],
        rec.reason,
        rec.direction === 'increase' ? 0.05 : -0.03
      );
    }
    return recommendations.map(rec => ({
      title: `${rec.direction === 'increase' ? 'Increase' : 'Reduce'} ${rec.agent_key}`,
      summary: rec.reason,
      confidence: 0.7,
      actionable: true,
    }));
  });
}

async function runIntelligenceCycle() {
  const monitored = await runCompanySignalMonitor();
  const audited = await runEvidenceAuditor();
  const candidates = await query(
    `SELECT c.id,COUNT(s.id) AS signal_count,MAX(s.confidence) AS confidence
     FROM companies c JOIN agent_signals s ON s.company_id=c.id
     WHERE s.status='new' AND s.created_at >= to_char(CURRENT_DATE - INTERVAL '7 days','YYYY-MM-DD')
       AND c.status NOT IN ('passed','archived')
     GROUP BY c.id,c.score
     HAVING COUNT(s.id)>=2 OR (COALESCE(c.score,0)>=4 AND MAX(s.confidence)>=0.65)
     ORDER BY COUNT(s.id) DESC,MAX(s.confidence) DESC LIMIT 3`
  );
  const dust = [];
  for (const candidate of candidates) {
    const recent = await queryOne(
      `SELECT id FROM agent_runs WHERE agent_key='opportunity-investigator' AND company_id=$1
       AND created_at >= to_char(CURRENT_DATE - INTERVAL '7 days','YYYY-MM-DD') LIMIT 1`,
      [candidate.id]
    );
    if (!recent) {
      try { dust.push(await runOpportunityInvestigator(candidate.id)); } catch (error) {
        console.warn('[IntelligenceCycle] Dust investigation skipped:', error.message);
      }
    }
  }
  return { monitored: monitored.length, audited: audited.length, investigated: dust.length };
}

module.exports = {
  runCompanySignalMonitor,
  runEvidenceAuditor,
  runOpportunityInvestigator,
  runRelationshipPathfinder,
  runFollowUpStrategist,
  curateTunerFeed,
  runOutcomeLearning,
  runAgentPortfolioManager,
  runIntelligenceCycle,
};
