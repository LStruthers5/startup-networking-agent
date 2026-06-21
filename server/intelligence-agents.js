const { query, queryOne, execute, nowText, today, daysFromNow } = require('./db');
const {
  executeAgent,
  trackedAnthropicClient,
  trackedExaSearch,
  recordProviderUsage,
} = require('./agent-control');
const { extractDustPayload, dustPayloadToSignals } = require('./dust-response');

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

async function saveCompanyIntelligence(company, profile, source = 'company-profile-curator') {
  const sources = Array.isArray(profile.sources) ? profile.sources : [];
  const warnings = Array.isArray(profile.warnings) ? profile.warnings : [];
  const confidence = Math.max(0, Math.min(1, Number(profile.confidence || 0)));
  const ts = nowText();
  await execute(
    `INSERT INTO company_intelligence
     (company_id,clean_description,business_model,products,customers,leadership,hiring_summary,
      preference_fit,why_now,open_questions,sources,warnings,confidence,data_source,last_synced_at,
      profile_json,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$15)
     ON CONFLICT (company_id) DO UPDATE SET
      clean_description=EXCLUDED.clean_description,business_model=EXCLUDED.business_model,
      products=EXCLUDED.products,customers=EXCLUDED.customers,leadership=EXCLUDED.leadership,
      hiring_summary=EXCLUDED.hiring_summary,preference_fit=EXCLUDED.preference_fit,
      why_now=EXCLUDED.why_now,open_questions=EXCLUDED.open_questions,sources=EXCLUDED.sources,
      warnings=EXCLUDED.warnings,confidence=EXCLUDED.confidence,data_source=EXCLUDED.data_source,
      last_synced_at=EXCLUDED.last_synced_at,profile_json=EXCLUDED.profile_json,updated_at=EXCLUDED.updated_at`,
    [
      company.id,
      profile.clean_description || profile.summary || '',
      profile.business_model || '',
      JSON.stringify(profile.products || []),
      JSON.stringify(profile.customers || []),
      JSON.stringify(profile.leadership || []),
      profile.hiring_summary || '',
      profile.preference_fit || '',
      profile.why_now || '',
      JSON.stringify(profile.open_questions || profile.information_gaps || []),
      JSON.stringify(sources),
      JSON.stringify(warnings),
      confidence,
      source,
      ts,
      JSON.stringify(profile),
    ]
  );
  const updates = {
    description: profile.clean_description || profile.summary || '',
    sector: profile.sector || '',
    stage: profile.stage || '',
    website: profile.website || '',
    founded_year: profile.founded_year || '',
    last_funding: profile.last_funding || '',
    funding_amount: profile.funding_amount || '',
    location: profile.location || '',
  };
  for (const [field, value] of Object.entries(updates)) {
    if (!value) continue;
    await execute(`UPDATE companies SET ${field}=$1 WHERE id=$2`, [String(value).slice(0, field === 'description' ? 3000 : 500), company.id]);
  }
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
    normalize: false,
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
    const payload = extractDustPayload(response);
    if (!payload) {
      throw new Error('Dust completed the conversation but no structured investigation JSON was found.');
    }
    await saveCompanyIntelligence(company, {
      clean_description: payload.company?.summary || company.description || '',
      business_model: payload.company?.business_model || '',
      sector: payload.company?.sector || company.sector || '',
      stage: payload.company?.stage || company.stage || '',
      website: payload.company?.website || company.website || '',
      location: payload.company?.location || company.location || '',
      leadership: payload.people || [],
      preference_fit: payload.preference_alignment?.explanation || '',
      why_now: (payload.networking_context?.timely_reasons || []).join(' '),
      open_questions: payload.information_gaps || [],
      sources: payload.sources || [],
      warnings: [
        ...(payload.networking_context?.warnings || []),
        ...(payload.contradictions || []).map(item => item.claim || 'Conflicting evidence'),
      ],
      confidence: payload.investigation?.confidence || 0,
      investigation: payload.investigation || {},
      recommended_next_step: payload.recommended_next_step || {},
    }, 'dust-opportunity-investigator');
    return dustPayloadToSignals(payload, company);
  });
}

