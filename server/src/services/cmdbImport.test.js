import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { getClass, ensureDefaultCiClasses, readAttributes } from './ciClasses.js';
import { createDiscoverySource } from './discoverySources.js';
import { reconcile } from './ciIdentity.js';
import {
  parseCsv, readSheet, guessMapping, mappingOptions, previewImport, commitImport, templateFor, exportClass,
} from './cmdbImport.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  ensureDefaultCiClasses(id);
  return id;
}
const classId = (ws, key) => getClass(ws, key).id;

describe('CSV parsing', () => {
  test('a plain sheet parses', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n3,4'), [['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  test('quoted fields may contain the delimiter', () => {
    assert.deepEqual(parseCsv('name,note\n"Smith, John",hello'), [['name', 'note'], ['Smith, John', 'hello']]);
  });

  test('quoted fields may contain newlines — which every real asset export has', () => {
    assert.deepEqual(parseCsv('name,note\nbox,"line one\nline two"'), [['name', 'note'], ['box', 'line one\nline two']]);
  });

  test('a doubled quote is one literal quote', () => {
    assert.deepEqual(parseCsv('a\n"say ""hi"""'), [['a'], ['say "hi"']]);
  });

  test('CRLF line endings work, because the file came from Excel', () => {
    assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
  });

  test('a UTF-8 BOM does not become part of the first column name', () => {
    assert.deepEqual(parseCsv('﻿tag,name\nA-1,box')[0], ['tag', 'name']);
  });

  test('a trailing newline does not produce a phantom row', () => {
    assert.equal(parseCsv('a,b\n1,2\n').length, 2);
  });

  test('empty fields are preserved, not collapsed', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,,3'), [['a', 'b', 'c'], ['1', '', '3']]);
  });

  test('a semicolon-delimited export can be read too', () => {
    assert.deepEqual(parseCsv('a;b\n1;2', { delimiter: ';' }), [['a', 'b'], ['1', '2']]);
  });
});

describe('reading a sheet', () => {
  test('headers split from rows', () => {
    const sheet = readSheet('tag,name\nA-1,box');
    assert.deepEqual(sheet.headers, ['tag', 'name']);
    assert.equal(sheet.rows.length, 1);
  });

  test('an empty file is refused with a readable message', () => {
    assert.throws(() => readSheet(''), /no rows/);
  });

  test('duplicate column names are refused, because a mapping could not be honest', () => {
    assert.throws(() => readSheet('tag,tag\n1,2'), /appear more than once/);
  });

  test('an oversized file is refused up front', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `A-${i},box`).join('\n');
    assert.throws(() => readSheet(`tag,name\n${rows}`), /at most 5000/);
  });
});

describe('column mapping', () => {
  test('exact keys are matched', () => {
    const ws = newWorkspace();
    const guess = guessMapping(ws, classId(ws, 'server'), ['tag', 'name', 'hostname', 'cpu_cores']);
    assert.equal(guess.tag, 'core.tag');
    assert.equal(guess.hostname, 'attr.hostname');
    assert.equal(guess.cpu_cores, 'attr.cpu_cores');
  });

  test('human column headings are matched too', () => {
    const ws = newWorkspace();
    const guess = guessMapping(ws, classId(ws, 'server'), ['Asset tag', 'CPU cores', 'Serial Number', 'IP address']);
    assert.equal(guess['Asset tag'], 'core.tag');
    assert.equal(guess['CPU cores'], 'attr.cpu_cores');
    assert.equal(guess['Serial Number'], 'attr.serial_number');
    assert.equal(guess['IP address'], 'attr.ip_address');
  });

  test('an unrecognised column is left unmapped rather than guessed at', () => {
    const ws = newWorkspace();
    assert.equal(guessMapping(ws, classId(ws, 'server'), ['who_knows']).who_knows, '');
  });

  test('inherited attributes are offered, not just the class own', () => {
    const ws = newWorkspace();
    const keys = mappingOptions(ws, classId(ws, 'server')).attributes.map((a) => a.key);
    assert.ok(keys.includes('serial_number'), 'from Hardware');
    assert.ok(keys.includes('environment'), 'from Configuration Item');
  });
});

