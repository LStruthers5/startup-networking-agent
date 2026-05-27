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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

// Init DB (creates tables on first run)
require('./db');

// Routes
app.use('/api/companies', require('./routes/companies'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/actions', require('./routes/actions'));
app.use('/api/runs', require('./routes/runs'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/investors', require('./routes/investors'));
app.use('/api/queue', require('./routes/queue'));
app.use('/api/events', require('./routes/events'));

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Email: list logs
app.get('/api/email/logs', (req, res) => {
  const db = require('./db');
  const logs = db.prepare('SELECT * FROM email_log ORDER BY created_at DESC LIMIT 50').all();
  res.json(logs);
});

// Email: trigger test sends manually
app.post('/api/email/test-daily', async (req, res) => {
  const { runDailyJob } = require('./scheduler');
  try { await runDailyJob(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/email/test-weekly', async (req, res) => {
  const { runWeeklyJob } = require('./scheduler');
  try { await runWeeklyJob(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Networking Tower v2 → http://localhost:${PORT}`);
  require('./scheduler').startScheduler();
});
