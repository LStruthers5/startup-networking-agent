const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
`);

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