describe('preview', () => {
  const sheet = (text) => readSheet(text);
  const mapping = { tag: 'core.tag', name: 'core.name', hostname: 'attr.hostname', serial_number: 'attr.serial_number', cpu_cores: 'attr.cpu_cores' };

  test('every row is classified as create or update, and nothing is written', () => {
    const ws = newWorkspace();
    reconcile(ws, { ci_class: 'server', attributes: { hostname: 'app-01', serial_number: 'SN-1' } });
    const csv = 'tag,name,hostname,serial_number,cpu_cores\n,,app-01,SN-1,16\n,,app-02,SN-2,8';
    const preview = previewImport(ws, sheet(csv), { classId: classId(ws, 'server'), mapping });

    assert.equal(preview.counts.update, 1);
    assert.equal(preview.counts.create, 1);
    assert.equal(preview.rows.find((r) => r.action === 'update').matched_by, 'serial_number');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(ws).c, 1, 'preview writes nothing');
  });

  test('a bad value is reported against its own row number', () => {
    const ws = newWorkspace();
    const csv = 'tag,name,hostname,serial_number,cpu_cores\n,,app-01,SN-1,plenty';
    const preview = previewImport(ws, sheet(csv), { classId: classId(ws, 'server'), mapping });
    const row = preview.rows[0];
    assert.equal(row.action, 'error');
    assert.equal(row.row, 2, 'the header is row 1');
    assert.match(row.problems[0], /CPU cores must be a number/);
  });

  test('a missing required value is reported per row', () => {
    const ws = newWorkspace();
    // hostname is required on Server.
    const csv = 'tag,name,hostname,serial_number,cpu_cores\n,,,SN-1,4';
    const preview = previewImport(ws, sheet(csv), { classId: classId(ws, 'server'), mapping });
    assert.equal(preview.counts.error, 1);
    assert.match(preview.rows[0].problems[0], /Hostname is required/);
  });

  test('the same identifier twice in one file is flagged, not silently merged', () => {
    const ws = newWorkspace();
    const csv = 'tag,name,hostname,serial_number,cpu_cores\n,,app-01,SN-1,4\n,,app-01-again,SN-1,8';
    const preview = previewImport(ws, sheet(csv), { classId: classId(ws, 'server'), mapping });
    assert.equal(preview.counts.duplicate_in_file, 1);
    assert.equal(preview.rows[1].duplicate_of_row, 2);
  });

  test('importing with no identifying column warns that everything will duplicate', () => {
    const ws = newWorkspace();
    const csv = 'name,cpu_cores\napp-01,4';
    const preview = previewImport(ws, sheet(csv), {
      classId: classId(ws, 'server'), mapping: { name: 'core.name', cpu_cores: 'attr.cpu_cores' },
    });
    assert.ok(preview.warnings.some((w) => /No identifying column/.test(w)), JSON.stringify(preview.warnings));
  });

  test('a required attribute with no column mapped is called out once, not per row', () => {
    const ws = newWorkspace();
    const csv = 'serial_number\nSN-1\nSN-2\nSN-3';
    const preview = previewImport(ws, sheet(csv), {
      classId: classId(ws, 'server'), mapping: { serial_number: 'attr.serial_number' },
    });
    assert.equal(preview.warnings.filter((w) => /Hostname is required/.test(w)).length, 1);
  });

  test('an abstract class is refused', () => {
    const ws = newWorkspace();
    assert.throws(
      () => previewImport(ws, sheet('serial_number\nSN-1'), { classId: classId(ws, 'hardware'), mapping: { serial_number: 'attr.serial_number' } }),
      /grouping class/
    );
  });

  test('mapping nothing is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => previewImport(ws, sheet('a\n1'), { classId: classId(ws, 'server'), mapping: {} }), /Map at least one column/);
  });

  test('unmapped columns are ignored rather than causing errors', () => {
    const ws = newWorkspace();
    const csv = 'hostname,serial_number,something_else\napp-01,SN-1,ignore me';
    const preview = previewImport(ws, sheet(csv), {
      classId: classId(ws, 'server'), mapping: { hostname: 'attr.hostname', serial_number: 'attr.serial_number', something_else: '' },
    });
    assert.equal(preview.counts.create, 1);
    assert.equal(preview.counts.error, 0);
  });

  test('a big file returns capped rows but honest counts', () => {
    const ws = newWorkspace();
    const rows = Array.from({ length: 300 }, (_, i) => `app-${i},SN-${i}`).join('\n');
    const preview = previewImport(ws, sheet(`hostname,serial_number\n${rows}`), {
      classId: classId(ws, 'server'), mapping: { hostname: 'attr.hostname', serial_number: 'attr.serial_number' },
    });
    assert.equal(preview.total, 300);
    assert.equal(preview.counts.create, 300);
    assert.equal(preview.rows.length, 200);
    assert.equal(preview.truncated, true);
  });
});

