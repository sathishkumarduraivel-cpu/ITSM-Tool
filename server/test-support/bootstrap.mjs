// Preloaded via `node --import ./test-support/bootstrap.mjs --test` (see
// package.json's "test" script) -- runs before any test file is loaded, in
// every worker process node:test spawns (one per test file, by default), so
// each test file gets its own fresh throwaway SQLite database instead of
// ever touching this project's real server/data/itsm.db. See db.js's
// ITSM_DATA_DIR override.
//
// Deliberately NOT placed inside test/ -- node:test's default file
// discovery treats every file under a directory literally named `test` as a
// test file in its own right (in addition to *.test.js anywhere), so a
// same-named setup script living there would get collected and "run" as an
// empty test file too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.ITSM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'itsm-ai-test-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-suite-jwt-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
