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

    CREATE TABLE IF NOT EXISTS agent_registry (
      id SERIAL PRIMARY KEY,
      agent_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      purpose TEXT DEFAULT '',
      provider TEXT DEFAULT 'native',
      model TEXT DEFAULT '',
      capabilities JSONB DEFAULT '[]',
      schedule_json JSONB DEFAULT '{}',
      input_schema JSONB DEFAULT '{}',
      output_schema JSONB DEFAULT '{}',
      dependencies JSONB DEFAULT '[]',
      plan_constraints JSONB DEFAULT '{}',
      status TEXT DEFAULT 'active',
      display_in_roster INTEGER DEFAULT 0,
      config_json JSONB DEFAULT '{}',
      current_version INTEGER DEFAULT 1,
      owner_id TEXT DEFAULT 'local',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      updated_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pricing_snapshots (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_cost_per_million NUMERIC DEFAULT 0,
      output_cost_per_million NUMERIC DEFAULT 0,
      unit_cost_usd NUMERIC DEFAULT 0,
      source_url TEXT DEFAULT '',
      effective_at TEXT NOT NULL,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(provider, model, effective_at)
    );

    CREATE TABLE IF NOT EXISTS agent_signals (
      id SERIAL PRIMARY KEY,
      run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
      agent_key TEXT,
      signal_type TEXT NOT NULL,
      entity_type TEXT DEFAULT '',
      entity_id INTEGER,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      confidence NUMERIC DEFAULT 0.5,
      source_url TEXT DEFAULT '',
      source_name TEXT DEFAULT '',
      data_json JSONB DEFAULT '{}',
      fingerprint TEXT UNIQUE,
      status TEXT DEFAULT 'new',
      actionable INTEGER DEFAULT 0,
      accepted INTEGER DEFAULT 0,
      duplicate_of_id INTEGER REFERENCES agent_signals(id) ON DELETE SET NULL,
      observed_at TEXT,
      owner_id TEXT DEFAULT 'local',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS company_intelligence (
      company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      clean_description TEXT DEFAULT '',
      business_model TEXT DEFAULT '',
      products JSONB DEFAULT '[]',
      customers JSONB DEFAULT '[]',
      leadership JSONB DEFAULT '[]',
      hiring_summary TEXT DEFAULT '',
      preference_fit TEXT DEFAULT '',
      why_now TEXT DEFAULT '',
      open_questions JSONB DEFAULT '[]',
      sources JSONB DEFAULT '[]',
      warnings JSONB DEFAULT '[]',
      confidence NUMERIC DEFAULT 0,
      data_source TEXT DEFAULT '',
      last_synced_at TEXT,
      profile_json JSONB DEFAULT '{}',
      updated_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS agent_versions (
      id SERIAL PRIMARY KEY,
      agent_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      config_json JSONB DEFAULT '{}',
      change_summary TEXT DEFAULT '',
      created_by TEXT DEFAULT 'system',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      UNIQUE(agent_key, version)
    );

    CREATE TABLE IF NOT EXISTS agent_outcomes (
      id SERIAL PRIMARY KEY,
      run_id INTEGER REFERENCES agent_runs(id) ON DELETE SET NULL,
      signal_id INTEGER REFERENCES agent_signals(id) ON DELETE SET NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      outcome_type TEXT NOT NULL,
      outcome_value NUMERIC DEFAULT 1,
      notes TEXT DEFAULT '',
      data_json JSONB DEFAULT '{}',
      owner_id TEXT DEFAULT 'local',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS adaptation_proposals (
      id SERIAL PRIMARY KEY,
      agent_key TEXT NOT NULL,
      proposal_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      current_version INTEGER,
      proposed_config JSONB DEFAULT '{}',
      diff_json JSONB DEFAULT '{}',
      evidence_json JSONB DEFAULT '[]',
      estimated_daily_cost_delta NUMERIC DEFAULT 0,
      expected_impact TEXT DEFAULT '',
      trial_days INTEGER DEFAULT 7,
      success_metric TEXT DEFAULT '',
      applied_version INTEGER,
      owner_id TEXT DEFAULT 'local',
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS control_tower_settings (
      owner_id TEXT PRIMARY KEY DEFAULT 'local',
      daily_target_usd NUMERIC DEFAULT 2.00,
      monthly_ceiling_usd NUMERIC DEFAULT 60.00,
      dust_workspace_allowance INTEGER,
      dust_trigger_allowance INTEGER,
      dust_programmatic_credits_usd NUMERIC,
      dust_credits_remaining_usd NUMERIC,
      timezone TEXT DEFAULT 'America/Los_Angeles',
      updated_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
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

    CREATE TABLE IF NOT EXISTS user_profile (
      id SERIAL PRIMARY KEY,
      full_name TEXT,
      email TEXT,
      elevator_pitch TEXT,
      linkedin_url TEXT,
      portfolio_url TEXT,
      target_roles TEXT,
      preferred_tone TEXT DEFAULT 'professional',
      email_signature TEXT,
      skills TEXT,
      experiences JSONB DEFAULT '[]',
      education JSONB DEFAULT '[]',
      resume_raw TEXT,
      updated_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
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
    ALTER TABLE investors ADD COLUMN IF NOT EXISTS investor_type TEXT DEFAULT 'VC';
    ALTER TABLE investors ADD COLUMN IF NOT EXISTS linkedin_url TEXT DEFAULT '';
    ALTER TABLE drafts ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'email';
    ALTER TABLE drafts ADD COLUMN IF NOT EXISTS linkedin_url TEXT DEFAULT '';
    ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS outreach_prefs JSONB DEFAULT '{}';
    ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS taste_profile TEXT;
    ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS taste_refined_at TEXT;
    ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS display_in_roster INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_key TEXT;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_version INTEGER DEFAULT 1;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS parent_run_id INTEGER REFERENCES agent_runs(id);
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS trigger_type TEXT DEFAULT 'manual';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS started_at TEXT;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS completed_at TEXT;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS duration_ms INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'native';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model TEXT DEFAULT '';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS provider_usage JSONB DEFAULT '{}';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS provider_calls INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS exact_cost_usd NUMERIC;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cost_basis TEXT DEFAULT 'estimated';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS pricing_snapshot_id INTEGER REFERENCES pricing_snapshots(id);
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS plan_bucket TEXT DEFAULT 'api';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS plan_units NUMERIC DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS output_count INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS duplicate_count INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS actionable_count INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS accepted_count INTEGER DEFAULT 0;
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS error_text TEXT DEFAULT '';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS source_refs JSONB DEFAULT '[]';
    ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS owner_id TEXT DEFAULT 'local';

    CREATE TABLE IF NOT EXISTS preference_events (
      id SERIAL PRIMARY KEY,
      category TEXT,
      left_json JSONB,
      right_json JSONB,
      choice TEXT,
      created_at TEXT DEFAULT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
    );

    INSERT INTO control_tower_settings (owner_id)
    VALUES ('local')
    ON CONFLICT (owner_id) DO NOTHING;

    INSERT INTO pricing_snapshots
      (provider, model, input_cost_per_million, output_cost_per_million, unit_cost_usd, source_url, effective_at)
    VALUES
      ('anthropic', 'claude-sonnet-4-6', 3, 15, 0, 'https://docs.anthropic.com/en/docs/about-claude/pricing', '2026-02-17'),
      ('exa', 'search', 0, 0, 0.005, 'configurable estimate: EXA_SEARCH_COST_USD', '2026-01-01'),
      ('dust', 'programmatic', 0, 0, 0, 'https://docs.dust.tt/docs/programmatic-usage', '2026-01-01')
    ON CONFLICT (provider, model, effective_at) DO NOTHING;
  `);

  console.log('[DB] Schema ready (PostgreSQL)');
}

module.exports = { pool, query, queryOne, execute, initSchema, today, nowText, daysFromNow, daysAgo };
