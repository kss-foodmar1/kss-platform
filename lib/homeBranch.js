// A user's home branches: stored in users.home_branch as plain text (one branch)
// or a JSON array (several — e.g. a district manager). Empty = all branches.
function parse(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try { return [...new Set(JSON.parse(s).map((x) => String(x).trim()).filter(Boolean))]; } catch (_) { return []; }
  }
  return s ? [s] : [];
}
function serialize(list) {
  const a = [...new Set((list || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!a.length) return null;
  return a.length === 1 ? a[0] : JSON.stringify(a);
}
module.exports = { parse, serialize };
