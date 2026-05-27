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
    'SELECT * FROM companies ORDER BY last_touched DESC NULLS LAST, date_added DESC'
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

      const existing = await client.query(
        'SELECT id, investor_firms FROM companies WHERE name = $1',
        [mapped.name]
      );

      if (existing.rows[0]) {
        // Backfill investor_firms for existing entries that don't have it
        if (mapped.investor_firms) {
          await client.query(
            `UPDATE companies SET investor_firms = $1
             WHERE id = $2 AND (investor_firms IS NULL OR investor_firms = '')`,
            [mapped.investor_firms, existing.rows[0].id]
          );
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
  const row = await queryOne('SELECT * FROM companies WHERE id = $1', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
