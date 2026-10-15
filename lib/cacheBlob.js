// Report caches (fmh_report_cache, fmh_cache_saved) keep their rows gzipped in
// data_gz. Row JSON compresses about tenfold, and the MySQL volume on Railway
// is small. data_json is the old plain-text column: new writes leave it '' and
// the readers below still understand a row written before the switch.
const zlib = require('zlib');

function pack(rows) {
  return { gz: zlib.gzipSync(Buffer.from(JSON.stringify(rows), 'utf8')), count: Array.isArray(rows) ? rows.length : 0 };
}

// row: { data_gz, data_json } as selected from either cache table.
function unpack(row) {
  if (!row) return null;
  if (row.data_gz) return JSON.parse(zlib.gunzipSync(row.data_gz).toString('utf8'));
  return row.data_json ? JSON.parse(row.data_json) : [];
}

module.exports = { pack, unpack };
