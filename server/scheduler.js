const cron = require('node-cron');
const { runDailyOutreachSuggestions, runWeeklyRecap } = require('./agents');
const { sendDailyOutreach, sendWeeklyRecap } = require('./email');

// Pick N companies for daily outreach — prefer:
//   1. Never suggested, or suggested longest ago
//   2. Status not 'passed'
//   3. Highest score
function pickDailyCandidates(db, n = 3) {
  return db.prepare(`
    SELECT * FROM companies
    WHERE status != 'passed'
    ORDER BY
      last_suggested IS NULL DESC,
      last_suggested ASC,
      score DESC,
      last_touched ASC
    LIMIT ?
  `).all(n);
}

function getPipelineStats(db) {
  const total = db.prepare('SELECT COUNT(*) as n FROM companies').get().n;

  const statusRows = db.prepare(
    `SELECT status, COUNT(*) as n FROM companies GROUP BY status`
  ).all();
  const byStatus = {};
  for (const r of statusRows) byStatus[r.status || 'new'] = r.n;

  const recentActions = db.prepare(`
    SELECT a.suggested_action, c.name as company_name
    FROM actions a
    LEFT JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 0
    ORDER BY a.created_at DESC
    LIMIT 5
  `).all();

  const topCompanies = db.prepare(`
    SELECT name, sector, status, score FROM companies
    WHERE score IS NOT NULL
    ORDER BY score DESC
    LIMIT 5
  `).all();

  return { total, byStatus, recentActions, topCompanies };
}

function getOverdueFollowUps(db) {
  return db.prepare(`
    SELECT a.*, c.name as company_name
    FROM actions a
    JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 0
      AND a.due_date IS NOT NULL
      AND a.due_date <= date('now')
      AND a.sequence_step > 1
    ORDER BY a.due_date ASC
    LIMIT 5
  `).all();
}

async function runDailyJob() {
  const db = require('./db');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const companies = pickDailyCandidates(db, 3);
  if (!companies.length) throw new Error('No companies to suggest — add some companies first');
  const overdueFollowUps = getOverdueFollowUps(db);
  const output = await runDailyOutreachSuggestions(companies, overdueFollowUps);
  await sendDailyOutreach(output, companies.map(c => c.id));
  console.log(`[Scheduler] Daily outreach sent — ${companies.length} companies, ${overdueFollowUps.length} overdue follow-ups`);
  return companies.length;
}

async function runWeeklyJob() {
  const db = require('./db');
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const stats = getPipelineStats(db);
  const output = await runWeeklyRecap(stats);
  await sendWeeklyRecap(output);
  console.log('[Scheduler] Weekly recap sent.');
}

function startScheduler() {
  if (!process.env.RESEND_API_KEY) {
    console.log('[Scheduler] No RESEND_API_KEY — scheduler disabled. Add key to enable email automation.');
    return;
  }

  // Daily at 8:00 AM server time
  cron.schedule('0 8 * * *', () => runDailyJob().catch(e => console.error('[Scheduler] Daily job error:', e.message)), { timezone: 'America/Los_Angeles' });

  // Weekly Monday at 7:00 AM
  cron.schedule('0 7 * * 1', () => runWeeklyJob().catch(e => console.error('[Scheduler] Weekly job error:', e.message)), { timezone: 'America/Los_Angeles' });

  console.log('[Scheduler] Email scheduler started — daily 8am, weekly Monday 7am (PT)');
}

module.exports = { startScheduler, runDailyJob, runWeeklyJob };
