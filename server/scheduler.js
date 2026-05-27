const cron = require('node-cron');
const { query, queryOne, today } = require('./db');
const { runDailyOutreachSuggestions, runWeeklyRecap } = require('./agents');
const { sendDailyOutreach, sendWeeklyRecap } = require('./email');

async function pickDailyCandidates(n = 3) {
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

async function getPipelineStats() {
  const totalRow = await queryOne('SELECT COUNT(*) as n FROM companies');
  const statusRows = await query('SELECT status, COUNT(*) as n FROM companies GROUP BY status');
  const byStatus = {};
  for (const r of statusRows) byStatus[r.status || 'new'] = parseInt(r.n);

  const recentActions = await query(`
    SELECT a.suggested_action, c.name as company_name
    FROM actions a
    LEFT JOIN companies c ON c.id = a.company_id
    WHERE a.completed = 0
    ORDER BY a.created_at DESC
    LIMIT 5
  `);

  const topCompanies = await query(`
    SELECT name, sector, status, score FROM companies
    WHERE score IS NOT NULL
    ORDER BY score DESC
    LIMIT 5
  `);

  return { total: parseInt(totalRow.n), byStatus, recentActions, topCompanies };
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

async function runDailyJob() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const companies = await pickDailyCandidates(3);
  if (!companies.length) throw new Error('No companies to suggest — add some companies first');
  const overdueFollowUps = await getOverdueFollowUps();
  const output = await runDailyOutreachSuggestions(companies, overdueFollowUps);
  await sendDailyOutreach(output, companies.map(c => c.id));
  console.log(`[Scheduler] Daily outreach sent — ${companies.length} companies, ${overdueFollowUps.length} overdue follow-ups`);
  return companies.length;
}

async function runWeeklyJob() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const stats = await getPipelineStats();
  const output = await runWeeklyRecap(stats);
  await sendWeeklyRecap(output);
  console.log('[Scheduler] Weekly recap sent.');
}

function startScheduler() {
  if (!process.env.RESEND_API_KEY) {
    console.log('[Scheduler] No RESEND_API_KEY — scheduler disabled. Add key to enable email automation.');
    return;
  }

  cron.schedule('0 8 * * *', () => runDailyJob().catch(e => console.error('[Scheduler] Daily job error:', e.message)), { timezone: 'America/Los_Angeles' });
  cron.schedule('0 7 * * 1', () => runWeeklyJob().catch(e => console.error('[Scheduler] Weekly job error:', e.message)), { timezone: 'America/Los_Angeles' });

  console.log('[Scheduler] Email scheduler started — daily 8am, weekly Monday 7am (PT)');
}

module.exports = { startScheduler, runDailyJob, runWeeklyJob };
