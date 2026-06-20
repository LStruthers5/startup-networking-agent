const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const { query, queryOne, execute, nowText } = require('./db');
const { normalizeSignals } = require('./signal-normalizer');

const runStorage = new AsyncLocalStorage();

const NATIVE_AGENTS = [
  { key: 'company-brief', name: 'Company Brief', purpose: 'Turn a company record into an actionable networking brief.', capabilities: ['analysis', 'recommendation'], schedule: {}, outputs: ['brief', 'action'] },
  { key: 'investor-map', name: 'Investor Mapper', purpose: 'Find and verify relevant investors and warm paths.', capabilities: ['research', 'exa-search', 'contact-mapping'], schedule: {}, outputs: ['person', 'recommendation'] },
  { key: 'queue-suggestions', name: 'Opportunity Scout', purpose: 'Build outreach-ready company and investor opportunity cards.', capabilities: ['research', 'ranking', 'contact-mapping'], schedule: { cadence: 'on-demand' }, outputs: ['company', 'person', 'recommendation'] },
  { key: 'outreach-draft', name: 'Outreach Writer', purpose: 'Draft human-reviewed outreach using the saved profile and taste.', capabilities: ['drafting'], schedule: { cadence: 'on-demand' }, outputs: ['draft'] },
  { key: 'daily-candidate-ranking', name: 'Taste Ranker', purpose: 'Rerank eligible companies using the user taste profile.', capabilities: ['ranking', 'preferences'], schedule: { cadence: 'daily', cron: '0 8 * * *' }, outputs: ['company', 'recommendation'] },
  { key: 'autonomous-drafts', name: 'Morning Draft Desk', purpose: 'Prepare investor targets and drafts for morning approval.', capabilities: ['research', 'drafting'], schedule: { cadence: 'daily', cron: '0 8 * * *' }, dependencies: ['queue-suggestions', 'outreach-draft'], outputs: ['draft', 'recommendation'] },
  { key: 'investor-dossier', name: 'Investor Dossier', purpose: 'Research a person before outreach.', capabilities: ['research', 'exa-search'], schedule: {}, outputs: ['person', 'claim'] },
  { key: 'firm-discovery', name: 'Firm People Scout', purpose: 'Find accessible people at tracked investment firms.', capabilities: ['research', 'exa-search'], schedule: {}, outputs: ['person'] },
  { key: 'portfolio-extraction', name: 'Portfolio Extractor', purpose: 'Extract portfolio companies from research evidence.', capabilities: ['extraction'], schedule: {}, outputs: ['company', 'claim'] },
  { key: 'investor-portfolio-research', name: 'Portfolio Researcher', purpose: 'Search and extract an investor portfolio for pipeline overlap.', capabilities: ['research', 'exa-search', 'extraction'], schedule: {}, outputs: ['company', 'claim'] },
  { key: 'email-finder', name: 'Contact Finder', purpose: 'Search public evidence for a usable investor contact address.', capabilities: ['research', 'exa-search'], schedule: {}, outputs: ['person', 'claim'] },
  { key: 'event-discovery', name: 'Event Monitor', purpose: 'Find relevant events involving tracked investors.', capabilities: ['monitoring', 'exa-search'], schedule: { cadence: 'every-6-hours', cron: '15 */6 * * *', frequency_multiplier: 1 }, outputs: ['event'] },
  { key: 'weekly-recap', name: 'Weekly Planner', purpose: 'Summarize pipeline health and propose weekly priorities.', capabilities: ['planning', 'recommendation'], schedule: { cadence: 'weekly', cron: '0 7 * * 1' }, outputs: ['recommendation'] },
  { key: 'profile-refiner', name: 'Taste Profiler', purpose: 'Distill Tuner choices into an inspectable preference profile.', capabilities: ['preferences', 'summarization'], schedule: {}, outputs: ['profile'] },
  { key: 'resume-parser', name: 'Resume Parser', purpose: 'Extract structured career context from a resume.', capabilities: ['extraction'], schedule: {}, outputs: ['profile'] },
];

function safeJson(value, fallback = {}) {
  if (value === undefined) return fallback;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return fallback; }
}

async function ensureAgentRegistry() {
  for (const agent of NATIVE_AGENTS) {
    await execute(
      `INSERT INTO agent_registry
        (agent_key, name, purpose, provider, model, capabilities, schedule_json, output_schema, dependencies, plan_constraints, config_json)
       VALUES ($1,$2,$3,'native',$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (agent_key) DO UPDATE SET
         name=EXCLUDED.name, purpose=EXCLUDED.purpose, capabilities=EXCLUDED.capabilities,
         schedule_json=EXCLUDED.schedule_json, output_schema=EXCLUDED.output_schema,
         dependencies=EXCLUDED.dependencies, updated_at=$11`,
      [
        agent.key, agent.name, agent.purpose, 'claude-sonnet-4-6',
        JSON.stringify(agent.capabilities || []), JSON.stringify(agent.schedule || {}),
        JSON.stringify({ signal_types: agent.outputs || [] }), JSON.stringify(agent.dependencies || []),
        JSON.stringify({
          human_approval: ['outreach', 'budget_change', 'adaptation'],
          estimated_cost_per_run_usd: agent.key.includes('event') ? 0.12 : agent.key.includes('map') || agent.key.includes('queue') ? 0.10 : 0.05,
        }),
        JSON.stringify({}), nowText(),
      ]
    );
    await execute(
      `INSERT INTO agent_versions (agent_key, version, config_json, change_summary, created_by)
       VALUES ($1,1,$2,'Initial registry version','system')
       ON CONFLICT (agent_key, version) DO NOTHING`,
      [agent.key, JSON.stringify(agent)]
    );
  }
}

