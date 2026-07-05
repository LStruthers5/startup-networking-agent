// Load .env if present (no dotenv dependency needed)
try {
  require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8')
    .split('\n').forEach(line => {
      const m = line.match(/^\s*([^#\s=]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
} catch (_) {}

const express = require('express');
const path = require('path');
const { initSchema } = require('./db');

// Express 4 does not catch a rejected promise thrown from an async route handler — an unhandled
// rejection anywhere (a transient DB error on the remote Postgres proxy, a flaky external API call)
// would otherwise crash the whole server. Log it and keep the process alive instead.
process.on('unhandledRejection', (err) => {
  console.error('[Server] Unhandled rejection (continuing):', err?.message || err);
});

const app = express();
app.use(express.json());

// ─── Basic Auth ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // allow uptime checks and one-click approve/skip links from email (token is the auth)
  if (req.path === '/api/health') return next();
  if (req.path.startsWith('/api/drafts/approve/') || req.path.startsWith('/api/drafts/skip/') || req.path.startsWith('/api/drafts/cancel-auto-send/')) return next();

  const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
  if (!AUTH_PASSWORD) return next(); // no password set → open (dev mode)

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const pass = decoded.split(':').slice(1).join(':'); // handle colons in password
    if (pass === AUTH_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Networking Tower"');
  return res.status(401).send('Unauthorized');
});

app.use(express.static(path.join(__dirname, '..', 'client')));

// Routes
app.use('/api/companies', require('./routes/companies'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/actions', require('./routes/actions'));
app.use('/api/runs', require('./routes/runs'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/investors', require('./routes/investors'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/events', require('./routes/events'));
app.use('/api/drafts', require('./routes/drafts'));
app.use('/api/profile', require('./routes/profile'));
app.use('/api/control-tower', require('./routes/control-tower'));
app.use('/api/calendar', require('./routes/calendar'));
app.use('/api/gmail', require('./routes/gmail'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Email: list logs
app.get('/api/email/logs', async (req, res) => {
  const { query } = require('./db');
  const logs = await query('SELECT * FROM email_log ORDER BY created_at DESC LIMIT 50');
  res.json(logs);
});

// Email: trigger test sends manually
app.post('/api/email/test-daily', async (req, res) => {
  try { const r = await require('./scheduler').runDailyJob(); res.json({ ok: true, ...r }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/email/test-weekly', async (req, res) => {
  try { await require('./scheduler').runWeeklyJob(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// Connecting over a public Postgres proxy (rather than localhost or Railway's internal network) is
// noticeably flakier — a transient connection drop during boot shouldn't require a manual restart.
async function initSchemaWithRetry(retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await initSchema();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`[DB] Init attempt ${attempt}/${retries} failed (${err.message}) — retrying in ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

// Init DB then start server
initSchemaWithRetry()
  .then(() => require('./agent-control').ensureAgentRegistry())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Networking Tower v2 → http://localhost:${PORT}`);
      require('./scheduler').startScheduler();
    });
  })
  .catch(err => {
    console.error('[DB] Init failed:', err.message);
    process.exit(1);
  });
