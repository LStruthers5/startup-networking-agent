const express = require('express');
const router = express.Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const db = require('../db');

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

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM companies ORDER BY last_touched DESC NULLS LAST, date_added DESC
  `).all();
  res.json(rows);
});

router.post('/import', upload.single('file'), (req, res) => {
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

  const checkDup = db.prepare(
    'SELECT id FROM companies WHERE name = ?'
  );
  const insert = db.prepare(`
    INSERT INTO companies (name, sector, stage, description, website, founded_year,
      last_funding, funding_amount, location, investor_firms, source)
    VALUES (@name, @sector, @stage, @description, @website, @founded_year,
      @last_funding, @funding_amount, @location, @investor_firms, @source)
  `);
  // On re-import, backfill investor_firms for existing companies
  const updateInvestorFirms = db.prepare(
    `UPDATE companies SET investor_firms = @investor_firms WHERE id = @id AND (investor_firms IS NULL OR investor_firms = '')`
  );

  const importMany = db.transaction((rows) => {
    for (const row of rows) {
      const mapped = mapCrunchbaseRow(row);
      if (!mapped.name) continue;

      const dup = checkDup.get(mapped.name);
      if (dup) {
        // Backfill investor_firms for existing entries that don't have it
        if (mapped.investor_firms) updateInvestorFirms.run({ id: dup.id, investor_firms: mapped.investor_firms });
        skipped++;
        continue;
      }

      insert.run(mapped);
      added++;

      if (!inFocus(mapped.sector)) {
        flagged++;
        flaggedNames.push(mapped.name);
      }
    }
  });

  importMany(records);

  res.json({ added, skipped, flagged, flaggedNames });
});

router.patch('/:id', (req, res) => {
  const allowed = ['notes', 'score', 'status', 'last_touched'];
  const fields = Object.keys(req.body).filter(k => allowed.includes(k));
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });

  const sets = fields.map(f => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE companies SET ${sets} WHERE id = @id`);
  stmt.run({ ...req.body, id: req.params.id });
  res.json({ ok: true });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