async function getPricing(provider, model) {
  return queryOne(
    `SELECT * FROM pricing_snapshots
     WHERE provider=$1 AND model=$2
     ORDER BY effective_at DESC, id DESC LIMIT 1`,
    [provider, model]
  );
}

function currentRun() {
  return runStorage.getStore() || null;
}

function recordProviderUsage(usage = {}) {
  const run = currentRun();
  if (!run) return;
  run.providerCalls += usage.calls || 1;
  run.inputTokens += Number(usage.inputTokens || 0);
  run.outputTokens += Number(usage.outputTokens || 0);
  run.exaSearches += Number(usage.exaSearches || 0);
  if (usage.sourceRef) run.sourceRefs.push(usage.sourceRef);
  if (usage.exactCostUsd != null) run.exactCostUsd += Number(usage.exactCostUsd || 0);
}

async function calculateCost(run, agent) {
  const model = run.model || agent?.model || 'claude-sonnet-4-6';
  const anthropicPricing = await getPricing('anthropic', model);
  const exaPricing = await getPricing('exa', 'search');
  const tokenCost = anthropicPricing
    ? (run.inputTokens / 1_000_000) * Number(anthropicPricing.input_cost_per_million || 0)
      + (run.outputTokens / 1_000_000) * Number(anthropicPricing.output_cost_per_million || 0)
    : 0;
  const exaUnit = Number(process.env.EXA_SEARCH_COST_USD || exaPricing?.unit_cost_usd || 0);
  return {
    estimated: tokenCost + run.exaSearches * exaUnit,
    snapshotId: anthropicPricing?.id || exaPricing?.id || null,
  };
}

async function monthlySpend() {
  const row = await queryOne(`
    SELECT COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) AS total
    FROM agent_runs
    WHERE status IN ('completed','failed','partial')
      AND created_at >= to_char(date_trunc('month', NOW() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')
  `);
  return Number(row?.total || 0);
}

async function checkBudget(agentKey, estimatedPreflight = 0, planBucket = 'api') {
  const settings = await queryOne(`SELECT * FROM control_tower_settings WHERE owner_id='local'`);
  const ceiling = Number(settings?.monthly_ceiling_usd || 0);
  const spent = await monthlySpend();
  if (ceiling > 0 && spent + estimatedPreflight > ceiling) {
    const error = new Error(`Monthly agent budget ceiling reached ($${spent.toFixed(2)} of $${ceiling.toFixed(2)}).`);
    error.code = 'BUDGET_CEILING';
    throw error;
  }
  if (planBucket === 'dust_programmatic' && settings?.dust_credits_remaining_usd != null
      && Number(settings.dust_credits_remaining_usd) <= 0) {
    const error = new Error('Dust programmatic credits are depleted. Regular Dust usage is unaffected.');
    error.code = 'DUST_CREDITS';
    throw error;
  }
  return { settings, spent, agentKey };
}