describe('commit', () => {
  const mapping = { hostname: 'attr.hostname', serial_number: 'attr.serial_number', cpu_cores: 'attr.cpu_cores' };
  const csv = 'hostname,serial_number,cpu_cores\napp-01,SN-1,16\napp-02,SN-2,8';

  test('rows land as CIs', () => {
    const ws = newWorkspace();
    const result = commitImport(ws, readSheet(csv), { classId: classId(ws, 'server'), mapping });
    assert.deepEqual(result.summary, { created: 2, updated: 0, unchanged: 0, skipped: 0, failed: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(ws).c, 2);
  });

  test('importing the same file twice does not duplicate — the point of the whole module', () => {
    const ws = newWorkspace();
    commitImport(ws, readSheet(csv), { classId: classId(ws, 'server'), mapping });
    const second = commitImport(ws, readSheet(csv), { classId: classId(ws, 'server'), mapping });
    assert.equal(second.summary.created, 0);
    assert.equal(second.summary.unchanged, 2);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(ws).c, 2);
  });

  test('a changed value updates the existing CI', () => {
    const ws = newWorkspace();
    commitImport(ws, readSheet(csv), { classId: classId(ws, 'server'), mapping });
    const changed = 'hostname,serial_number,cpu_cores\napp-01,SN-1,32\napp-02,SN-2,8';
    const result = commitImport(ws, readSheet(changed), { classId: classId(ws, 'server'), mapping });
    assert.equal(result.summary.updated, 1);
    assert.equal(result.summary.unchanged, 1);
    const ci = db.prepare("SELECT id FROM assets WHERE workspace_id = ? AND name = 'SN-1'").get(ws);
    assert.equal(readAttributes(ci.id).cpu_cores, 32);
  });

  test('rows that failed the preview are skipped, and the good ones still land', () => {
    const ws = newWorkspace();
    const mixed = 'hostname,serial_number,cpu_cores\napp-01,SN-1,16\napp-02,SN-2,plenty\napp-03,SN-3,4';
    const result = commitImport(ws, readSheet(mixed), { classId: classId(ws, 'server'), mapping });
    assert.equal(result.summary.created, 2);
    assert.equal(result.summary.skipped, 1);
  });

  test('a duplicate row within the file is skipped by default', () => {
    const ws = newWorkspace();
    const dupes = 'hostname,serial_number,cpu_cores\napp-01,SN-1,16\napp-01-again,SN-1,32';
    const result = commitImport(ws, readSheet(dupes), { classId: classId(ws, 'server'), mapping });
    assert.equal(result.summary.created, 1);
    assert.equal(result.summary.skipped, 1);
  });

  test('an import attributed to a source obeys that source trust rank', () => {
    const ws = newWorkspace();
    const authoritative = createDiscoverySource(ws, { key: 'vcenter', name: 'vCenter', trust_rank: 90 });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'from-vcenter' } }, { source: authoritative });

    const weak = createDiscoverySource(ws, { key: 'sheet', name: 'Spreadsheet', trust_rank: 30 });
    commitImport(ws, readSheet('hostname,serial_number\nfrom-spreadsheet,SN-1'), {
      classId: classId(ws, 'server'), mapping: { hostname: 'attr.hostname', serial_number: 'attr.serial_number' }, sourceId: weak.id,
    });

    const ci = db.prepare('SELECT id FROM assets WHERE workspace_id = ?').get(ws);
    assert.equal(readAttributes(ci.id).hostname, 'from-vcenter', 'a spreadsheet does not overrule the hypervisor');
  });

  test('an empty data file commits nothing rather than erroring', () => {
    const ws = newWorkspace();
    const result = commitImport(ws, { headers: ['hostname'], rows: [] }, {
      classId: classId(ws, 'server'), mapping: { hostname: 'attr.hostname' },
    });
    assert.equal(result.total, 0);
    assert.equal(result.summary.created, 0);
  });
});

describe('template and export', () => {
  test('a template names every column the class expects', () => {
    const ws = newWorkspace();
    const csv = templateFor(ws, classId(ws, 'server'));
    const headers = parseCsv(csv)[0];
    assert.ok(headers.includes('tag') && headers.includes('hostname') && headers.includes('serial_number'));
    assert.ok(headers.includes('environment'), 'inherited attributes are in the template too');
  });

  test('the template round-trips: its own example row imports cleanly', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    const csv = templateFor(ws, cls);
    const sheet = readSheet(csv);
    const preview = previewImport(ws, sheet, { classId: cls, mapping: guessMapping(ws, cls, sheet.headers) });
    assert.equal(preview.counts.error, 0, JSON.stringify(preview.rows[0]?.problems));
  });

  test('an export can be read back by the importer', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    commitImport(ws, readSheet('hostname,serial_number,cpu_cores\napp-01,SN-1,16'), {
      classId: cls, mapping: { hostname: 'attr.hostname', serial_number: 'attr.serial_number', cpu_cores: 'attr.cpu_cores' },
    });

    const exported = exportClass(ws, cls);
    const sheet = readSheet(exported);
    const preview = previewImport(ws, sheet, { classId: cls, mapping: guessMapping(ws, cls, sheet.headers) });
    assert.equal(preview.counts.update, 1, 'a round trip matches the CI it came from rather than creating a twin');
    assert.equal(preview.counts.create, 0);
  });

  test('an export quotes values that would otherwise break the file', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    const created = reconcile(ws, { ci_class: 'server', name: 'Box, with a comma', attributes: { hostname: 'app-01' } });
    assert.ok(created.ci);
    const grid = parseCsv(exportClass(ws, cls));
    assert.ok(grid.some((r) => r.includes('Box, with a comma')), 'survives the round trip intact');
  });
});
