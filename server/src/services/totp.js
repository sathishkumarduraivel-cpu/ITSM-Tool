// RFC 6238 TOTP (the algorithm behind Google Authenticator / Microsoft
// Authenticator / Authy) implemented over Node's built-in crypto -- no new
// dependency for the algorithm itself, consistent with this app's existing
// zero-unnecessary-deps philosophy (see crypto.js's own header comment).
// Only `qrcode` (already installed) is a real new dependency, needed because
// rendering a PNG is not something worth hand-rolling.
import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  const remainder = bits.length % 5;
  if (remainder) out += BASE32_ALPHABET[parseInt(bits.slice(-remainder).padEnd(5, '0'), 2)];
  return out;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) bits += BASE32_ALPHABET.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

// A fresh 160-bit secret (the standard TOTP key size -- RFC 4226 §4
// recommends at least 128 bits, 160 matches what Google/Microsoft
// Authenticator's own generators use), base32-encoded so it's both typeable
// by hand and embeddable in an otpauth:// URI.
export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBytes, counter, digits = DIGITS) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBytes).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

export function generateTOTP(base32Secret, forTimeMs = Date.now()) {
  const counter = Math.floor(forTimeMs / 1000 / STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Accepts a code from one step early or late (±30s) to absorb ordinary
// clock drift between the server and the user's phone -- the same tolerance
// window every mainstream TOTP verifier uses, not a weakening of the check
// (an attacker still needs the secret; this only affects timing).
export function verifyTOTP(base32Secret, token, window = 1) {
  if (!token || !/^\d{6}$/.test(String(token).trim())) return false;
  const secretBytes = base32Decode(base32Secret);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (timingSafeStringEqual(hotp(secretBytes, counter + errorWindow), String(token).trim())) return true;
  }
  return false;
}

export function otpauthUrl(base32Secret, accountEmail, issuer = 'ITSM AI') {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({ secret: base32Secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

// Recovery codes: single-use fallbacks for "I lost my phone." Generated only
// once, at enable time, shown to the user exactly once (see routes/auth.js's
// POST /mfa/enable) -- only their SHA-256 hash is ever persisted, the same
// show-once/hash-at-rest pattern api_keys already uses for API tokens.
export function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
  });
}

export function hashRecoveryCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}