async function executeAgent(agentKey, options, work) {
  const opts = options || {};
  const agent = await queryOne('SELECT * FROM agent_registry WHERE agent_key=$1', [agentKey]);
  if (!agent) throw new Error(`Unknown agent: ${agentKey}`);
  if (agent.status !== 'active') throw new Error(`${agent.name} is ${agent.status}`);
  const constraints = typeof agent.plan_constraints === 'string'
    ? JSON.parse(agent.plan_constraints || '{}')
    : (agent.plan_constraints || {});
  const planBucket = opts.planBucket || (agent.provider === 'dust' ? 'dust_programmatic' : 'api');
  const preflight = Number(opts.estimatedPreflightUsd ?? constraints.estimated_cost_per_run_usd ?? 0.05);
  await checkBudget(agentKey, preflight, planBucket);

  const started = Date.now();
  const startedAt = nowText();
  const result = await execute(
    `INSERT INTO agent_runs
      (company_id, agent_type, agent_key, agent_version, parent_run_id, input_json, trigger_type,
       status, started_at, provider, model, plan_bucket, owner_id, source_refs)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11,'local',$12) RETURNING id`,
    [
      opts.companyId || null, agentKey, agentKey, agent.current_version || 1,
      currentRun()?.id || opts.parentRunId || null, JSON.stringify(safeJson(opts.input, {})),
      opts.trigger || 'manual', startedAt, agent.provider || 'native', agent.model || '',
      planBucket,
      JSON.stringify(safeJson(opts.sourceRefs, [])),
    ]
  );

  const context = {
    id: result.lastInsertRowid,
    agentKey,
    model: agent.model || '',
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    exaSearches: 0,
    exactCostUsd: 0,
    sourceRefs: [...(opts.sourceRefs || [])],
  };

  try {
    const output = await runStorage.run(context, () => work(context));
    const normalized = opts.normalize === false ? [] : normalizeSignals(agentKey, output, opts.input || {}, opts.companyId);
    const signalStats = await saveSignals(context.id, agentKey, normalized);
    const cost = await calculateCost(context, agent);
    const costBasis = context.exactCostUsd ? 'provider_reported' : agent.provider === 'dust' ? 'unavailable' : 'estimated';
    await execute(
      `UPDATE agent_runs SET
        output_text=$1, status='completed', completed_at=$2, duration_ms=$3,
        provider_usage=$4, input_tokens=$5, output_tokens=$6, provider_calls=$7,
        exact_cost_usd=$8, estimated_cost_usd=$9, cost_basis=$10, pricing_snapshot_id=$11,
        plan_units=$12, output_count=$13, duplicate_count=$14, actionable_count=$15, source_refs=$16
       WHERE id=$17`,
      [
        typeof output === 'string' ? output : JSON.stringify(output),
        nowText(), Date.now() - started,
        JSON.stringify({ anthropic_calls: context.providerCalls - context.exaSearches, exa_searches: context.exaSearches }),
        context.inputTokens, context.outputTokens, context.providerCalls,
        context.exactCostUsd || null, cost.estimated,
        costBasis,
        cost.snapshotId, context.providerCalls,
        signalStats.created, signalStats.duplicates, signalStats.actionable,
        JSON.stringify(context.sourceRefs), context.id,
      ]
    );
    return output;
  } catch (error) {
    const cost = await calculateCost(context, agent);
    const costBasis = context.exactCostUsd ? 'provider_reported' : agent.provider === 'dust' ? 'unavailable' : 'estimated';
    await execute(
      `UPDATE agent_runs SET status='failed', completed_at=$1, duration_ms=$2,
       provider_usage=$3, input_tokens=$4, output_tokens=$5, provider_calls=$6,
       exact_cost_usd=$7, estimated_cost_usd=$8, cost_basis=$9,
       pricing_snapshot_id=$10, error_text=$11, source_refs=$12 WHERE id=$13`,
      [
        nowText(), Date.now() - started,
        JSON.stringify({ anthropic_calls: context.providerCalls - context.exaSearches, exa_searches: context.exaSearches }),
        context.inputTokens, context.outputTokens, context.providerCalls,
        context.exactCostUsd || null, cost.estimated,
        costBasis,
        cost.snapshotId, error.message, JSON.stringify(context.sourceRefs), context.id,
      ]
    );
    throw error;
  }
}

async function saveSignals(runId, agentKey, signals) {
  let created = 0, duplicates = 0, actionable = 0;
  for (const signal of signals) {
    const fingerprint = crypto.createHash('sha256')
      .update([signal.signal_type, signal.entity_type, signal.entity_id, signal.title, signal.source_url].join('|').toLowerCase())
      .digest('hex');
    const existing = await queryOne('SELECT id FROM agent_signals WHERE fingerprint=$1', [fingerprint]);
    if (existing) {
      duplicates++;
      await execute('UPDATE agent_runs SET duplicate_count=COALESCE(duplicate_count,0)+1 WHERE id=$1', [runId]);
      continue;
    }
    await execute(
      `INSERT INTO agent_signals
       (run_id, agent_key, signal_type, entity_type, entity_id, company_id, title, summary,
        confidence, source_url, source_name, data_json, fingerprint, actionable, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        runId, agentKey, signal.signal_type, signal.entity_type, signal.entity_id,
        signal.company_id, signal.title, signal.summary, signal.confidence,
        signal.source_url, signal.source_name, JSON.stringify(signal.data_json || {}),
        fingerprint, signal.actionable || 0, signal.observed_at,
      ]
    );
    created++;
    if (signal.actionable) actionable++;
  }
  return { created, duplicates, actionable };
}

function trackedAnthropicClient() {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return {
    messages: {
      create: async params => {
        const response = await client.messages.create(params);
        recordProviderUsage({
          calls: 1,
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
        });
        return response;
      },
    },
  };
}

async function trackedExaSearch(body) {
  if (!process.env.EXA_API_KEY) return { results: [] };
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  recordProviderUsage({
    calls: 1,
    exaSearches: 1,
    sourceRef: { provider: 'exa', query: body.query, result_count: (data.results || []).length },
  });
  if (!response.ok) throw new Error(data.message || response.statusText);
  return data;
}

module.exports = {
  NATIVE_AGENTS,
  ensureAgentRegistry,
  executeAgent,
  currentRun,
  recordProviderUsage,
  trackedAnthropicClient,
  trackedExaSearch,
  checkBudget,
  normalizeSignals,
};