async function runCompanyProfileCurator(limit = 4) {
  const companies = await query(
    `SELECT c.*,ci.last_synced_at,ci.profile_json
     FROM companies c LEFT JOIN company_intelligence ci ON ci.company_id=c.id
     WHERE c.status NOT IN ('passed','archived')
     ORDER BY ci.last_synced_at ASC NULLS FIRST,c.score DESC NULLS LAST
     LIMIT $1`,
    [limit]
  );
  if (!companies.length) return [];
  const userProfile = await queryOne('SELECT taste_profile FROM user_profile ORDER BY id LIMIT 1');
  return executeAgent('company-profile-curator', {
    trigger: 'scheduled',
    input: { company_ids: companies.map(company => company.id) },
  }, async () => {
    const changes = [];
    for (const company of companies) {
      const search = await trackedExaSearch({
        query: `"${company.name}" ${company.website || ''} company products customers leadership funding hiring`,
        num_results: 7,
        text: { maxCharacters: 1200 },
      });
      const evidence = (search.results || []).map(item => ({
        title: item.title, url: item.url, publishedDate: item.publishedDate, text: item.text,
      }));
      if (!evidence.length) continue;
      const cleaned = await askJson(`Create a clean, durable company intelligence profile using only the evidence.
Resolve messy or conflicting descriptions conservatively. Never invent missing fields.
Return only JSON:
{
  "clean_description":"","business_model":"","sector":"","stage":"","website":"","founded_year":"",
  "last_funding":"","funding_amount":"","location":"","products":[],"customers":[],"leadership":[],
  "hiring_summary":"","preference_fit":"","why_now":"","open_questions":[],"sources":[{"url":"","title":""}],
  "warnings":[],"confidence":0.0,
  "meaningful_changes":[{"title":"","summary":"","signal_type":"funding|hiring|product|leadership|partnership|profile_change","source_url":"","confidence":0.0}]
}

CURRENT RECORD:
${JSON.stringify(company)}

USER TASTE PROFILE:
${userProfile?.taste_profile || 'Not yet refined'}

EVIDENCE:
${JSON.stringify(evidence)}`, 2200);
      if (!cleaned) continue;
      await saveCompanyIntelligence(company, cleaned);
      for (const change of cleaned.meaningful_changes || []) {
        if (!change.summary || change.summary.length < 35) continue;
        changes.push({
          company_id: company.id,
          company_name: company.name,
          title: change.title || `${company.name} profile updated`,
          summary: change.summary,
          signal_type: change.signal_type || 'profile_change',
          source_url: change.source_url || cleaned.sources?.[0]?.url || '',
          confidence: Number(change.confidence || cleaned.confidence || 0.65),
          actionable: /funding|hiring|launch|leadership|partnership|expansion/i.test(change.summary),
        });
      }
    }
    return changes;
  });
}

