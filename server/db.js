const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DATA_DIR env var lets Railway point to a persistent volume (e.g. /data)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'networking_v2.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sector TEXT,
    stage TEXT,
    description TEXT,
    website TEXT,
    founded_year TEXT,
    last_funding TEXT,
    funding_amount TEXT,
    location TEXT,
    source TEXT DEFAULT 'manual',
    date_added TEXT DEFAULT (date('now')),
    last_touched TEXT,
    notes TEXT DEFAULT '',
    score INTEGER,
    status TEXT DEFAULT 'new'
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id),
    agent_type TEXT NOT NULL,
    input_json TEXT,
    output_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES companies(id),
    suggested_action TEXT,
    due_date TEXT,
    completed INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    firm TEXT,
    role TEXT,
    sector_focus TEXT,
    stage_focus TEXT,
    how_i_know_them TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    firm TEXT,
    role TEXT,
    stage_focus TEXT,
    sector_focus TEXT,
    portfolio_companies TEXT DEFAULT '',
    how_i_know_them TEXT,
    relationship_status TEXT DEFAULT 'cold',
    last_touched TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS email_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_type TEXT NOT NULL,
    recipient TEXT,
    subject TEXT,
    status TEXT DEFAULT 'sent',
    resend_id TEXT,
    company_ids TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migrations — add columns if they don't exist
// Events table
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    event_url TEXT UNIQUE,
    luma_event_id TEXT,
    event_date TEXT,
    end_date TEXT,
    location TEXT,
    description TEXT,
    host_name TEXT,
    matched_investor_ids TEXT DEFAULT '',
    matched_investor_names TEXT DEFAULT '',
    source TEXT DEFAULT 'exa',
    dismissed INTEGER DEFAULT 0,
    registered INTEGER DEFAULT 0,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

const migrations = [
  `ALTER TABLE companies ADD COLUMN last_suggested TEXT`,
  `ALTER TABLE actions ADD COLUMN sequence_step INTEGER DEFAULT 1`,
  `ALTER TABLE actions ADD COLUMN contact_context TEXT DEFAULT ''`,
  `ALTER TABLE actions ADD COLUMN outreach_type TEXT DEFAULT 'investor'`,
  `ALTER TABLE companies ADD COLUMN investor_firms TEXT DEFAULT ''`,
  `ALTER TABLE investors ADD COLUMN track_events INTEGER DEFAULT 0`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// Seed default contacts if table is empty
const contactCount = db.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
if (contactCount === 0) {
  const seedContact = db.prepare(`
    INSERT INTO contacts (name, firm, how_i_know_them)
    VALUES (@name, @firm, @how_i_know_them)
  `);
  const seedMany = db.transaction((rows) => { for (const r of rows) seedContact.run(r); });
  seedMany([
    { name: '',              firm: 'Cyber Creation Ventures (CCVCAP)', how_i_know_them: 'working relationship' },
    { name: 'John Borchers', firm: 'Decathlon Capital Partners',       how_i_know_them: 'connection' },
    { name: 'Kent Goldman',  firm: 'Upside Partnership',               how_i_know_them: 'connection' },
    { name: 'Phil Sanderson', firm: 'Griffin',                         how_i_know_them: 'connection' },
    { name: 'Jacob Sills',   firm: 'Laurel',                          how_i_know_them: 'working relationship' },
  ]);
}

module.exports = db;
