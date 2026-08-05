// Encryption-at-rest helper for secrets stored in SQLite (ai_providers.api_key,
// integrations.config). AES-256-GCM via Node's built-in node:crypto — no extra
// dependency, consistent with this project's zero-native-deps philosophy.
import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function loadKey() {
  const keyB64 = process.env.ENCRYPTION_KEY;
  if (keyB64) {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length === 32) return key;
    console.warn('[crypto] ENCRYPTION_KEY is not a valid 32-byte base64 value — deriving a key from it instead. Generate a proper one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
    return crypto.createHash('sha256').update(keyB64).digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ENCRYPTION_KEY must be set in production — refusing to start without a real encryption key.');
  }
  console.warn('[crypto] ENCRYPTION_KEY not set — using an ephemeral in-memory key (dev only). Encrypted secrets will not survive a server restart. Set ENCRYPTION_KEY in server/.env.');
  return crypto.randomBytes(32);
}

const KEY = loadKey();

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncrypted(value)) return value; // not yet migrated / plaintext legacy value
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
