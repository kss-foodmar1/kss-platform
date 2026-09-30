// Runs schema.sql against the configured database. Safe to re-run —
// every statement is CREATE TABLE IF NOT EXISTS.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // Strip full-line comments first, so a comment sitting right before a
  // statement doesn't cause the whole statement to be dropped.
  const sql = raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length);

  for (const stmt of statements) {
    await pool.query(stmt);
  }

  console.log(`Migration complete: ${statements.length} statement(s) applied.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
