const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

// ─── Date helpers ─────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function nowText() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
function daysFromNow(n) {
  const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10);
}
function daysAgo(n) {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10);
}

// ─── Query helpers ────────────────────────────────────────────────────────────
// Returns array of rows
async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

// Returns first row or null
async function queryOne(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

// Returns { lastInsertRowid, rowCount } — use RETURNING id on INSERTs
async function execute(sql, params = []) {
  const result = await pool.query(sql, params);
  return {
    lastInsertRowid: result.rows[0]?.id || null,
    rowCount: result.rowCount,
  };
}

// ─── Schema init ──────────────────────────────────────────────────────────────
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
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
      date_added TEXT DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      last_touched TEXT,
      notes TEXT DEFAULT '',
      score INTEGER,
      status TEXT DEFAULT 'new',
      last_suggested TEXT,
      investor_firms TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      agent_type TEXT NOT NULL,
      input_json TEXT,
      output_text TEXT,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS actions (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      suggested_action TEXT,
      due_date TEXT,
      completed INTEGER DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      sequence_step INTEGER DEFAULT 1,
      contact_context TEXT DEFAULT '',
      outreach_type TEXT DEFAULT 'investor'
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      name TEXT,
      firm TEXT,
      role TEXT,
      sector_focus TEXT,
      stage_focus TEXT,
      how_i_know_them TEXT,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS investors (
      id SERIAL PRIMARY KEY,
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
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      track_events INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id SERIAL PRIMARY KEY,
      email_type TEXT NOT NULL,
      recipient TEXT,
      subject TEXT,
      status TEXT DEFAULT 'sent',
      resend_id TEXT,
      company_ids TEXT DEFAULT '',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
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
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id SERIAL PRIMARY KEY,
      company_id INTEGER REFERENCES companies(id),
      investor_name TEXT,
      investor_email TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      approve_token TEXT UNIQUE,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Seed default contacts if table is empty
  const countRow = await queryOne('SELECT COUNT(*) as n FROM contacts');
  if (parseInt(countRow.n) === 0) {
    await pool.query(`
      INSERT INTO contacts (name, firm, how_i_know_them) VALUES
        ($1, $2, $3), ($4, $5, $6), ($7, $8, $9), ($10, $11, $12), ($13, $14, $15)
    `, [
      '', 'Cyber Creation Ventures (CCVCAP)', 'working relationship',
      'John Borchers', 'Decathlon Capital Partners', 'connection',
      'Kent Goldman', 'Upside Partnership', 'connection',
      'Phil Sanderson', 'Griffin', 'connection',
      'Jacob Sills', 'Laurel', 'working relationship',
    ]);
  }

  // Idempotent migrations — add new columns to existing tables
  await pool.query(`
    ALTER TABLE investors ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
    ALTER TABLE investors ADD COLUMN IF NOT EXISTS confirmed INTEGER DEFAULT 1;
    ALTER TABLE investors ADD COLUMN IF NOT EXISTS tier INTEGER DEFAULT 5;
    ALTER TABLE investors ADD COLUMN IF NOT EXISTS source_company_id INTEGER;
  `);

  console.log('[DB] Schema ready (PostgreSQL)');
}

module.exports = { pool, query, queryOne, execute, initSchema, today, nowText, daysFromNow, daysAgo };
