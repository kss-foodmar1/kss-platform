// AES-256-GCM encrypt/decrypt for secrets at rest (the FMH API key).
// ENCRYPTION_KEY must be a 64-char hex string (32 bytes) — see .env.example
// for the generation command.
const crypto = require('crypto');

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

// Returns "iv:authTag:ciphertext" (all hex), stored as one string.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

// Last 4 characters only, for display after saving ("Saved — ends in 90a1").
function mask(plaintext) {
  const s = String(plaintext);
  return s.length > 4 ? `ends in ${s.slice(-4)}` : 'saved';
}

module.exports = { encrypt, decrypt, mask };
