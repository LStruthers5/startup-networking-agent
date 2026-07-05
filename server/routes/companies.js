const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { pool, query, queryOne, execute } = require('../db');

const upload = multer({ storage: multer.memoryStorage() });

const FOCUS_SECTORS = ['ai', 'fitness', 'wearable', 'wearables', 'clean tech', 'cleantech', 'climate'];

function classifySector(industries = '') {
  const lower = industries.toLowerCase();
  if (/\bai\b|artificial intelligence|machine learning/.test(lower)) return 'AI';
  if (/fitness|wearable|sport/.test(lower)) return 'fitness/wearables';
  if (/clean tech|cleantech|climate|energy|sustainability/.test(lower)) return 'clean tech';
  return industries || 'other';
}

function inFocus(sector = '') {
  const s = sector.toLowerCase();
  return FOCUS_SECTORS.some(f => s.includes(f));
}

// Strips protocol/www/trailing slash so a website can be compared reliably regardless of how it
// was originally entered.
function normalizeDomain(url) {
  return (url || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').trim().toLowerCase();
}

// Parse investor firm names from Crunchbase columns, deduplicated and cleaned
function parseInvestorFirms(row) {
  const raw = [
    row['Top 5 Investors'] || '',
    row['Lead Investors'] || '',
    row['Investors'] || '',
  ].join(',');
  const firms = raw.split(',')
    .map(s => s.trim())
    .filter(s => s.length > 1)
    .filter((v, i, arr) => arr.indexOf(v) === i); // dedupe
  return firms.join(', ');
}

// Map Crunchbase CSV columns → internal fields
function mapCrunchbaseRow(row) {
  return {
    name: row['Organization Name'] || row['company_name'] || '',
    sector: classifySector(row['Industries'] || row['sector'] || ''),
    stage: row['Last Funding Type'] || row['Stage'] || row['stage'] || '',
    description: row['Description'] || row['description'] || '',
    website: row['Website'] || row['website'] || '',
    founded_year: row['Founded Year'] || row['founded_year'] || '',
    last_funding: row['Last Funding Type'] || row['latest_funding_round'] || '',
    funding_amount: row['Last Funding Amount (in USD)'] || row['funding_amount'] || '',
    location: row['Headquarters Location'] || row['location'] || '',
    investor_firms: parseInvestorFirms(row),
    source: 'crunchbase',
  };
}

router.get('/', async (req, res) => {
  const rows = await query(
    `SELECT c.*,ci.clean_description AS intelligence_description,
      ci.preference_fit,ci.why_now,ci.confidence AS intelligence_confidence,
      ci.last_synced_at AS intelligence_refreshed_at
     FROM companies c
     LEFT JOIN company_intelligence ci ON ci.company_id=c.id
     ORDER BY c.last_touched DESC NULLS LAST,c.date_added DESC`
  );
  res.json(rows);
});

// GET /api/companies/enrichment-queue — companies missing key Crunchbase-sourced fields, so the
// user can copy the list of names into Crunchbase's own search/list tool instead of looking each up
// one by one, then re-import the resulting export (which now backfills every empty field, not just
// investor_firms — see the /import handler).
router.get('/enrichment-queue', async (req, res) => {
  const rows = await query(
    `SELECT id, name, website, sector, stage, score,
       (founded_year IS NULL OR founded_year='') AS missing_founded,
       (last_funding IS NULL OR last_funding='') AS missing_funding_stage,
       (funding_amount IS NULL OR funding_amount='') AS missing_amount,
       (investor_firms IS NULL OR investor_firms='') AS missing_investors
     FROM companies
     WHERE status NOT IN ('passed','archived')
       AND (
         founded_year IS NULL OR founded_year=''
         OR last_funding IS NULL OR last_funding=''
         OR funding_amount IS NULL OR funding_amount=''
         OR investor_firms IS NULL OR investor_firms=''
       )
     ORDER BY score DESC NULLS LAST, name ASC`
  );
  res.json(rows);
});

router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let records;
  try {
    records = parse(req.file.buffer.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err) {
    return res.status(400).json({ error: 'CSV parse error: ' + err.message });
  }

  let added = 0, skipped = 0, flagged = 0;
  const flaggedNames = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of records) {
      const mapped = mapCrunchbaseRow(row);
      if (!mapped.name) continue;

      // Match by domain first when we have one — it's a far more reliable join key than name,
      // since generic/short company names (Temple, Ampa, Coa) collide with unrelated companies
      // constantly, but domains don't. Falls back to exact name match when no domain is available.
      const mappedDomain = normalizeDomain(mapped.website);
      let existing;
      if (mappedDomain) {
        existing = await client.query(
          `SELECT id, investor_firms FROM companies
           WHERE website IS NOT NULL AND website != ''
             AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(website, '^https?://(www\\.)?', ''), '/.*$', '')) = $1`,
          [mappedDomain]
        );
      }
      if (!existing || !existing.rows[0]) {
        existing = await client.query('SELECT id, investor_firms FROM companies WHERE name = $1', [mapped.name]);
      }

      if (existing.rows[0]) {
        // Backfill any enrichment field that's currently empty — this is what makes the
        // "export a target list, re-import the Crunchbase CSV" loop actually fill gaps rather
        // than just skip already-known companies.
        const backfillFields = ['investor_firms', 'founded_year', 'last_funding', 'funding_amount', 'location', 'description'];
        const sets = [], vals = [];
        for (const field of backfillFields) {
          if (!mapped[field]) continue;
          sets.push(`${field} = COALESCE(NULLIF(${field}, ''), $${vals.length + 1})`);
          vals.push(mapped[field]);
        }
        if (sets.length) {
          vals.push(existing.rows[0].id);
          await client.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
        }
        skipped++;
        continue;
      }

      await client.query(
        `INSERT INTO companies
           (name, sector, stage, description, website, founded_year,
            last_funding, funding_amount, location, investor_firms, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          mapped.name, mapped.sector, mapped.stage, mapped.description,
          mapped.website, mapped.founded_year, mapped.last_funding,
          mapped.funding_amount, mapped.location, mapped.investor_firms, mapped.source,
        ]
      );
      added++;

      if (!inFocus(mapped.sector)) {
        flagged++;
        flaggedNames.push(mapped.name);
      }
    }

    await client.query('COMMIT');
    res.json({ added, skipped, flagged, flaggedNames });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

router.patch('/:id', async (req, res) => {
  const allowed = ['notes', 'score', 'status', 'last_touched'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
  const vals = [...fields.map(f => req.body[f]), req.params.id];
  await execute(`UPDATE companies SET ${sets} WHERE id = $${fields.length + 1}`, vals);
  res.json({ ok: true });
});

router.get('/:id', async (req, res) => {
  const row = await queryOne(
    `SELECT c.*,ci.clean_description AS intelligence_description,ci.business_model,
      ci.products,ci.customers,ci.leadership,ci.hiring_summary,ci.preference_fit,ci.why_now,
      ci.open_questions,ci.sources AS intelligence_sources,ci.warnings AS intelligence_warnings,
      ci.confidence AS intelligence_confidence,ci.last_synced_at AS intelligence_refreshed_at
     FROM companies c LEFT JOIN company_intelligence ci ON ci.company_id=c.id
     WHERE c.id=$1`,
    [req.params.id]
  );
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.recent_signals = await query(
    `SELECT signal_type,title,summary,confidence,source_url,observed_at
     FROM agent_signals
     WHERE company_id=$1 AND agent_key!='evidence-auditor'
       AND status NOT IN ('duplicate','rejected')
       AND LENGTH(TRIM(COALESCE(summary,'')))>=35
     ORDER BY created_at DESC LIMIT 8`,
    [req.params.id]
  );
  res.json(row);
});

module.exports = router;
