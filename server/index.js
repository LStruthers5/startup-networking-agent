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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'client', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Networking Tower v2 → http://localhost:${PORT}`));