async function runCompanyDiscovery(limit = 8) {
  const [profile, existing] = await Promise.all([
    queryOne('SELECT taste_profile,target_roles,skills FROM user_profile ORDER BY id LIMIT 1'),
    query('SELECT name,website FROM companies'),
  ]);
  if (!profile?.taste_profile) return [];
  return executeAgent('company-discovery', {
    trigger: 'scheduled',
    input: { existing_count: existing.length, taste_profile: profile.taste_profile },
  }, async () => {
    const themes = await askJson(`Turn this networking taste profile into 3 concise company-search queries.
Focus on sectors, stages, missions, operating characteristics, and current momentum—not outreach tone.
Return only JSON: {"queries":["","",""]}\n\nPROFILE:\n${profile.taste_profile}`, 500);
    const evidence = [];
    for (const q of themes?.queries || []) {
      const search = await trackedExaSearch({
        query: `${q} startup company funding hiring product`,
        num_results: 6,
        text: { maxCharacters: 900 },
        startPublishedDate: new Date(Date.now() - 180 * 86400000).toISOString(),
      });
      evidence.push(...(search.results || []).map(item => ({
        title: item.title, url: item.url, publishedDate: item.publishedDate, text: item.text,
      })));
    }
    const candidates = await askJson(`Find up to ${limit} real companies that match the user's profile.
Exclude every company in EXISTING. Require a real company website or strong source URL.
Return only JSON:
[{"name":"","website":"","sector":"","stage":"","description":"","location":"","why_fit":"","why_now":"","source_url":"","confidence":0.0}]

USER PROFILE:
${profile.taste_profile}

EXISTING:
${JSON.stringify(existing)}

EVIDENCE:
${JSON.stringify(evidence)}`, 1800);
    const existingNames = new Set(existing.map(item => String(item.name).toLowerCase()));
    return (Array.isArray(candidates) ? candidates : [])
      .filter(item => item.name && item.source_url && !existingNames.has(String(item.name).toLowerCase()))
      .slice(0, limit)
      .map(item => ({
        title: `New company candidate: ${item.name}`,
        company_name: item.name,
        summary: `${item.description || ''}${item.why_fit ? ` Fit: ${item.why_fit}` : ''}${item.why_now ? ` Why now: ${item.why_now}` : ''}`.trim(),
        signal_type: 'company_candidate',
        entity_type: 'company_candidate',
        source_url: item.source_url,
        confidence: Number(item.confidence || 0.65),
        actionable: true,
        data: item,
      }));
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

async function agentIsDue(agentKey, intervalHours) {
  const lastRun = await queryOne(
    `SELECT completed_at FROM agent_runs
     WHERE agent_key=$1 AND status='completed'
     ORDER BY completed_at DESC LIMIT 1`,
    [agentKey]
  );
  if (!lastRun?.completed_at) return true;
  const completed = new Date(String(lastRun.completed_at).replace(' ', 'T') + 'Z').getTime();
  return (Date.now() - completed) / 3_600_000 >= intervalHours;
}

async function runIntelligenceCycle() {
  const [monitorAgent, auditAgent, investigatorAgent, curatorAgent, discoveryAgent] = await Promise.all([
    queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='company-signal-monitor'`),
    queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='evidence-auditor'`),
    queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='opportunity-investigator'`),
    queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='company-profile-curator'`),
    queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='company-discovery'`),
  ]);
  const monitorSchedule = typeof monitorAgent?.schedule_json === 'string' ? JSON.parse(monitorAgent.schedule_json || '{}') : (monitorAgent?.schedule_json || {});
  const auditSchedule = typeof auditAgent?.schedule_json === 'string' ? JSON.parse(auditAgent.schedule_json || '{}') : (auditAgent?.schedule_json || {});
  const investigatorSchedule = typeof investigatorAgent?.schedule_json === 'string' ? JSON.parse(investigatorAgent.schedule_json || '{}') : (investigatorAgent?.schedule_json || {});
  const curatorSchedule = typeof curatorAgent?.schedule_json === 'string' ? JSON.parse(curatorAgent.schedule_json || '{}') : (curatorAgent?.schedule_json || {});
  const discoverySchedule = typeof discoveryAgent?.schedule_json === 'string' ? JSON.parse(discoveryAgent.schedule_json || '{}') : (discoveryAgent?.schedule_json || {});
  const monitorDue = await agentIsDue('company-signal-monitor', Number(monitorSchedule.interval_hours || 6));
  const auditDue = await agentIsDue('evidence-auditor', Number(auditSchedule.interval_hours || 6));
  const curatorDue = await agentIsDue('company-profile-curator', Number(curatorSchedule.interval_hours || 24));
  const discoveryDue = await agentIsDue('company-discovery', Number(discoverySchedule.interval_hours || 3));
  const monitored = monitorDue ? await runCompanySignalMonitor(Number(monitorSchedule.batch_limit || 6)) : [];
  const audited = auditDue ? await runEvidenceAuditor(Number(auditSchedule.batch_limit || 30)) : [];
  const curated = curatorDue ? await runCompanyProfileCurator(Number(curatorSchedule.batch_limit || 4)) : [];
  const discovered = discoveryDue ? await runCompanyDiscovery(Number(discoverySchedule.batch_limit || 6)) : [];
  const dailyLimit = Math.max(0, Number(investigatorSchedule.daily_limit || 3));
  const cooldownDays = Math.max(1, Number(investigatorSchedule.cooldown_days || 7));
  const minSignals = Math.max(1, Number(investigatorSchedule.min_signal_count || 2));
  const investigatedToday = await queryOne(
    `SELECT COUNT(*) AS n FROM agent_runs
     WHERE agent_key='opportunity-investigator'
       AND created_at >= to_char(CURRENT_DATE,'YYYY-MM-DD')`
  );
  const remainingInvestigations = Math.max(0, dailyLimit - Number(investigatedToday?.n || 0));
  const candidates = remainingInvestigations ? await query(
    `SELECT c.id,COUNT(s.id) AS signal_count,MAX(s.confidence) AS confidence
     FROM companies c JOIN agent_signals s ON s.company_id=c.id
     WHERE s.status='new' AND s.created_at >= to_char(CURRENT_DATE - INTERVAL '7 days','YYYY-MM-DD')
       AND c.status NOT IN ('passed','archived')
     GROUP BY c.id,c.score
     HAVING COUNT(s.id)>=$1 OR (COALESCE(c.score,0)>=4 AND MAX(s.confidence)>=0.65)
     ORDER BY COUNT(s.id) DESC,MAX(s.confidence) DESC LIMIT $2`,
    [minSignals, remainingInvestigations]
  ) : [];
  const dust = [];
  for (const candidate of candidates) {
    const recent = await queryOne(
      `SELECT id FROM agent_runs WHERE agent_key='opportunity-investigator' AND company_id=$1
       AND created_at >= to_char(CURRENT_DATE - ($2 * INTERVAL '1 day'),'YYYY-MM-DD') LIMIT 1`,
      [candidate.id, cooldownDays]
    );
    if (!recent) {
      try { dust.push(await runOpportunityInvestigator(candidate.id)); } catch (error) {
        console.warn('[IntelligenceCycle] Dust investigation skipped:', error.message);
      }
    }
  }
  return {
    monitored: monitored.length,
    audited: audited.length,
    curated: curated.length,
    discovered: discovered.length,
    investigated: dust.length,
    monitor_due: monitorDue,
    audit_due: auditDue,
    curator_due: curatorDue,
    discovery_due: discoveryDue,
    dust_remaining_today: Math.max(0, remainingInvestigations - dust.length),
  };
}

module.exports = {
  runCompanySignalMonitor,
  runCompanyProfileCurator,
  runCompanyDiscovery,
  runEvidenceAuditor,
  runOpportunityInvestigator,
  runRelationshipPathfinder,
  runFollowUpStrategist,
  curateTunerFeed,
  runOutcomeLearning,
  runAgentPortfolioManager,
  runIntelligenceCycle,
};
