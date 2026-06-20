const cron = require('node-cron');
const { query, queryOne, today, daysFromNow } = require('./db');
const { runAutonomousDraftGeneration, runWeeklyRecap, rankCompaniesByTaste, runEventDiscovery } = require('./agents');
const { sendMorningBriefing, sendWeeklyRecap: sendWeeklyEmail } = require('./email');

// Pick 2 companies that haven't been suggested recently
async function pickDailyCandidates(n = 2) {
  const shortlist = await query(`
    SELECT * FROM companies
    WHERE status != 'passed'
    ORDER BY
      (last_suggested IS NULL) DESC,
      last_suggested ASC NULLS LAST,
      score DESC NULLS LAST,
      last_touched ASC NULLS LAST
    LIMIT $1
  `, [Math.max(n * 6, 12)]);

  return rankCompaniesByTaste(shortlist, n);
}

async function getPendingDrafts(limit = 5) {
  return query(
    `SELECT d.*, c.name as company_name
     FROM drafts d
     LEFT JOIN companies c ON c.id = d.company_id
     WHERE d.status = 'pending'
     ORDER BY d.created_at ASC
     LIMIT $1`,
    [limit]
  );
}

async function getUpcomingEvents(limit = 4) {
  return query(
    `SELECT * FROM events
     WHERE dismissed = 0
       AND registered = 0
       AND event_date IS NOT NULL
       AND event_date >= $1
       AND event_date <= $2
     ORDER BY event_date ASC
     LIMIT $3`,
    [today(), daysFromNow(14), limit]
  );
}

async function getOverdueFollowUps() {
  return query(`
    SELECT a.*, c.name as company_name
    FROM actions a
    JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 0
      AND a.due_date IS NOT NULL
      AND a.due_date <= $1
      AND a.sequence_step > 1
    ORDER BY a.due_date ASC
    LIMIT 5
  `, [today()]);
}

async function getPipelineStats() {
  const totalRow = await queryOne('SELECT COUNT(*) as n FROM companies');
  const statusRows = await query('SELECT status, COUNT(*) as n FROM companies GROUP BY status');
  const byStatus = {};
  for (const r of statusRows) byStatus[r.status || 'new'] = parseInt(r.n);
  const topCompanies = await query(
    'SELECT name, sector, status, score FROM companies WHERE score IS NOT NULL ORDER BY score DESC LIMIT 5'
  );
  return { total: parseInt(totalRow.n), byStatus, topCompanies };
}

async function runDailyJob() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');

  const deskAgent = await queryOne(`SELECT schedule_json FROM agent_registry WHERE agent_key='autonomous-drafts'`);
  const schedule = typeof deskAgent?.schedule_json === 'string' ? JSON.parse(deskAgent.schedule_json || '{}') : (deskAgent?.schedule_json || {});
  const multiplier = Number(schedule.frequency_multiplier || 1);
  const candidateCount = Math.max(1, Math.min(5, Math.round(2 * multiplier)));
  const companies = await pickDailyCandidates(candidateCount);

  // Step 1: autonomously source targets → find emails → write drafts → save to DB
  let autoDrafts = [];
  if (companies.length) {
    console.log(`[Scheduler] Auto-drafting for: ${companies.map(c => c.name).join(', ')}`);
    autoDrafts = await runAutonomousDraftGeneration(companies);
    console.log(`[Scheduler] ${autoDrafts.length} draft(s) generated`);

    // Mark companies as last_suggested
    const { execute, nowText } = require('./db');
    const ts = nowText();
    for (const c of companies) {
      await execute('UPDATE companies SET last_suggested = $1 WHERE id = $2', [ts, c.id]);
    }
  }

  // Step 2: collect everything for the email (pending drafts now include today's auto-drafts)
  const [pendingDrafts, upcomingEvents, overdueActions] = await Promise.all([
    getPendingDrafts(5),
    getUpcomingEvents(4),
    getOverdueFollowUps(),
  ]);

  // Step 3: send morning briefing — approve-these section is the headline
  await sendMorningBriefing({
    pendingDrafts,
    upcomingEvents,
    overdueActions,
    pipelineText: '',
    companyIds: companies.map(c => c.id),
  });

  console.log(`[Scheduler] Morning briefing sent — ${autoDrafts.length} new drafts, ${pendingDrafts.length} total pending, ${upcomingEvents.length} events, ${overdueActions.length} overdue`);
  return { autoDrafts: autoDrafts.length, pendingDrafts: pendingDrafts.length, events: upcomingEvents.length };
}

async function runSignalMonitorJob() {
  const monitor = await queryOne(`SELECT schedule_json,status FROM agent_registry WHERE agent_key='event-discovery'`);
  if (monitor?.status !== 'active') return { events: 0, skipped: 'paused' };
  const schedule = typeof monitor?.schedule_json === 'string' ? JSON.parse(monitor.schedule_json || '{}') : (monitor?.schedule_json || {});
  const multiplier = Math.max(0.25, Number(schedule.frequency_multiplier || 1));
  const intervalHours = Math.max(2, 6 / multiplier);
  const lastRun = await queryOne(`
    SELECT completed_at FROM agent_runs
    WHERE agent_key='event-discovery' AND status='completed'
    ORDER BY completed_at DESC LIMIT 1
  `);
  if (lastRun?.completed_at) {
    const elapsedHours = (Date.now() - new Date(lastRun.completed_at.replace(' ', 'T') + 'Z').getTime()) / 3_600_000;
    if (elapsedHours < intervalHours) return { events: 0, skipped: 'not-due', next_in_hours: intervalHours - elapsedHours };
  }
  const trackedInvestors = await query('SELECT * FROM investors WHERE track_events=1 ORDER BY name');
  if (!trackedInvestors.length) return { events: 0 };
  const newEvents = await runEventDiscovery(trackedInvestors);
  console.log(`[Scheduler] Event monitor found ${newEvents.length} new signal(s)`);
  return { events: newEvents.length };
}

async function runWeeklyJob() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const stats = await getPipelineStats();
  const output = await runWeeklyRecap(stats);
  await sendWeeklyEmail(output);
  console.log('[Scheduler] Weekly recap sent.');
}

function startScheduler() {
  if (process.env.RESEND_API_KEY) {
    // Daily 8am PT: pick companies → source contacts → write drafts → send approval email.
    cron.schedule('0 8 * * *', () => runDailyJob().catch(e => console.error('[Scheduler] Daily error:', e.message)), { timezone: 'America/Los_Angeles' });
    cron.schedule('0 7 * * 1', () => runWeeklyJob().catch(e => console.error('[Scheduler] Weekly error:', e.message)), { timezone: 'America/Los_Angeles' });
  } else {
    console.log('[Scheduler] No RESEND_API_KEY — email jobs disabled; research monitors remain active.');
  }
  // Broad monitoring continues throughout the day; findings enter the river for human review.
  cron.schedule('*/15 * * * *', () => runSignalMonitorJob().catch(e => console.error('[Scheduler] Monitor error:', e.message)), { timezone: 'America/Los_Angeles' });

  console.log('[Scheduler] Started — daily 8am, weekly Monday 7am (PT)');
}

module.exports = { startScheduler, runDailyJob, runWeeklyJob, runSignalMonitorJob };
