const cron = require('node-cron');
const { query, queryOne, today, daysFromNow } = require('./db');
const { runAutonomousDraftGeneration, runWeeklyRecap } = require('./agents');
const { sendMorningBriefing, sendWeeklyRecap: sendWeeklyEmail } = require('./email');

// Pick 2 companies that haven't been suggested recently
async function pickDailyCandidates(n = 2) {
  return query(`
    SELECT * FROM companies
    WHERE status != 'passed'
    ORDER BY
      (last_suggested IS NULL) DESC,
      last_suggested ASC NULLS LAST,
      score DESC NULLS LAST,
      last_touched ASC NULLS LAST
    LIMIT $1
  `, [n]);
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

  const companies = await pickDailyCandidates(2);

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

async function runWeeklyJob() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const stats = await getPipelineStats();
  const output = await runWeeklyRecap(stats);
  await sendWeeklyEmail(output);
  console.log('[Scheduler] Weekly recap sent.');
}

function startScheduler() {
  if (!process.env.RESEND_API_KEY) {
    console.log('[Scheduler] No RESEND_API_KEY — scheduler disabled.');
    return;
  }

  // Daily 8am PT: pick 2 companies → source contacts → write drafts → send approval email
  cron.schedule('0 8 * * *', () => runDailyJob().catch(e => console.error('[Scheduler] Daily error:', e.message)), { timezone: 'America/Los_Angeles' });
  // Weekly Monday 7am PT: pipeline recap
  cron.schedule('0 7 * * 1', () => runWeeklyJob().catch(e => console.error('[Scheduler] Weekly error:', e.message)), { timezone: 'America/Los_Angeles' });

  console.log('[Scheduler] Started — daily 8am, weekly Monday 7am (PT)');
}

module.exports = { startScheduler, runDailyJob, runWeeklyJob };
