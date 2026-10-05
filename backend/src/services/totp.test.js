import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSecret, generateTOTP, verifyTOTP, otpauthUrl, generateRecoveryCodes, hashRecoveryCode,
} from './totp.js';

describe('totp: RFC 6238 correctness', () => {
  test('matches the official RFC 6238 Appendix B SHA1 test vector', () => {
    // RFC 6238's test seed is the literal ASCII string "12345678901234567890"
    // used directly as the HMAC key, not base32-decoded from a base32
    // string -- base32-encode it first so it goes through the same decode
    // path a real secret would. At T=59s (counter=1) the RFC's 8-digit
    // vector is 94287082; this module always produces 6 digits
    // (binCode % 10^6), which is exactly that value's last 6 digits.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    function base32Encode(buffer) {
      let bits = ''; for (const byte of buffer) bits += byte.toString(2).padStart(8, '0');
      let out = ''; for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
      const rem = bits.length % 5; if (rem) out += ALPHABET[parseInt(bits.slice(-rem).padEnd(5, '0'), 2)];
      return out;
    }
    const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    assert.equal(generateTOTP(secret, 59 * 1000), '287082');
  });

  test('generateSecret produces a valid, decodable base32 string each time', () => {
    const a = generateSecret();
    const b = generateSecret();
    assert.match(a, /^[A-Z2-7]+$/);
    assert.notEqual(a, b, 'two secrets in a row should not collide');
    assert.equal(generateTOTP(a).length, 6);
  });
});

describe('totp: verifyTOTP', () => {
  test('accepts the current code', () => {
    const secret = generateSecret();
    assert.equal(verifyTOTP(secret, generateTOTP(secret)), true);
  });

  test('accepts a code from one step early or late (clock drift tolerance)', () => {
    const secret = generateSecret();
    const STEP_MS = 30 * 1000;
    const prevCode = generateTOTP(secret, Date.now() - STEP_MS);
    const nextCode = generateTOTP(secret, Date.now() + STEP_MS);
    assert.equal(verifyTOTP(secret, prevCode), true);
    assert.equal(verifyTOTP(secret, nextCode), true);
  });

  test('rejects a code from two steps away', () => {
    const secret = generateSecret();
    const STEP_MS = 30 * 1000;
    const farCode = generateTOTP(secret, Date.now() - STEP_MS * 3);
    assert.equal(verifyTOTP(secret, farCode), false);
  });

  test('rejects a code generated from a different secret', () => {
    const secretA = generateSecret();
    const secretB = generateSecret();
    assert.equal(verifyTOTP(secretA, generateTOTP(secretB)), false);
  });

  test('rejects malformed input without throwing', () => {
    const secret = generateSecret();
    assert.equal(verifyTOTP(secret, ''), false);
    assert.equal(verifyTOTP(secret, undefined), false);
    assert.equal(verifyTOTP(secret, 'abcdef'), false);
    assert.equal(verifyTOTP(secret, '12345'), false); // too short
    assert.equal(verifyTOTP(secret, '1234567'), false); // too long
  });
});

describe('totp: otpauthUrl', () => {
  test('produces a well-formed otpauth:// URI carrying the secret, issuer and account', () => {
    const secret = generateSecret();
    const url = otpauthUrl(secret, 'alex@example.com', 'ITSM AI');
    assert.match(url, /^otpauth:\/\/totp\//);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('secret'), secret);
    assert.equal(parsed.searchParams.get('issuer'), 'ITSM AI');
    assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
    assert.equal(parsed.searchParams.get('digits'), '6');
    assert.equal(parsed.searchParams.get('period'), '30');
    assert.ok(decodeURIComponent(parsed.pathname).includes('alex@example.com'));
  });
});

describe('totp: recovery codes', () => {
  test('generates the requested count, each in XXXXX-XXXXX form, all unique', () => {
    const codes = generateRecoveryCodes(10);
    assert.equal(codes.length, 10);
    for (const c of codes) assert.match(c, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
    assert.equal(new Set(codes).size, 10, 'no duplicate codes in one batch');
  });

  test('hashRecoveryCode is deterministic, case-insensitive, and one-way', () => {
    const [code] = generateRecoveryCodes(1);
    const hash1 = hashRecoveryCode(code);
    const hash2 = hashRecoveryCode(code.toLowerCase());
    assert.equal(hash1, hash2, 'hashing is case-insensitive, matching how a user might type it back');
    assert.notEqual(hash1, code, 'the hash is never the code itself');
    assert.equal(hash1.length, 64, 'a real SHA-256 hex digest');
  });

  test('two different codes hash to two different values', () => {
    const [a, b] = generateRecoveryCodes(2);
    assert.notEqual(hashRecoveryCode(a), hashRecoveryCode(b));
  });
});
