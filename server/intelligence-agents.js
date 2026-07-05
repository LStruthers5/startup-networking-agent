const { query, queryOne, execute, nowText, today, daysFromNow, daysAgo } = require('./db');
const {
  NATIVE_AGENTS,
  executeAgent,
  trackedAnthropicClient,
  trackedExaSearch,
  recordProviderUsage,
  monthlySpend,
  todaySpend,
} = require('./agent-control');
const { extractDustPayload, dustPayloadToSignals } = require('./dust-response');

// Records a real "checked, nothing to do" completed run instead of silently returning [] before ever
// calling executeAgent. Without this, an agent that keeps finding nothing due never gets a completed_at
// timestamp, so the roster shows it as having never run and the orchestrator treats it as perpetually
// overdue — even though it's actually being checked on schedule and correctly finding nothing to act on.
function emptyRun(agentKey, input = {}) {
  return executeAgent(agentKey, { trigger: 'scheduled', input: { ...input, skipped: 'nothing to act on' } }, async () => []);
}

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
  if (!companies.length) return emptyRun('company-signal-monitor');
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
  if (!signals.length) return emptyRun('evidence-auditor');
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
  if (!companies.length) return emptyRun('company-profile-curator');
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
  const [companies, contacts, investors, profile] = await Promise.all([
    query(`SELECT * FROM companies WHERE status NOT IN ('passed','archived') ORDER BY score DESC NULLS LAST LIMIT $1`, [limit]),
    query('SELECT * FROM contacts ORDER BY firm,name'),
    query(`SELECT * FROM investors WHERE confirmed=1 ORDER BY relationship_status DESC,last_touched DESC NULLS LAST LIMIT 100`),
    queryOne('SELECT taste_profile,outreach_prefs FROM user_profile ORDER BY id LIMIT 1'),
  ]);
  if (!companies.length) return emptyRun('relationship-pathfinder');
  return executeAgent('relationship-pathfinder', {
    trigger: 'scheduled',
    input: { company_ids: companies.map(c => c.id) },
  }, async () => {
    const result = await askJson(`Map the strongest realistic relationship path for each company.
Use only supplied records. Never invent a connection. Return only JSON:
[{"company_id":1,"title":"Path into Company","summary":"","path_type":"direct|warm|contextual|cold","confidence":0.0,"recommended_action":""}]

USER PREFERENCES:
${profile?.taste_profile || 'Not yet refined'}
${JSON.stringify(profile?.outreach_prefs || {})}

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
  const [actions, profile] = await Promise.all([query(
    `SELECT a.*,c.name AS company_name,c.sector,c.stage,c.score
     FROM actions a JOIN companies c ON c.id=a.company_id
     WHERE a.completed=0 AND a.outreach_type!='agent-recommendation'
       AND (a.due_date IS NULL OR a.due_date <= $1)
    ORDER BY a.due_date ASC NULLS LAST LIMIT $2`,
    [daysFromNow(3), limit]
  ), queryOne('SELECT taste_profile,outreach_prefs FROM user_profile ORDER BY id LIMIT 1')]);
  if (!actions.length) return emptyRun('follow-up-strategist');
  return executeAgent('follow-up-strategist', {
    trigger: 'scheduled',
    input: { action_ids: actions.map(a => a.id) },
  }, async () => {
    const result = await askJson(`Recommend the next human-reviewed move for each action.
Never send outreach. Return only JSON:
[{"company_id":1,"action_id":1,"title":"Next step for Company","summary":"","recommended_action":"wait|follow_up_with_new_signal|change_channel|ask_for_intro|close_loop|stop","due_date":"YYYY-MM-DD","confidence":0.0}]

USER PREFERENCES:
${profile?.taste_profile || 'Not yet refined'}
${JSON.stringify(profile?.outreach_prefs || {})}

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

const MOMENTUM_DECAY = 0.75;
const MOMENTUM_THRESHOLD = 6;
const MOMENTUM_STREAK_REQUIRED = 2;
const MOMENTUM_BASELINE_DAYS = 3;
const MOMENTUM_REALERT_DAYS = 21;

// Tracks whether a company keeps showing new promise across cycles (momentum), rather than reacting
// to any single signal. Decays quietly when a company goes cold; compounds when it keeps producing
// fresh actionable evidence. Only alerts once a company has stayed above threshold for at least
// MOMENTUM_STREAK_REQUIRED consecutive checks — a single high-signal cycle is never enough on its own.
async function runLeadMomentumTracker(limit = 20) {
  const companies = await query(
    `SELECT c.id, c.name, c.sector, c.stage, c.description, c.last_funding, c.funding_amount,
            c.momentum_score, c.momentum_updated_at, c.momentum_streak, c.hot_lead_alerted_at
     FROM companies c
     WHERE c.status NOT IN ('passed','archived')
       AND EXISTS (
         SELECT 1 FROM agent_signals s
         WHERE s.company_id = c.id AND s.actionable = 1
           AND s.created_at >= to_char(NOW() - INTERVAL '14 days', 'YYYY-MM-DD HH24:MI:SS')
       )
     ORDER BY c.momentum_score DESC NULLS LAST LIMIT $1`,
    [limit]
  );
  if (!companies.length) return emptyRun('lead-momentum-tracker');

  return executeAgent('lead-momentum-tracker', {
    trigger: 'scheduled',
    input: { company_ids: companies.map(c => c.id) },
  }, async () => {
    const alerts = [];
    for (const company of companies) {
      // First-ever check for a company only looks back a few days, not the full candidate window —
      // otherwise a company with pre-existing signal density would spike over threshold in one lump
      // sum on cycle one, which is a cold-start artifact, not real sustained momentum.
      const since = company.momentum_updated_at || `${daysAgo(MOMENTUM_BASELINE_DAYS)} 00:00:00`;
      const recentSignals = await query(
        `SELECT title, summary, signal_type, confidence, created_at FROM agent_signals
         WHERE company_id=$1 AND actionable=1 AND created_at > $2
         ORDER BY created_at DESC LIMIT 20`,
        [company.id, since]
      );
      const oldMomentum = Number(company.momentum_score || 0);
      const avgConfidence = recentSignals.length
        ? recentSignals.reduce((sum, s) => sum + Number(s.confidence || 0.5), 0) / recentSignals.length
        : 0;
      const newMomentum = Math.round((oldMomentum * MOMENTUM_DECAY + recentSignals.length * avgConfidence * 2) * 100) / 100;
      const newStreak = newMomentum >= MOMENTUM_THRESHOLD ? Number(company.momentum_streak || 0) + 1 : 0;
      await execute(
        'UPDATE companies SET momentum_score=$1, momentum_updated_at=$2, momentum_streak=$3 WHERE id=$4',
        [newMomentum, nowText(), newStreak, company.id]
      );

      const alertedRecently = company.hot_lead_alerted_at
        && (Date.now() - new Date(String(company.hot_lead_alerted_at).replace(' ', 'T') + 'Z').getTime()) / 86_400_000 < MOMENTUM_REALERT_DAYS;
      if (newStreak < MOMENTUM_STREAK_REQUIRED || alertedRecently || !process.env.RESEND_API_KEY) continue;

      const [intel, path, investorFits, contacts] = await Promise.all([
        queryOne('SELECT hiring_summary, why_now, open_questions, warnings, preference_fit, sources FROM company_intelligence WHERE company_id=$1', [company.id]),
        queryOne(`SELECT title, summary, data_json FROM agent_signals WHERE company_id=$1 AND agent_key='relationship-pathfinder' ORDER BY created_at DESC LIMIT 1`, [company.id]),
        query(`SELECT title, summary, data_json FROM agent_signals WHERE company_id=$1 AND agent_key='sourcing-fit-scorer' ORDER BY confidence DESC LIMIT 3`, [company.id]),
        query(`SELECT name, firm, how_i_know_them FROM contacts`),
      ]);

      const packageResult = await askJson(`You're briefing the user on a lead that has kept showing genuine promise across
multiple monitoring cycles (momentum score ${newMomentum}, threshold ${MOMENTUM_THRESHOLD}) — this is not a one-off signal,
it's sustained. Write a tight, honest brief. Do not invent facts not present in the evidence below.

Return ONLY valid JSON:
{
  "what_we_know": ["short factual bullet", "..."],
  "open_questions": ["short bullet naming what's still unknown", "..."],
  "low_stakes_reachout": {"angle":"a low-pressure move worth auto-drafting (e.g. warm comment, light-touch note)", "channel":"email|linkedin", "why_low_stakes":"why this carries little downside"},
  "high_reward_reachout": {"angle":"the highest-leverage move available", "path":"specifically who/how, grounded only in the evidence given", "why_high_reward":"why this is worth doing personally rather than automating"}
}

COMPANY:
${JSON.stringify({ name: company.name, sector: company.sector, stage: company.stage, description: company.description, last_funding: company.last_funding, funding_amount: company.funding_amount })}

RECENT ACTIONABLE SIGNALS (this cycle):
${JSON.stringify(recentSignals.map(s => ({ type: s.signal_type, title: s.title, summary: s.summary, confidence: s.confidence })))}

COMPANY INTELLIGENCE (if curated):
${JSON.stringify(intel || {})}

RELATIONSHIP PATH (if mapped):
${JSON.stringify(path || {})}

INVESTOR FIT MATCHES (if scored):
${JSON.stringify(investorFits || [])}

YOUR EXISTING CONTACTS (for warm-path grounding only — do not invent a relationship not implied here):
${JSON.stringify(contacts || [])}`, 1400);

      if (!packageResult?.what_we_know?.length) continue;

      const { sendHotLeadAlert } = require('./email');
      try {
        await sendHotLeadAlert(company, packageResult, newMomentum);
        await execute('UPDATE companies SET hot_lead_alerted_at=$1 WHERE id=$2', [nowText(), company.id]);
      } catch (error) {
        console.warn('[LeadMomentumTracker] Hot lead email failed:', error.message);
      }

      alerts.push({
        title: `High-conviction lead: ${company.name}`,
        summary: `Momentum ${newMomentum} — ${packageResult.what_we_know[0] || 'sustained signal across cycles'}`,
        signal_type: 'hot_lead',
        entity_type: 'company',
        entity_id: company.id,
        company_id: company.id,
        confidence: Math.min(0.95, newMomentum / 10),
        actionable: true,
        data: { momentum: newMomentum, ...packageResult },
      });
    }
    return alerts;
  });
}

async function runInvestmentThesisResearcher(limit = 4) {
  const investors = await query(
    `SELECT id,name,firm,role,investor_type,stage_focus,sector_focus,portfolio_companies
     FROM investors
     WHERE confirmed=1
       AND (thesis_refined_at IS NULL OR thesis_refined_at < to_char(NOW() - INTERVAL '30 days','YYYY-MM-DD HH24:MI:SS'))
     ORDER BY thesis_refined_at ASC NULLS FIRST, tier ASC LIMIT $1`,
    [limit]
  );
  if (!investors.length) return emptyRun('investment-thesis-researcher');
  return executeAgent('investment-thesis-researcher', {
    trigger: 'scheduled',
    input: { investor_ids: investors.map(i => i.id) },
  }, async () => {
    const results = [];
    for (const investor of investors) {
      let evidence = '';
      const sources = [];
      try {
        const search = await trackedExaSearch({
          query: `"${investor.name}" ${investor.firm || ''} investment thesis portfolio companies writes about invests in`,
          num_results: 6,
          text: { maxCharacters: 800 },
        });
        for (const r of (search.results || [])) sources.push({ title: r.title, url: r.url });
        evidence = (search.results || []).map(r => `- ${r.title}: ${r.text || ''}`).join('\n');
      } catch (_) {}

      const thesis = await askJson(`Based on the evidence below, synthesize what this investor actually looks for when deciding to invest.
Be specific and grounded only in the evidence provided — if evidence is thin, say so via a low confidence score rather than inventing detail.
Return only JSON:
{
  "thesis_profile": "120-180 word synthesis of what this investor cares about, the kinds of founders/companies/problems that excite them, and how they tend to engage",
  "sectors": ["sector1","sector2"],
  "stages": ["pre-seed","seed"],
  "avoid": "short note on what they explicitly avoid or pass on, if evident",
  "confidence": 0.0
}

INVESTOR: ${investor.name} | ${investor.firm || ''} | ${investor.role || ''} | ${investor.investor_type || 'VC'}
KNOWN STAGE/SECTOR FOCUS: ${[investor.stage_focus, investor.sector_focus].filter(Boolean).join(' / ') || 'unknown'}
KNOWN PORTFOLIO: ${investor.portfolio_companies || 'unknown'}

EVIDENCE:
${evidence || '(no public evidence found)'}`, 900);

      if (!thesis) continue;
      const ts = nowText();
      await execute(
        `UPDATE investors SET thesis_profile=$1, thesis_sectors=$2, thesis_stages=$3, thesis_avoid=$4,
         thesis_sources=$5, thesis_confidence=$6, thesis_refined_at=$7 WHERE id=$8`,
        [
          thesis.thesis_profile || '', JSON.stringify(thesis.sectors || []), JSON.stringify(thesis.stages || []),
          thesis.avoid || '', JSON.stringify(sources), Math.max(0, Math.min(1, Number(thesis.confidence || 0))),
          ts, investor.id,
        ]
      );
      results.push({
        title: `Thesis refreshed: ${investor.name}`,
        summary: thesis.thesis_profile,
        signal_type: 'investor_thesis',
        entity_type: 'investor',
        entity_id: investor.id,
        confidence: Number(thesis.confidence || 0.5),
        actionable: false,
        data: { investor_id: investor.id, ...thesis },
      });
    }
    return results;
  });
}

async function runSourcingFitScorer(companyId) {
  const [company, investors] = await Promise.all([
    queryOne('SELECT * FROM companies WHERE id=$1', [companyId]),
    query(`SELECT id,name,firm,role,investor_type,thesis_profile,thesis_sectors,thesis_stages,relationship_status
           FROM investors WHERE confirmed=1 AND thesis_profile IS NOT NULL AND thesis_profile!='' LIMIT 60`),
  ]);
  if (!company || !investors.length) return company ? emptyRun('sourcing-fit-scorer', { company_id: companyId }) : [];
  return executeAgent('sourcing-fit-scorer', {
    companyId,
    trigger: 'event',
    input: { company_id: companyId, investor_count: investors.length },
  }, async () => {
    const result = await askJson(`Score how well this company fits each investor's stated thesis. Use ONLY the thesis text given — do not invent fit.
Return only the investors worth flagging (score >= 0.55), ranked highest first. Return only JSON:
[{"investor_id":1,"fit_score":0.0,"rationale":"one sentence — be specific about the thesis match"}]

COMPANY:
${JSON.stringify({ name: company.name, sector: company.sector, stage: company.stage, description: company.description })}

INVESTORS:
${JSON.stringify(investors.map(i => ({ id: i.id, name: i.name, firm: i.firm, thesis: i.thesis_profile, sectors: i.thesis_sectors, stages: i.thesis_stages })))}`, 1200);

    const fits = Array.isArray(result) ? result : [];
    return fits.filter(f => f.investor_id && f.fit_score >= 0.55).map(f => {
      const inv = investors.find(i => i.id === f.investor_id);
      return {
        title: `${inv?.name || 'Investor'} fits ${company.name}`,
        company_id: companyId,
        summary: f.rationale,
        signal_type: 'investor_fit',
        entity_type: 'investor',
        entity_id: f.investor_id,
        confidence: Number(f.fit_score),
        actionable: true,
        data: { investor_id: f.investor_id, investor_name: inv?.name, firm: inv?.firm, fit_score: f.fit_score },
      };
    });
  });
}

async function runCalendarCrossReference(days = 7) {
  const { listUpcomingEvents } = require('./google-calendar');
  let events = [];
  try { events = await listUpcomingEvents(days); } catch (_) { return []; }
  if (!events.length) return emptyRun('calendar-cross-reference');

  const investors = await query(
    `SELECT id,name,firm,role,investor_type,thesis_profile,relationship_status FROM investors WHERE confirmed=1`
  );
  if (!investors.length) return emptyRun('calendar-cross-reference');

  return executeAgent('calendar-cross-reference', {
    trigger: 'scheduled',
    input: { event_count: events.length },
  }, async () => {
    const matches = await askJson(`For each calendar event, identify which of these investors are plausibly attending,
based on attendee names/emails matching investor names or firm domains. Only match when there's a real textual
overlap — never guess. Return only JSON:
[{"event_title":"","event_start":"","investor_id":1,"matched_on":"name|email|firm","confidence":0.0,"why":"one sentence on why this matters given their thesis or relationship status"}]

EVENTS:
${JSON.stringify(events.map(e => ({ title: e.title, start: e.start, attendees: e.attendees })))}

INVESTORS:
${JSON.stringify(investors.map(i => ({ id: i.id, name: i.name, firm: i.firm, role: i.role, relationship_status: i.relationship_status, thesis: i.thesis_profile })))}`, 1400);

    const results = Array.isArray(matches) ? matches : [];
    return results.filter(m => m.investor_id && m.confidence >= 0.5).map(m => {
      const inv = investors.find(i => i.id === m.investor_id);
      return {
        title: `${inv?.name || 'Investor'} may be at ${m.event_title}`,
        summary: `${m.event_start ? m.event_start + ' — ' : ''}${m.why || ''}`,
        signal_type: 'calendar_match',
        entity_type: 'investor',
        entity_id: m.investor_id,
        confidence: Number(m.confidence),
        actionable: true,
        data: { investor_id: m.investor_id, investor_name: inv?.name, event_title: m.event_title, event_start: m.event_start, matched_on: m.matched_on },
      };
    });
  });
}

async function runGmailLeadScout(days = 3, limit = 40) {
  const { listRecentInboxMessages } = require('./gmail');
  let messages = [];
  try { messages = await listRecentInboxMessages(days, limit); } catch (_) { return []; }
  if (!messages.length) return emptyRun('gmail-lead-scout');

  const [companies, investors] = await Promise.all([
    query(`SELECT id,name FROM companies WHERE status NOT IN ('passed','archived')`),
    query(`SELECT id,name,firm FROM investors WHERE confirmed=1`),
  ]);
  if (!companies.length && !investors.length) return emptyRun('gmail-lead-scout');

  return executeAgent('gmail-lead-scout', {
    trigger: 'scheduled',
    input: { message_count: messages.length },
  }, async () => {
    const matches = await askJson(`For each inbox message, identify whether it plausibly relates to one of these tracked
companies or investors, based on real textual overlap in the subject, sender, or snippet — never guess. Look for
intro requests, replies from an investor, or newsletter/press mentions of a tracked company.
Return only JSON:
[{"message_subject":"","message_from":"","match_type":"company|investor","matched_id":1,"matched_name":"","confidence":0.0,"why":"one sentence on why this matters"}]

MESSAGES:
${JSON.stringify(messages.map(m => ({ subject: m.subject, from: m.from, snippet: m.snippet })))}

COMPANIES:
${JSON.stringify(companies)}

INVESTORS:
${JSON.stringify(investors.map(i => ({ id: i.id, name: i.name, firm: i.firm })))}`, 1800);

    const results = Array.isArray(matches) ? matches : [];
    return results.filter(m => m.matched_id && m.confidence >= 0.5).map(m => ({
      title: `${m.matched_name || 'Tracked target'} mentioned in inbox: ${m.message_subject}`,
      summary: `From ${m.message_from} — ${m.why || ''}`,
      signal_type: 'email_signal',
      entity_type: m.match_type === 'investor' ? 'investor' : 'company',
      entity_id: m.matched_id,
      company_id: m.match_type === 'company' ? m.matched_id : null,
      confidence: Number(m.confidence),
      actionable: true,
      data: { matched_id: m.matched_id, matched_name: m.matched_name, match_type: m.match_type, subject: m.message_subject, from: m.message_from },
    }));
  });
}

async function curateTunerFeed(limit = 24) {
  const [companies, investors, events, signals, paths, history] = await Promise.all([
    query(`SELECT id,name,sector,stage,description,score FROM companies
      WHERE status NOT IN ('passed','archived') ORDER BY score DESC NULLS LAST,date_added DESC LIMIT 24`),
    query(`SELECT id,name,firm,role,stage_focus,sector_focus,relationship_status
      FROM investors WHERE confirmed=1 ORDER BY last_touched DESC NULLS LAST,tier ASC LIMIT 24`),
    query(`SELECT id,title,event_date,location,description,host_name
      FROM events WHERE dismissed=0 ORDER BY event_date ASC NULLS LAST LIMIT 20`),
    query(`SELECT s.id,s.signal_type,s.title,s.summary,s.confidence,s.source_name,s.company_id,
        c.name AS company_name,c.sector,c.stage
      FROM agent_signals s LEFT JOIN companies c ON c.id=s.company_id
      WHERE s.status='new' AND s.duplicate_of_id IS NULL AND s.agent_key!='evidence-auditor'
        AND LENGTH(TRIM(COALESCE(s.summary,'')))>=35
      ORDER BY s.actionable DESC,s.created_at DESC LIMIT 30`),
    query(`SELECT s.id,s.title,s.summary,s.confidence,s.company_id,c.name AS company_name
      FROM agent_signals s LEFT JOIN companies c ON c.id=s.company_id
      WHERE s.agent_key='relationship-pathfinder' AND s.status='new'
      ORDER BY s.created_at DESC LIMIT 16`),
    query(`SELECT category,left_json,right_json FROM preference_events ORDER BY id DESC LIMIT 300`),
  ]);

  const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const signature = (category, left, right) => {
    const labels = [normalize(left.label || left.name), normalize(right.label || right.name)].sort();
    return `${category}|${labels.join('|')}`;
  };
  const seen = new Set(history.map(row => {
    const left = parseJson(row.left_json, {});
    const right = parseJson(row.right_json, {});
    return signature(row.category, left, right);
  }));
  const duels = [];
  const addPair = (category, prompt, left, right, priority = 1) => {
    if (!left?.label || !right?.label || left.label === right.label) return;
    const key = signature(category, left, right);
    if (seen.has(key) || duels.some(duel => duel.pair_key === key)) return;
    duels.push({ category, prompt, left, right, priority, pair_key: key });
  };
  const pairCombinations = (category, prompt, items, priority = 1, maxPairs = 8) => {
    let added = 0;
    for (let left = 0; left < items.length && added < maxPairs; left++) {
      for (let right = left + 1; right < items.length && added < maxPairs; right++) {
        const before = duels.length;
        addPair(category, prompt, items[left], items[right], priority);
        if (duels.length > before) added++;
      }
    }
  };

  const tone = [
    { label: 'Warm and observant', sample: 'Sound human and specific; notice something real before making an ask.', tags: ['tone:warm', 'tone:personal'] },
    { label: 'Crisp and analytical', sample: 'Lead with the useful pattern or reason for reaching out; keep sentiment restrained.', tags: ['tone:direct', 'tone:analytical'] },
    { label: 'Curious and exploratory', sample: 'Make the message feel like an invitation to compare notes, not a transaction.', tags: ['tone:curious', 'tone:peer'] },
    { label: 'Polished and credible', sample: 'Favor precise language, professional framing, and a clear reason the conversation matters.', tags: ['tone:polished', 'tone:formal'] },
    { label: 'Energetic and ambitious', sample: 'Show conviction and momentum without sounding promotional.', tags: ['tone:energetic', 'tone:bold'] },
    { label: 'Understated and concise', sample: 'Use minimal context, no flattery, and a low-pressure close.', tags: ['tone:concise', 'tone:understated'] },
  ];
  const asks = [
    { label: 'Compare notes', sample: 'Open a peer conversation around a shared market or operating question.', tags: ['ask:peer-conversation'] },
    { label: 'Request a short call', sample: 'Make a clear 15–20 minute ask when the fit is strong.', tags: ['ask:meeting'] },
    { label: 'Ask about the work', sample: 'Learn how the team approaches a problem before discussing opportunities.', tags: ['ask:learning'] },
    { label: 'Ask about openings', sample: 'Be transparent that career opportunities are part of the reason for connecting.', tags: ['ask:jobs'] },
    { label: 'Offer something useful', sample: 'Share an introduction, insight, source, or relevant pattern before asking for time.', tags: ['ask:value-first'] },
    { label: 'Stay on their radar', sample: 'Use a light-touch note without forcing an immediate meeting.', tags: ['ask:low-pressure'] },
  ];
  const channels = [
    { label: 'Email first', sample: 'Use email for a thoughtful, contextual message that can be revisited.', tags: ['channel:email'] },
    { label: 'LinkedIn first', sample: 'Use a shorter social touch when context is thin or the person is active there.', tags: ['channel:linkedin'] },
    { label: 'Warm introduction', sample: 'Wait for a credible mutual path instead of contacting cold.', tags: ['channel:warm-intro'] },
    { label: 'Event encounter', sample: 'Prefer meeting around a relevant conference, meetup, or hosted gathering.', tags: ['channel:event'] },
  ];
  const research = [
    { label: 'Strong company fit', sample: 'Spend research budget on companies that closely match your interests, even with no obvious contact path.', tags: ['research:fit'] },
    { label: 'Strong access path', sample: 'Prioritize companies where an investor, colleague, or event creates a credible route in.', tags: ['research:access'] },
    { label: 'Fresh momentum', sample: 'Favor recent funding, hiring, launches, or leadership movement.', tags: ['research:timing'] },
    { label: 'Deep mission alignment', sample: 'Favor enduring mission and product alignment over short-term news.', tags: ['research:mission'] },
    { label: 'Emerging unknowns', sample: 'Explore less obvious companies where early research could create an edge.', tags: ['research:exploration'] },
    { label: 'Established signal quality', sample: 'Concentrate on better-known companies with stronger public evidence.', tags: ['research:certainty'] },
  ];
  pairCombinations('tone', 'Which overall voice should your agents sound more like?', tone, 3);
  pairCombinations('ask', 'Which outcome should outreach optimize for?', asks, 3);
  pairCombinations('channel', 'Which contact path should agents prefer when both are available?', channels, 2);
  pairCombinations('research_priority', 'Where should the system spend the next unit of research budget?', research, 4);

  pairCombinations('company', 'Which company should rise in your opportunity ranking?', companies.map(company => ({
    label: company.name,
    name: company.name,
    company_id: company.id,
    sample: [[company.sector, company.stage].filter(Boolean).join(' · '), company.description].filter(Boolean).join('\n'),
    tags: [`sector:${company.sector || 'unknown'}`, `stage:${company.stage || 'unknown'}`],
  })), 5, 12);
  pairCombinations('investor', 'Which investor would be more valuable to build a relationship with?', investors.map(investor => ({
    label: investor.name || investor.firm,
    name: investor.name || investor.firm,
    investor_id: investor.id,
    sample: [[investor.role, investor.firm].filter(Boolean).join(' · '), [investor.sector_focus, investor.stage_focus].filter(Boolean).join(' / '), `Relationship: ${investor.relationship_status || 'unknown'}`].filter(Boolean).join('\n'),
    tags: [`investor-role:${investor.role || 'unknown'}`, `relationship:${investor.relationship_status || 'unknown'}`],
  })), 5, 10);
  pairCombinations('event', 'Which event deserves more of your attention?', events.map(event => ({
    label: event.title,
    name: event.title,
    event_id: event.id,
    sample: [[event.event_date, event.location].filter(Boolean).join(' · '), event.host_name ? `Hosted by ${event.host_name}` : '', event.description].filter(Boolean).join('\n'),
    tags: ['event', event.location ? `location:${event.location}` : ''],
  })), 4, 8);
  pairCombinations('signal', 'Which new piece of information should influence the system more?', signals.map(signal => ({
    label: signal.company_name || signal.title,
    name: signal.company_name || signal.title,
    signal_id: signal.id,
    company_id: signal.company_id,
    sample: [[signal.sector, signal.stage].filter(Boolean).join(' · '), signal.summary, signal.source_name ? `From ${signal.source_name}` : ''].filter(Boolean).join('\n'),
    tags: [`signal:${signal.signal_type}`, `confidence:${Math.round(Number(signal.confidence || 0) * 100)}`],
  })), 5, 10);
  pairCombinations('relationship', 'Which relationship path feels more worth developing?', paths.map(path => ({
    label: path.company_name || path.title,
    name: path.company_name || path.title,
    signal_id: path.id,
    company_id: path.company_id,
    sample: path.summary,
    tags: ['relationship-path'],
  })), 4, 8);

  const groups = new Map();
  for (const duel of duels.sort((a, b) => b.priority - a.priority)) {
    const group = groups.get(duel.category) || [];
    group.push(duel);
    groups.set(duel.category, group);
  }
  const selected = [];
  const categoryOrder = ['company', 'investor', 'signal', 'event', 'research_priority', 'relationship', 'tone', 'ask', 'channel'];
  while (selected.length < limit) {
    let added = false;
    for (const category of categoryOrder) {
      const duel = groups.get(category)?.shift();
      if (!duel) continue;
      selected.push(duel);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added) break;
  }
  return selected;
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

const ORCHESTRATOR_CANDIDATES = [
  'event-discovery',
  'company-signal-monitor',
  'evidence-auditor',
  'company-profile-curator',
  'company-discovery',
  'investment-thesis-researcher',
  'calendar-cross-reference',
  'gmail-lead-scout',
  'relationship-pathfinder',
  'follow-up-strategist',
  'lead-momentum-tracker',
];

function intervalHoursForSchedule(schedule) {
  if (schedule.interval_hours) return Number(schedule.interval_hours);
  const cadence = schedule.cadence || '';
  const everyMatch = cadence.match(/every-(\d+)-hours?/);
  if (everyMatch) return Number(everyMatch[1]);
  if (cadence === 'hourly') return 1;
  if (cadence === 'daily') return 24;
  if (cadence === 'weekly') return 168;
  return 24;
}

async function gatherOrchestratorState() {
  const [settings, spentToday, spentMonth, backlogSignals, backlogDrafts, backlogOverdue] = await Promise.all([
    queryOne(`SELECT daily_target_usd, monthly_ceiling_usd FROM control_tower_settings WHERE owner_id='local'`),
    todaySpend(),
    monthlySpend(),
    queryOne(`SELECT COUNT(*) AS n FROM agent_signals WHERE status='new' AND actionable=1`),
    queryOne(`SELECT COUNT(*) AS n FROM drafts WHERE status='pending'`),
    queryOne(`SELECT COUNT(*) AS n FROM actions WHERE completed=0 AND due_date IS NOT NULL AND due_date <= $1`, [today()]),
  ]);

  const agents = [];
  for (const key of ORCHESTRATOR_CANDIDATES) {
    const def = NATIVE_AGENTS.find(a => a.key === key);
    if (!def) continue;
    const registry = await queryOne(`SELECT status, schedule_json FROM agent_registry WHERE agent_key=$1`, [key]);
    const schedule = typeof registry?.schedule_json === 'string' ? JSON.parse(registry.schedule_json || '{}') : (registry?.schedule_json || def.schedule || {});
    const intervalHours = intervalHoursForSchedule(schedule);
    const lastRun = await queryOne(
      `SELECT completed_at, actionable_count, output_count FROM agent_runs
       WHERE agent_key=$1 AND status='completed' ORDER BY completed_at DESC LIMIT 1`,
      [key]
    );
    const hoursSinceLastRun = lastRun?.completed_at
      ? (Date.now() - new Date(String(lastRun.completed_at).replace(' ', 'T') + 'Z').getTime()) / 3_600_000
      : null;
    agents.push({
      agent_key: key,
      purpose: def.purpose,
      status: registry?.status || 'active',
      interval_hours: intervalHours,
      hours_since_last_run: hoursSinceLastRun === null ? null : Math.round(hoursSinceLastRun * 10) / 10,
      overdue_ratio: hoursSinceLastRun === null ? null : Math.round((hoursSinceLastRun / intervalHours) * 100) / 100,
      last_run_actionable_count: lastRun?.actionable_count ?? null,
      last_run_output_count: lastRun?.output_count ?? null,
      batch_limit: schedule.batch_limit || null,
    });
  }

  return {
    agents,
    budget: {
      daily_target_usd: Number(settings?.daily_target_usd || 2),
      spent_today_usd: Math.round(spentToday * 100) / 100,
      monthly_ceiling_usd: Number(settings?.monthly_ceiling_usd || 60),
      spent_month_usd: Math.round(spentMonth * 100) / 100,
    },
    backlog: {
      new_actionable_signals: Number(backlogSignals?.n || 0),
      pending_drafts: Number(backlogDrafts?.n || 0),
      overdue_actions: Number(backlogOverdue?.n || 0),
    },
  };
}

async function decideOrchestratorPlan(state) {
  const decisions = await askJson(`You are the scheduling brain for an autonomous networking-intelligence system.
Each agent below runs on its own cadence, but you decide whether it actually runs THIS cycle.

Never run an agent whose status is not "active". Prefer running agents that are meaningfully overdue
(overdue_ratio well above 1.0) or that unblock a real backlog (new_actionable_signals, pending_drafts,
overdue_actions). Deprioritize or skip agents whose last run produced little (low last_run_actionable_count
and last_run_output_count) if the daily budget is under pressure (spent_today_usd approaching daily_target_usd,
or spent_month_usd approaching monthly_ceiling_usd). An agent that has never run (hours_since_last_run is null)
should generally run. Never invent agents not in the list.

STATE:
${JSON.stringify(state, null, 2)}

Return ONLY valid JSON:
[{"agent_key":"","run":true,"reason":"one short sentence"}]`, 1600);

  return Array.isArray(decisions) ? decisions : [];
}

// The master loop: one LLM decision per cycle over which research agents are worth running right now,
// given staleness, backlog pressure, recent yield, and remaining budget — replacing a fixed cron-per-agent
// schedule with a single point of judgment. Never touches outreach sending; only read/research agents.
async function runMasterOrchestrator() {
  const state = await gatherOrchestratorState();
  const activeCandidates = state.agents.filter(a => a.status === 'active');
  if (!activeCandidates.length) return { ran: [], skipped: [], reasoning: 'No active candidate agents.' };

  return executeAgent('agent-orchestrator', {
    trigger: 'scheduled',
    input: { candidate_count: activeCandidates.length, budget: state.budget, backlog: state.backlog },
  }, async () => {
    const decisions = await decideOrchestratorPlan(state);
    const decisionByKey = new Map(decisions.map(d => [d.agent_key, d]));

    // Hard cooldown floor — never re-run within half an agent's own interval, regardless of the model's call.
    const toRun = ORCHESTRATOR_CANDIDATES.filter(key => {
      const info = state.agents.find(a => a.agent_key === key);
      if (!info || info.status !== 'active') return false;
      if (!decisionByKey.get(key)?.run) return false;
      if (info.hours_since_last_run != null && info.hours_since_last_run < info.interval_hours * 0.5) return false;
      return true;
    });

    const cycleStart = nowText();
    const results = {};
    let curatedOutput = [];
    for (const key of toRun) {
      try {
        if (key === 'event-discovery') {
          const { runEventDiscovery } = require('./agents');
          const trackedInvestors = await query('SELECT * FROM investors WHERE track_events=1 ORDER BY name');
          results[key] = trackedInvestors.length ? (await runEventDiscovery(trackedInvestors)).length : 0;
        } else {
          const info = state.agents.find(a => a.agent_key === key);
          const runner = {
            'company-signal-monitor': () => runCompanySignalMonitor(Number(info?.batch_limit || 6)),
            'evidence-auditor': () => runEvidenceAuditor(Number(info?.batch_limit || 30)),
            'company-profile-curator': () => runCompanyProfileCurator(Number(info?.batch_limit || 4)),
            'company-discovery': () => runCompanyDiscovery(Number(info?.batch_limit || 6)),
            'investment-thesis-researcher': () => runInvestmentThesisResearcher(Number(info?.batch_limit || 4)),
            'calendar-cross-reference': () => runCalendarCrossReference(7),
            'gmail-lead-scout': () => runGmailLeadScout(3, 40),
            'relationship-pathfinder': () => runRelationshipPathfinder(Number(info?.batch_limit || 8)),
            'follow-up-strategist': () => runFollowUpStrategist(Number(info?.batch_limit || 12)),
            'lead-momentum-tracker': () => runLeadMomentumTracker(Number(info?.batch_limit || 20)),
          }[key];
          const output = runner ? await runner() : [];
          results[key] = output.length;
          if (key === 'company-profile-curator') curatedOutput = output;
        }
      } catch (error) {
        results[key] = { error: error.message };
      }
    }

    // Opportunity escalation and sourcing-fit scoring always get a light pass — they self-limit via
    // daily caps and cooldowns already, so they don't need their own orchestrator decision.
    let investigated = [];
    try {
      const investigatorAgent = await queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='opportunity-investigator'`);
      const investigatorSchedule = typeof investigatorAgent?.schedule_json === 'string' ? JSON.parse(investigatorAgent.schedule_json || '{}') : (investigatorAgent?.schedule_json || {});
      const dailyLimit = Math.max(0, Number(investigatorSchedule.daily_limit || 3));
      const minSignals = Math.max(1, Number(investigatorSchedule.min_signal_count || 2));
      const investigatedToday = await queryOne(
        `SELECT COUNT(*) AS n FROM agent_runs WHERE agent_key='opportunity-investigator' AND created_at >= to_char(CURRENT_DATE,'YYYY-MM-DD HH24:MI:SS')`
      );
      const remaining = Math.max(0, dailyLimit - Number(investigatedToday?.n || 0));
      if (remaining) {
        const candidates = await query(
          `SELECT c.id,COUNT(s.id) AS signal_count,MAX(s.confidence) AS confidence
           FROM companies c JOIN agent_signals s ON s.company_id=c.id
           WHERE s.status='new' AND s.created_at >= to_char(CURRENT_DATE - INTERVAL '7 days','YYYY-MM-DD')
             AND c.status NOT IN ('passed','archived')
           GROUP BY c.id,c.score
           HAVING COUNT(s.id)>=$1 OR (COALESCE(c.score,0)>=4 AND MAX(s.confidence)>=0.65)
           ORDER BY COUNT(s.id) DESC,MAX(s.confidence) DESC LIMIT $2`,
          [minSignals, remaining]
        );
        for (const candidate of candidates) {
          try { investigated.push(...(await runOpportunityInvestigator(candidate.id))); } catch (_) {}
        }
      }
    } catch (_) {}

    // Score sourcing fit for companies whose intelligence profile just got refreshed this cycle —
    // mirrors what the old runIntelligenceCycle did, restored here so curator output keeps flowing
    // into investor-fit matching instead of dead-ending.
    let fitScored = [];
    for (const item of curatedOutput.slice(0, 4)) {
      const companyId = item?.data?.company_id || item?.entity_id;
      if (!companyId) continue;
      try { fitScored.push(...(await runSourcingFitScorer(companyId))); } catch (_) {}
    }

    const skipped = ORCHESTRATOR_CANDIDATES.filter(k => !toRun.includes(k));

    // Feature the cycle's actual findings, not just which agents ran — a plain-language digest of
    // what's genuinely new and worth attention in the information river this cycle.
    const freshSignals = await query(
      `SELECT s.title, s.summary, s.signal_type, s.confidence, c.name AS company_name
       FROM agent_signals s LEFT JOIN companies c ON c.id=s.company_id
       WHERE s.created_at > $1 AND s.actionable=1 AND s.agent_key NOT IN ('agent-orchestrator','evidence-auditor')
       ORDER BY s.confidence DESC LIMIT 25`,
      [cycleStart]
    );

    let digest = toRun.length
      ? `Ran ${toRun.join(', ')}.${skipped.length ? ` Skipped ${skipped.join(', ')}.` : ''}`
      : 'Nothing was due or worth running this cycle.';
    if (freshSignals.length) {
      const synthesized = await askJson(`Write a short, plain-language digest of what's genuinely worth this user's attention from
this monitoring cycle's fresh findings. Group related items, lead with the most important, skip anything trivial.
Do not just list agent names — synthesize what actually happened. 2-4 sentences max.

FRESH FINDINGS THIS CYCLE:
${JSON.stringify(freshSignals.map(s => ({ company: s.company_name, type: s.signal_type, title: s.title, summary: s.summary, confidence: s.confidence })))}

Return ONLY valid JSON: {"digest":"the 2-4 sentence summary"}`, 700);
      if (synthesized?.digest) digest = synthesized.digest;
    }

    return {
      title: 'Master Orchestrator cycle',
      summary: digest,
      decisions,
      ran: toRun,
      results,
      investigated: investigated.length,
      fit_scored: fitScored.length,
      fresh_signal_count: freshSignals.length,
    };
  });
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
  const thesisDue = await agentIsDue('investment-thesis-researcher', 24);
  const thesisRefreshed = thesisDue ? await runInvestmentThesisResearcher(4) : [];
  const calendarDue = await agentIsDue('calendar-cross-reference', 24);
  const calendarMatched = calendarDue ? await runCalendarCrossReference(7) : [];
  const gmailDue = await agentIsDue('gmail-lead-scout', 24);
  const gmailMatched = gmailDue ? await runGmailLeadScout(3, 40) : [];
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
  // Score sourcing fit for companies whose intelligence profile just got refreshed
  const fitScored = [];
  for (const item of curated.slice(0, 4)) {
    const companyId = item?.data?.company_id || item?.entity_id;
    if (!companyId) continue;
    try { fitScored.push(...(await runSourcingFitScorer(companyId))); } catch (error) {
      console.warn('[IntelligenceCycle] Sourcing fit scoring skipped:', error.message);
    }
  }
  return {
    monitored: monitored.length,
    audited: audited.length,
    curated: curated.length,
    discovered: discovered.length,
    investigated: dust.length,
    thesis_refreshed: thesisRefreshed.length,
    fit_scored: fitScored.length,
    calendar_matched: calendarMatched.length,
    gmail_matched: gmailMatched.length,
    monitor_due: monitorDue,
    audit_due: auditDue,
    curator_due: curatorDue,
    discovery_due: discoveryDue,
    thesis_due: thesisDue,
    calendar_due: calendarDue,
    gmail_due: gmailDue,
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
  runLeadMomentumTracker,
  runInvestmentThesisResearcher,
  runSourcingFitScorer,
  runCalendarCrossReference,
  runGmailLeadScout,
  curateTunerFeed,
  runOutcomeLearning,
  runAgentPortfolioManager,
  runIntelligenceCycle,
  runMasterOrchestrator,
};
