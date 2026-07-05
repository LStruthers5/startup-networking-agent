const express = require('express');
const router = express.Router();
const { query, queryOne, execute, nowText } = require('../db');
const { executeAgent } = require('../agent-control');
const { extractDustPayload, extractDustText, dustPayloadToSignals } = require('../dust-response');
const {
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
  runOutcomeLearning,
  runAgentPortfolioManager,
  runIntelligenceCycle,
  runMasterOrchestrator,
} = require('../intelligence-agents');

const money = value => Number(value || 0);
const json = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
};

router.get('/summary', async (req, res) => {
  try {
    const [settings, today, month, trailing7, topAgents7d, sinceVisit, signalStats, failures, agents] = await Promise.all([
      queryOne(`SELECT * FROM control_tower_settings WHERE owner_id='local'`),
      queryOne(`
        SELECT COUNT(*) AS runs,
          COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) AS cost,
          COALESCE(SUM(input_tokens),0) AS input_tokens,
          COALESCE(SUM(output_tokens),0) AS output_tokens,
          COALESCE(SUM(actionable_count),0) AS actionable
        FROM agent_runs WHERE created_at >= to_char(CURRENT_DATE, 'YYYY-MM-DD')`),
      queryOne(`
        SELECT COUNT(*) AS runs,
          COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) AS cost
        FROM agent_runs
        WHERE created_at >= to_char(date_trunc('month', NOW() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')`),
      queryOne(`
        SELECT COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) AS cost,
          COUNT(DISTINCT to_char(created_at::timestamp, 'YYYY-MM-DD')) AS active_days
        FROM agent_runs
        WHERE created_at >= to_char(CURRENT_DATE - INTERVAL '6 days', 'YYYY-MM-DD')`),
      query(`
        SELECT agent_key, COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) AS cost, COUNT(*) AS runs
        FROM agent_runs
        WHERE created_at >= to_char(CURRENT_DATE - INTERVAL '6 days', 'YYYY-MM-DD')
        GROUP BY agent_key
        HAVING COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) > 0
        ORDER BY cost DESC LIMIT 4`),
      queryOne(`
        SELECT COUNT(*) AS runs,
          COALESCE(SUM(COALESCE(exact_cost_usd, estimated_cost_usd, 0)),0) AS cost
        FROM agent_runs
        WHERE created_at >= COALESCE($1, to_char(CURRENT_DATE, 'YYYY-MM-DD'))`,
        [req.query.since || null]),
      queryOne(`
        SELECT COUNT(*) FILTER (WHERE status='new') AS new_count,
          COUNT(*) FILTER (WHERE actionable=1 AND status='new') AS actionable,
          COUNT(*) FILTER (WHERE accepted=1) AS accepted,
          COUNT(*) FILTER (WHERE status='new' AND created_at < to_char(CURRENT_DATE - INTERVAL '7 days','YYYY-MM-DD')) AS stale
        FROM agent_signals
        WHERE agent_key!='evidence-auditor'
          AND LENGTH(TRIM(COALESCE(summary,'')))>=35
          AND COALESCE(summary,'')!='[object Object]'
          AND status NOT IN ('duplicate','rejected')`),
      queryOne(`SELECT COUNT(*) AS n FROM agent_runs WHERE status='failed' AND created_at >= to_char(CURRENT_DATE - INTERVAL '7 days','YYYY-MM-DD')`),
      query(`
        SELECT reg.agent_key, reg.name, reg.purpose, reg.provider, reg.status, reg.current_version,
          COUNT(ar.id) AS runs,
          COALESCE(SUM(CASE WHEN ar.status='completed' THEN 1 ELSE 0 END),0) AS successes,
          COALESCE(SUM(ar.output_count),0) AS outputs,
          COALESCE(SUM(ar.duplicate_count),0) AS duplicates,
          COALESCE(SUM(ar.actionable_count),0) AS actionable,
          COALESCE(SUM(ar.accepted_count),0) AS accepted,
          COALESCE(SUM(COALESCE(ar.exact_cost_usd, ar.estimated_cost_usd,0)),0) AS cost,
          MAX(ar.completed_at) AS last_run,
          (SELECT COUNT(*) FROM agent_signals s WHERE s.agent_key=reg.agent_key
            AND s.created_at >= to_char(CURRENT_DATE,'YYYY-MM-DD')) AS fresh_signals
        FROM agent_registry reg
        LEFT JOIN agent_runs ar ON reg.agent_key=ar.agent_key
          AND ar.created_at >= to_char(CURRENT_DATE - INTERVAL '30 days','YYYY-MM-DD')
        WHERE reg.display_in_roster=1 OR reg.provider='dust'
        GROUP BY reg.agent_key, reg.name, reg.purpose, reg.provider, reg.status, reg.current_version
        ORDER BY cost DESC, runs DESC`)
    ]);

    const dailyTarget = money(settings?.daily_target_usd);
    const ceiling = money(settings?.monthly_ceiling_usd);
    const monthCost = money(month?.cost);
    const daysInMonth = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).getUTCDate();
    // A trailing-7-day daily average is far less noisy than month-to-date ÷ day-of-month, which can
    // wildly overstate the forecast on the 1st-3rd of a month if even one day ran heavier than usual
    // (e.g. testing a batch of agents at once).
    const activeDays = Math.max(1, Number(trailing7?.active_days || 0));
    const avgDailyCost = money(trailing7?.cost) / activeDays;
    const forecast = avgDailyCost * daysInMonth;

    res.json({
      today: {
        runs: Number(today?.runs || 0),
        cost: money(today?.cost),
        input_tokens: Number(today?.input_tokens || 0),
        output_tokens: Number(today?.output_tokens || 0),
        actionable: Number(today?.actionable || 0),
      },
      since_visit: { runs: Number(sinceVisit?.runs || 0), cost: money(sinceVisit?.cost) },
      budget: {
        daily_target: dailyTarget,
        monthly_ceiling: ceiling,
        month_spend: monthCost,
        monthly_forecast: forecast,
        forecast_basis: `avg of $${avgDailyCost.toFixed(2)}/day over the last ${activeDays} active day${activeDays === 1 ? '' : 's'}`,
        avg_daily_cost: avgDailyCost,
        active_days: activeDays,
        top_cost_drivers: (topAgents7d || []).map(a => ({ agent_key: a.agent_key, cost: money(a.cost), runs: Number(a.runs) })),
        remaining: Math.max(0, ceiling - monthCost),
        utilization: ceiling ? monthCost / ceiling : 0,
        forecast_over_ceiling: ceiling > 0 && forecast > ceiling,
      },
      dust: {
        workspace_allowance: settings?.dust_workspace_allowance,
        trigger_allowance: settings?.dust_trigger_allowance,
        programmatic_credits: settings?.dust_programmatic_credits_usd,
        credits_remaining: settings?.dust_credits_remaining_usd,
      },
      signals: {
        new: Number(signalStats?.new_count || 0),
        actionable: Number(signalStats?.actionable || 0),
        accepted: Number(signalStats?.accepted || 0),
        stale: Number(signalStats?.stale || 0),
        duplicates: agents.reduce((sum, agent) => sum + Number(agent.duplicates || 0), 0),
      },
      failures_7d: Number(failures?.n || 0),
      agents: agents.map(a => ({
        ...a,
        runs: Number(a.runs || 0),
        successes: Number(a.successes || 0),
        outputs: Number(a.outputs || 0),
        duplicates: Number(a.duplicates || 0),
        actionable: Number(a.actionable || 0),
        accepted: Number(a.accepted || 0),
        fresh_signals: Number(a.fresh_signals || 0),
        cost: money(a.cost),
        success_rate: Number(a.runs) ? Number(a.successes) / Number(a.runs) : 0,
        duplicate_rate: Number(a.outputs) + Number(a.duplicates) ? Number(a.duplicates) / (Number(a.outputs) + Number(a.duplicates)) : 0,
        cost_per_actionable: Number(a.actionable) ? money(a.cost) / Number(a.actionable) : null,
        cost_per_accepted: Number(a.accepted) ? money(a.cost) / Number(a.accepted) : null,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/agents', async (req, res) => {
  const rows = await query(`
    SELECT r.*,
      (SELECT MAX(completed_at) FROM agent_runs ar WHERE ar.agent_key=r.agent_key) AS last_run,
      (SELECT COALESCE(SUM(COALESCE(exact_cost_usd,estimated_cost_usd,0)),0)
       FROM agent_runs ar WHERE ar.agent_key=r.agent_key
         AND ar.created_at >= to_char(CURRENT_DATE - INTERVAL '30 days','YYYY-MM-DD')) AS cost_30d
    FROM agent_registry r
    WHERE r.display_in_roster=1 OR r.provider='dust'
    ORDER BY provider, name`);
  res.json(rows);
});

router.patch('/agents/:agentKey', async (req, res) => {
  const allowed = ['status', 'schedule_json', 'plan_constraints', 'config_json'];
  const fields = Object.keys(req.body).filter(key => allowed.includes(key));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = fields.map((field, index) => `${field}=$${index + 1}`).join(', ');
  const values = fields.map(field => ['schedule_json', 'plan_constraints', 'config_json'].includes(field)
    ? JSON.stringify(req.body[field] || {})
    : req.body[field]);
  values.push(nowText(), req.params.agentKey);
  await execute(`UPDATE agent_registry SET ${sets}, updated_at=$${fields.length + 1} WHERE agent_key=$${fields.length + 2}`, values);
  res.json({ ok: true });
});

router.post('/agents/:agentKey/run', async (req, res) => {
  const runners = {
    'company-signal-monitor': () => runCompanySignalMonitor(Number(req.body.limit || 6)),
    'company-profile-curator': () => runCompanyProfileCurator(Number(req.body.limit || 4)),
    'company-discovery': () => runCompanyDiscovery(Number(req.body.limit || 6)),
    'evidence-auditor': () => runEvidenceAuditor(Number(req.body.limit || 30)),
    'opportunity-investigator': () => runOpportunityInvestigator(Number(req.body.company_id)),
    'relationship-pathfinder': () => runRelationshipPathfinder(Number(req.body.limit || 8)),
    'follow-up-strategist': () => runFollowUpStrategist(Number(req.body.limit || 12)),
    'lead-momentum-tracker': () => runLeadMomentumTracker(Number(req.body.limit || 20)),
    'investment-thesis-researcher': () => runInvestmentThesisResearcher(Number(req.body.limit || 4)),
    'sourcing-fit-scorer': () => runSourcingFitScorer(Number(req.body.company_id)),
    'calendar-cross-reference': () => runCalendarCrossReference(Number(req.body.days || 7)),
    'gmail-lead-scout': () => runGmailLeadScout(Number(req.body.days || 3), Number(req.body.limit || 40)),
    'outcome-learning': () => runOutcomeLearning(),
    'agent-portfolio-manager': () => runAgentPortfolioManager(),
    'intelligence-cycle': () => runIntelligenceCycle(),
    'agent-orchestrator': () => runMasterOrchestrator(),
  };
  const runner = runners[req.params.agentKey];
  if (!runner) return res.status(404).json({ error: 'Runnable intelligence agent not found' });
  if (['opportunity-investigator', 'sourcing-fit-scorer'].includes(req.params.agentKey) && !req.body.company_id) {
    return res.status(400).json({ error: 'company_id required' });
  }
  try {
    res.json({ output: await runner() });
  } catch (error) {
    res.status(error.code === 'BUDGET_CEILING' ? 402 : 500).json({ error: error.message });
  }
});

router.get('/river', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 80), 200);
  const rows = await query(`
    SELECT s.*, r.status AS run_status, r.trigger_type, r.estimated_cost_usd, r.exact_cost_usd,
      r.created_at AS run_created_at, reg.name AS agent_name, c.name AS company_name
    FROM agent_signals s
    LEFT JOIN agent_runs r ON r.id=s.run_id
    LEFT JOIN agent_registry reg ON reg.agent_key=s.agent_key
    LEFT JOIN companies c ON c.id=s.company_id
    WHERE s.agent_key!='evidence-auditor'
      AND LENGTH(TRIM(COALESCE(s.summary,''))) >= 35
      AND COALESCE(s.summary,'') != '[object Object]'
      AND s.status NOT IN ('duplicate','rejected')
    ORDER BY s.actionable DESC,s.created_at DESC LIMIT $1`, [limit]);
  res.json(rows);
});

router.patch('/signals/:id', async (req, res) => {
  const signal = await queryOne('SELECT * FROM agent_signals WHERE id=$1', [req.params.id]);
  if (!signal) return res.status(404).json({ error: 'Signal not found' });
  const status = req.body.status || signal.status;
  const accepted = req.body.accepted === undefined ? signal.accepted : (req.body.accepted ? 1 : 0);
  await execute('UPDATE agent_signals SET status=$1, accepted=$2 WHERE id=$3', [status, accepted, signal.id]);
  if (accepted && !signal.accepted && signal.run_id) {
    await execute('UPDATE agent_runs SET accepted_count=COALESCE(accepted_count,0)+1 WHERE id=$1', [signal.run_id]);
    await execute(
      `INSERT INTO agent_outcomes (run_id,signal_id,company_id,outcome_type,notes)
       VALUES ($1,$2,$3,'signal_accepted','Accepted from information river')`,
      [signal.run_id, signal.id, signal.company_id]
    );
  }
  if (accepted && signal.signal_type === 'company_candidate') {
    const data = json(signal.data_json, {});
    const candidate = data.data || data;
    const existing = await queryOne(
      `SELECT id FROM companies
       WHERE LOWER(name)=LOWER($1)
          OR ($2!='' AND LOWER(COALESCE(website,''))=LOWER($2))
       LIMIT 1`,
      [candidate.name || signal.title.replace(/^New company candidate:\s*/i, ''), candidate.website || '']
    );
    if (!existing) {
      const result = await execute(
        `INSERT INTO companies
         (name,sector,stage,description,website,location,source,status,score)
         VALUES ($1,$2,$3,$4,$5,$6,'agent-discovery','new',3) RETURNING id`,
        [
          candidate.name || signal.title.replace(/^New company candidate:\s*/i, ''),
          candidate.sector || '',
          candidate.stage || '',
          candidate.description || signal.summary || '',
          candidate.website || '',
          candidate.location || '',
        ]
      );
      await execute(
        `UPDATE agent_signals SET company_id=$1,entity_type='company',entity_id=$1 WHERE id=$2`,
        [result.lastInsertRowid, signal.id]
      );
    }
  }
  res.json({ ok: true });
});

function buildScenarios(agents, summary) {
  const scheduled = agents.filter(a => {
    const schedule = json(a.schedule_json, {});
    return schedule.cadence && schedule.cadence !== 'on-demand';
  });
  const profiles = {
    lean: {
      label: 'Lean', monitor_hours: 12, audit_hours: 12, candidate_limit: 1,
      dust_daily_limit: 1, dust_cooldown_days: 14, relationship_limit: 4,
      follow_up_limit: 6, learning_days: 14, yield_multiplier: 0.72,
    },
    current: {
      label: 'Current', monitor_hours: 6, audit_hours: 6, candidate_limit: 2,
      dust_daily_limit: 3, dust_cooldown_days: 7, relationship_limit: 8,
      follow_up_limit: 12, learning_days: 7, yield_multiplier: 1,
    },
    aggressive: {
      label: 'Aggressive', monitor_hours: 3, audit_hours: 3, candidate_limit: 4,
      dust_daily_limit: 5, dust_cooldown_days: 3, relationship_limit: 12,
      follow_up_limit: 20, learning_days: 7, yield_multiplier: 1.65,
    },
  };
  const runRate = (agentKey, profile, scenarioKey) => {
    if (['event-discovery', 'company-signal-monitor'].includes(agentKey)) return 24 / profile.monitor_hours;
    if (agentKey === 'evidence-auditor') return 24 / profile.audit_hours;
    if (agentKey === 'company-profile-curator') return scenarioKey === 'lean' ? 0.5 : scenarioKey === 'aggressive' ? 2 : 1;
    if (agentKey === 'company-discovery') return scenarioKey === 'lean' ? 0.5 : scenarioKey === 'aggressive' ? 2 : 1;
    if (agentKey === 'opportunity-investigator') return profile.dust_daily_limit;
    if (['daily-candidate-ranking', 'autonomous-drafts', 'relationship-pathfinder', 'follow-up-strategist'].includes(agentKey)) return 1;
    if (['outcome-learning', 'agent-portfolio-manager', 'weekly-recap'].includes(agentKey)) return 1 / profile.learning_days;
    return 0;
  };
  const proposedSchedule = (agent, profile, key) => {
    const current = json(agent.schedule_json, {});
    const next = { ...current, scenario: key };
    if (['event-discovery', 'company-signal-monitor'].includes(agent.agent_key)) next.interval_hours = profile.monitor_hours;
    if (agent.agent_key === 'evidence-auditor') next.interval_hours = profile.audit_hours;
    if (agent.agent_key === 'company-profile-curator') {
      next.interval_hours = key === 'lean' ? 48 : key === 'aggressive' ? 12 : 24;
      next.batch_limit = key === 'lean' ? 2 : key === 'aggressive' ? 8 : 4;
    }
    if (agent.agent_key === 'company-discovery') {
      next.interval_hours = key === 'lean' ? 12 : key === 'aggressive' ? 1 : 3;
      next.batch_limit = key === 'lean' ? 4 : key === 'aggressive' ? 8 : 6;
    }
    if (['daily-candidate-ranking', 'autonomous-drafts'].includes(agent.agent_key)) next.candidate_limit = profile.candidate_limit;
    if (agent.agent_key === 'opportunity-investigator') {
      next.daily_limit = profile.dust_daily_limit;
      next.cooldown_days = profile.dust_cooldown_days;
      next.min_signal_count = key === 'aggressive' ? 1 : 2;
    }
    if (agent.agent_key === 'relationship-pathfinder') next.batch_limit = profile.relationship_limit;
    if (agent.agent_key === 'follow-up-strategist') next.batch_limit = profile.follow_up_limit;
    if (['outcome-learning', 'agent-portfolio-manager'].includes(agent.agent_key)) next.interval_days = profile.learning_days;
    return next;
  };
  const describe = (agentKey, schedule) => {
    if (['event-discovery', 'company-signal-monitor', 'evidence-auditor'].includes(agentKey)) return `every ${schedule.interval_hours || 6} hours`;
    if (agentKey === 'company-profile-curator') return `${schedule.batch_limit || 4} profiles every ${schedule.interval_hours || 24} hours`;
    if (agentKey === 'company-discovery') return `up to ${schedule.batch_limit || 6} new candidates every ${schedule.interval_hours || 3} hours`;
    if (['daily-candidate-ranking', 'autonomous-drafts'].includes(agentKey)) return `${schedule.candidate_limit || 2} companies each morning`;
    if (agentKey === 'opportunity-investigator') return `up to ${schedule.daily_limit || 3} Dust investigations/day · ${schedule.cooldown_days || 7}d cooldown`;
    if (agentKey === 'relationship-pathfinder') return `${schedule.batch_limit || 8} relationship paths/day`;
    if (agentKey === 'follow-up-strategist') return `${schedule.batch_limit || 12} follow-ups/day`;
    if (['outcome-learning', 'agent-portfolio-manager'].includes(agentKey)) return `every ${schedule.interval_days || 7} days`;
    return schedule.cadence || 'scheduled';
  };
  const make = (key) => {
    const profile = profiles[key];
    const configuredDaily = scheduled.reduce((sum, agent) => {
      const constraints = json(agent.plan_constraints, {});
      const unitCost = money(constraints.estimated_cost_per_run_usd || 0.05);
      return sum + unitCost * runRate(agent.agent_key, profile, key);
    }, 0);
    const observedDaily = scheduled.reduce((sum, agent) => sum + money(agent.cost_30d) / 30, 0);
    const baselineDaily = key === 'current' && observedDaily > 0 ? observedDaily : configuredDaily;
    const daily = Math.max(0.05, baselineDaily);
    const month = daily * 30.4;
    const baselineYield = summary.today?.cost > 0
      ? Number(summary.today.actionable || 0) / money(summary.today.cost)
      : 1.5;
    return {
      key, label: profile.label,
      projected_daily_cost: daily,
      projected_monthly_cost: month,
      projected_actionable_per_week: Math.max(0, daily * baselineYield * 7 * profile.yield_multiplier),
      projected_freshness_hours: profile.monitor_hours,
      projected_dust_runs_per_day: profile.dust_daily_limit,
      coverage: `${profile.candidate_limit} ranked companies/day · ${profile.relationship_limit} relationship paths/day`,
      within_monthly_ceiling: !summary.budget.monthly_ceiling || month <= summary.budget.monthly_ceiling,
      plan_risk: month > summary.budget.monthly_ceiling ? 'ceiling' : key === 'aggressive' ? 'rate-limit-headroom' : 'low',
      changes: scheduled.map(agent => {
        const current = json(agent.schedule_json, {});
        const proposed = proposedSchedule(agent, profile, key);
        return {
          agent_key: agent.agent_key,
          current: describe(agent.agent_key, current),
          proposed: describe(agent.agent_key, proposed),
          proposed_schedule: proposed,
        };
      }),
    };
  };
  return [make('lean'), make('current'), make('aggressive')];
}

async function loadScenarios() {
  const [agents, settings, day, month] = await Promise.all([
    query(`SELECT r.*,
      (SELECT COALESCE(SUM(COALESCE(exact_cost_usd,estimated_cost_usd,0)),0)
       FROM agent_runs ar WHERE ar.agent_key=r.agent_key
         AND ar.created_at >= to_char(CURRENT_DATE - INTERVAL '30 days','YYYY-MM-DD')) AS cost_30d
      FROM agent_registry r WHERE r.status='active'`),
    queryOne(`SELECT * FROM control_tower_settings WHERE owner_id='local'`),
    queryOne(`SELECT COALESCE(SUM(COALESCE(exact_cost_usd,estimated_cost_usd,0)),0) AS cost, COALESCE(SUM(actionable_count),0) AS actionable FROM agent_runs WHERE created_at >= to_char(CURRENT_DATE,'YYYY-MM-DD')`),
    queryOne(`SELECT COALESCE(SUM(COALESCE(exact_cost_usd,estimated_cost_usd,0)),0) AS cost FROM agent_runs WHERE created_at >= to_char(date_trunc('month',NOW() AT TIME ZONE 'UTC'),'YYYY-MM-DD HH24:MI:SS')`),
  ]);
  const summary = {
    today: { cost: money(day?.cost), actionable: Number(day?.actionable || 0) },
    budget: { monthly_ceiling: money(settings?.monthly_ceiling_usd), month_spend: money(month?.cost) },
  };
  return buildScenarios(agents, summary);
}

router.get('/scenarios', async (req, res) => {
  res.json(await loadScenarios());
});

router.post('/scenarios/:key/preview', async (req, res) => {
  const scenarios = await loadScenarios();
  const scenario = scenarios.find(s => s.key === req.params.key);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  res.json({ ...scenario, requires_approval: scenario.key !== 'current' });
});

router.post('/scenarios/:key/apply', async (req, res) => {
  if (!req.body.confirm) return res.status(400).json({ error: 'Explicit confirmation required' });
  const scenario = (await loadScenarios()).find(item => item.key === req.params.key);
  if (!scenario) return res.status(404).json({ error: 'Scenario not found' });
  if (!scenario.within_monthly_ceiling) {
    return res.status(402).json({ error: 'This scenario exceeds the hard monthly ceiling. Raise the ceiling explicitly before applying it.' });
  }
  for (const change of scenario.changes) {
    await execute(
      'UPDATE agent_registry SET schedule_json=$1, updated_at=$2 WHERE agent_key=$3',
      [JSON.stringify(change.proposed_schedule || {}), nowText(), change.agent_key]
    );
  }
  res.json({ ok: true, scenario: req.params.key });
});

router.get('/settings', async (req, res) => {
  res.json(await queryOne(`SELECT * FROM control_tower_settings WHERE owner_id='local'`));
});

router.patch('/settings', async (req, res) => {
  const allowed = ['daily_target_usd', 'monthly_ceiling_usd', 'dust_workspace_allowance', 'dust_trigger_allowance', 'dust_programmatic_credits_usd', 'dust_credits_remaining_usd', 'timezone'];
  const fields = Object.keys(req.body).filter(key => allowed.includes(key));
  if (!fields.length) return res.status(400).json({ error: 'No valid settings' });
  const sets = fields.map((field, index) => `${field}=$${index + 1}`).join(', ');
  await execute(
    `UPDATE control_tower_settings SET ${sets}, updated_at=$${fields.length + 1} WHERE owner_id='local'`,
    [...fields.map(field => req.body[field]), nowText()]
  );
  res.json({ ok: true });
});

router.get('/proposals', async (req, res) => {
  res.json(await query('SELECT * FROM adaptation_proposals ORDER BY created_at DESC'));
});

router.post('/proposals', async (req, res) => {
  const { agent_key, proposal_type, proposed_config, diff_json, evidence_json, estimated_daily_cost_delta, expected_impact, trial_days, success_metric } = req.body;
  const agent = await queryOne('SELECT * FROM agent_registry WHERE agent_key=$1', [agent_key]);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const result = await execute(
    `INSERT INTO adaptation_proposals
     (agent_key,proposal_type,current_version,proposed_config,diff_json,evidence_json,
      estimated_daily_cost_delta,expected_impact,trial_days,success_metric)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      agent_key, proposal_type, agent.current_version,
      JSON.stringify(proposed_config || {}), JSON.stringify(diff_json || {}),
      JSON.stringify(evidence_json || []), estimated_daily_cost_delta || 0,
      expected_impact || '', trial_days || 7, success_metric || 'accepted actionable opportunities',
    ]
  );
  res.json({ id: result.lastInsertRowid });
});

router.post('/proposals/:id/apply', async (req, res) => {
  if (!req.body.confirm) return res.status(400).json({ error: 'Explicit confirmation required' });
  const proposal = await queryOne('SELECT * FROM adaptation_proposals WHERE id=$1', [req.params.id]);
  if (!proposal || proposal.status !== 'pending') return res.status(404).json({ error: 'Pending proposal not found' });
  const agent = await queryOne('SELECT * FROM agent_registry WHERE agent_key=$1', [proposal.agent_key]);
  const nextVersion = Number(agent.current_version || 1) + 1;
  await execute(
    `INSERT INTO agent_versions (agent_key,version,config_json,change_summary,created_by)
     VALUES ($1,$2,$3,$4,'user-approved')`,
    [proposal.agent_key, nextVersion, JSON.stringify(json(proposal.proposed_config, {})), `Applied proposal ${proposal.id}`]
  );
  const proposed = json(proposal.proposed_config, {});
  if (proposal.proposal_type === 'portfolio-allocation' && proposed.schedule_json) {
    await execute(
      'UPDATE agent_registry SET schedule_json=$1,current_version=$2,updated_at=$3 WHERE agent_key=$4',
      [JSON.stringify(proposed.schedule_json), nextVersion, nowText(), proposal.agent_key]
    );
  } else {
    await execute(
      'UPDATE agent_registry SET config_json=$1,current_version=$2,updated_at=$3 WHERE agent_key=$4',
      [JSON.stringify(proposed), nextVersion, nowText(), proposal.agent_key]
    );
  }
  await execute(
    `UPDATE adaptation_proposals SET status='applied',applied_version=$1,decided_at=$2 WHERE id=$3`,
    [nextVersion, nowText(), proposal.id]
  );
  res.json({ ok: true, version: nextVersion });
});

router.post('/proposals/:id/reject', async (req, res) => {
  await execute(`UPDATE adaptation_proposals SET status='rejected',decided_at=$1 WHERE id=$2 AND status='pending'`, [nowText(), req.params.id]);
  res.json({ ok: true });
});

router.post('/agents/:agentKey/rollback', async (req, res) => {
  const target = await queryOne(
    `SELECT * FROM agent_versions WHERE agent_key=$1 AND version=$2`,
    [req.params.agentKey, req.body.version]
  );
  if (!target) return res.status(404).json({ error: 'Version not found' });
  const targetConfig = json(target.config_json, {});
  const targetSchedule = targetConfig.schedule_json || targetConfig.schedule;
  if (targetSchedule) {
    await execute(
      'UPDATE agent_registry SET config_json=$1,schedule_json=$2,current_version=$3,updated_at=$4 WHERE agent_key=$5',
      [
        JSON.stringify(targetConfig.config_json || targetConfig),
        JSON.stringify(targetSchedule),
        target.version,
        nowText(),
        req.params.agentKey,
      ]
    );
  } else {
    await execute(
      'UPDATE agent_registry SET config_json=$1,current_version=$2,updated_at=$3 WHERE agent_key=$4',
      [JSON.stringify(targetConfig), target.version, nowText(), req.params.agentKey]
    );
  }
  res.json({ ok: true, version: target.version });
});

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
  return body;
}

router.post('/dust/sync', async (req, res) => {
  try {
    const workspace = process.env.DUST_WORKSPACE_ID;
    const data = await dustRequest(`/api/v1/w/${workspace}/assistant/agent_configurations?view=list`);
    const agents = data.agentConfigurations || data.agent_configurations || data.agents || data || [];
    const imported = [];
    for (const item of Array.isArray(agents) ? agents : []) {
      const id = item.sId || item.id;
      const key = `dust:${id}`;
      await execute(
        `INSERT INTO agent_registry
         (agent_key,name,purpose,provider,model,capabilities,schedule_json,plan_constraints,display_in_roster,config_json)
         VALUES ($1,$2,$3,'dust',$4,$5,'{}',$6,1,$7)
         ON CONFLICT (agent_key) DO UPDATE SET name=EXCLUDED.name,purpose=EXCLUDED.purpose,
          model=EXCLUDED.model,config_json=EXCLUDED.config_json,updated_at=$8`,
        [
          key, item.name || key, item.description || '',
          item.model?.modelId || item.model?.model_id || '',
          JSON.stringify(['dust-agent', 'programmatic']),
          JSON.stringify({ billing_bucket: 'dust_programmatic', workspace_allowance_separate: true }),
          JSON.stringify({ dust_agent_id: id, raw: item }), nowText(),
        ]
      );
      imported.push({ agent_key: key, name: item.name || key });
    }
    res.json({ imported });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

// API keys can invoke a known Dust agent, but Dust requires OAuth to list agents.
// This endpoint lets API-key users register a Company/Shared agent by configuration ID.
router.post('/dust/register', async (req, res) => {
  const { configuration_id, name, description } = req.body;
  const id = String(configuration_id || '').trim();
  if (!id) return res.status(400).json({ error: 'Dust agent configuration ID required' });
  const key = `dust:${id}`;
  try {
    await execute(
      `INSERT INTO agent_registry
       (agent_key,name,purpose,provider,model,capabilities,schedule_json,plan_constraints,display_in_roster,config_json)
       VALUES ($1,$2,$3,'dust','',$4,'{}',$5,1,$6)
       ON CONFLICT (agent_key) DO UPDATE SET
        name=EXCLUDED.name,purpose=EXCLUDED.purpose,display_in_roster=1,
        config_json=EXCLUDED.config_json,updated_at=$7`,
      [
        key,
        String(name || '').trim() || `Dust Agent ${id}`,
        String(description || '').trim() || 'Dust Company/Shared agent registered by configuration ID.',
        JSON.stringify(['dust-agent', 'programmatic']),
        JSON.stringify({ billing_bucket: 'dust_programmatic', workspace_allowance_separate: true }),
        JSON.stringify({ dust_agent_id: id, registration: 'manual-api-key' }),
        nowText(),
      ]
    );
    res.json({ agent_key: key, name: String(name || '').trim() || `Dust Agent ${id}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/dust/:agentKey/run', async (req, res) => {
  const agentKey = decodeURIComponent(req.params.agentKey);
  const agent = await queryOne('SELECT * FROM agent_registry WHERE agent_key=$1 AND provider=\'dust\'', [agentKey]);
  if (!agent) return res.status(404).json({ error: 'Dust agent not found' });
  try {
    const output = await executeAgent(agentKey, {
      trigger: req.body.trigger || 'manual',
      input: { message: req.body.message },
      planBucket: 'dust_programmatic',
    }, async () => {
      const config = json(agent.config_json, {});
      const dustAgentId = config.dust_agent_id || agentKey.replace(/^dust:/, '');
      const workspace = process.env.DUST_WORKSPACE_ID;
      const response = await dustRequest(`/api/v1/w/${workspace}/assistant/conversations`, {
        method: 'POST',
        body: JSON.stringify({
          message: {
            context: { timezone: req.body.timezone || 'America/Los_Angeles', username: 'local-user' },
            content: req.body.message,
            mentions: [{ configurationId: dustAgentId }],
          },
          blocking: true,
        }),
      });
      const payload = extractDustPayload(response);
      if (payload) {
        return dustPayloadToSignals(payload, {
          id: req.body.company_id || null,
          name: req.body.company_name || agent.name || 'Dust investigation',
        });
      }
      return extractDustText(response) || 'Dust completed the run without a readable text response.';
    });
    res.json({ output });
  } catch (error) {
    res.status(error.code === 'BUDGET_CEILING' ? 402 : 502).json({ error: error.message });
  }
});

module.exports = router;
