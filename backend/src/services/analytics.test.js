import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  AnalyticsError, validateCardConfig, normaliseRange, resolveRange, runCard,
  createBoard, getBoard, listBoards, updateBoard, deleteBoard,
  addCard, updateCard, deleteCard, reorderCards, runBoard, analyticsMeta,
  CARD_TYPES, METRIC_KINDS,
} from './analyticsCards.js';
import { BOARD_TEMPLATES, templateBody } from './analyticsTemplates.js';
import { runTotals, runGrouped, periodsBetween } from './reportBuilder.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(ws, role = 'agent') {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, role + '-' + id.slice(-4), `${id}@x.local`, 'x', role);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active) VALUES (?,?,?,?,1)')
    .run(uid('wm'), ws, id, role);
  return { id, role, permissions: [] };
}

let ticketSeq = 0;
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  ticketSeq += 1;
  const row = {
    type: 'incident', title: 'T', status: 'open', priority: 'medium',
    team: 'Service Desk', category: 'Hardware', assignee_id: null,
    created_at: '2026-06-15 10:00:00', resolved_at: null, closed_at: null,
    sla_due_at: null, responded_at: null, response_due_at: null, source: 'portal',
    ...over,
  };
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, status, priority, team, category,
                          assignee_id, created_at, resolved_at, closed_at, sla_due_at, responded_at,
                          response_due_at, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, ws, `INC-${1000 + ticketSeq}`, row.type, row.title, row.status, row.priority, row.team,
    row.category, row.assignee_id, row.created_at, row.resolved_at, row.closed_at, row.sla_due_at,
    row.responded_at, row.response_due_at, row.source
  );
  return id;
}

describe('analytics: card configuration is validated before it is stored', () => {
  test('every card type in the registry can be configured', () => {
    // If a type is added to the registry without the validator learning about
    // it, the builder would offer a card that cannot be saved.
    const minimal = {
      scorecard: { metric: 'count' },
      trend: { metric: 'count', time_dim: 'month' },
      bar: { group_by: 'team', metrics: ['count'] },
      donut: { group_by: 'priority', metric: 'count' },
      table: { group_by: 'team', metrics: ['count'] },
      pivot: { row_dim: 'team', col_dim: 'priority' },
    };
    for (const key of Object.keys(CARD_TYPES)) {
      assert.ok(minimal[key], `no minimal config in this test for card type ${key}`);
      assert.doesNotThrow(() => validateCardConfig(key, minimal[key]), `${key} failed to validate`);
    }
  });

  test('there are six card types, each with a sane default span', () => {
    const keys = Object.keys(CARD_TYPES);
    assert.equal(keys.length, 6);
    for (const k of keys) {
      assert.ok(CARD_TYPES[k].defaultSpan >= 3 && CARD_TYPES[k].defaultSpan <= 12);
    }
  });

  test('an unknown metric or dimension is refused, with the field named', () => {
    assert.throws(() => validateCardConfig('scorecard', { metric: 'made_up' }), (e) => {
      assert.ok(e instanceof AnalyticsError);
      assert.equal(e.field_errors[0].field, 'metric');
      return true;
    });
    assert.throws(() => validateCardConfig('bar', { group_by: 'nonsense', metrics: ['count'] }), /Unknown grouping/);
  });

  test('a SQL expression cannot be smuggled in as a dimension', () => {
    // group_by reaches the query as an interpolated expression, so the
    // allowlist here is load-bearing rather than cosmetic.
    assert.throws(() => validateCardConfig('table', {
      group_by: "t.status) UNION SELECT password_hash, 1,1,1,1,1,1,1 FROM users --",
      metrics: ['count'],
    }), /Unknown grouping/);
  });

  test('a trend only accepts a time dimension for its x axis', () => {
    assert.throws(() => validateCardConfig('trend', { metric: 'count', time_dim: 'team' }), /Unknown grouping/);
    assert.doesNotThrow(() => validateCardConfig('trend', { metric: 'count', time_dim: 'week' }));
  });

  test('a heatmap refuses the same dimension on both axes', () => {
    assert.throws(() => validateCardConfig('pivot', { row_dim: 'team', col_dim: 'team' }), /two different dimensions/);
  });

  test('filters are reduced to the keys the query layer honours', () => {
    const cfg = validateCardConfig('scorecard', {
      metric: 'count',
      filters: { team: 'Network', priority: '', nonsense: 'x', assignee_id: 'usr_1' },
    });
    assert.deepEqual(Object.keys(cfg.filters).sort(), ['assignee_id', 'team']);
  });

  test('a table sorts by a metric it actually shows', () => {
    // Sorting by a column that was not selected silently did nothing.
    const cfg = validateCardConfig('table', { group_by: 'team', metrics: ['count'], sort_by: 'avg_csat' });
    assert.equal(cfg.sort_by, 'count');
  });

  test('metric lists are de-duplicated and capped', () => {
    const cfg = validateCardConfig('bar', {
      group_by: 'team',
      metrics: ['count', 'count', 'resolved', 'breached', 'avg_csat', 'avg_resolution_hours'],
    });
    assert.equal(cfg.metrics.length, 4);
    assert.equal(new Set(cfg.metrics).size, cfg.metrics.length);
  });

  test('limits are clamped rather than trusted', () => {
    assert.equal(validateCardConfig('donut', { group_by: 'team', metric: 'count', limit: 99999 }).limit, 50);
    assert.equal(validateCardConfig('donut', { group_by: 'team', metric: 'count', limit: -4 }).limit, 3);
  });
});

describe('analytics: periods', () => {
  test('a custom range needs both ends, in order', () => {
    assert.throws(() => normaliseRange({ preset: 'custom', from: '2026-01-01' }), /start and an end/);
    assert.throws(() => normaliseRange({ preset: 'custom', from: '2026-02-01', to: '2026-01-01' }), /after its end/i);
    assert.doesNotThrow(() => normaliseRange({ preset: 'custom', from: '2026-01-01', to: '2026-02-01' }));
  });

  test('all time means no date bounds at all, not a very old date', () => {
    // A sentinel like 1970-01-01 would quietly exclude anything older.
    assert.deepEqual(resolveRange({ preset: 'all_time' }), {});
  });

  test('a preset resolves to a real window', () => {
    const r = resolveRange({ preset: 'last_7_days' });
    assert.match(r.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.to, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.from < r.to);
  });

  test('empty periods are still listed, so a gap reads as a gap', () => {
    const months = periodsBetween('month', '2026-01-01', '2026-04-15');
    assert.deepEqual(months, ['2026-01', '2026-02', '2026-03', '2026-04']);
    const days = periodsBetween('day', '2026-03-01', '2026-03-04');
    assert.equal(days.length, 4);
  });

  test('a reversed range yields no periods rather than looping forever', () => {
    assert.deepEqual(periodsBetween('day', '2026-03-10', '2026-03-01'), []);
  });
});

describe('analytics: running cards against real rows', () => {
  test('a scorecard totals over the whole set, and averages are not averaged twice', () => {
    const ws = newWorkspace();
    // Two groups of very different size. Averaging each group's average would
    // weight the single slow ticket the same as the twenty fast ones.
    for (let i = 0; i < 20; i++) {
      newTicket(ws, { team: 'A', status: 'resolved', created_at: '2026-06-01 00:00:00', resolved_at: '2026-06-01 02:00:00' });
    }
    newTicket(ws, { team: 'B', status: 'resolved', created_at: '2026-06-01 00:00:00', resolved_at: '2026-06-05 00:00:00' });

    const card = { card_type: 'scorecard', config: validateCardConfig('scorecard', { metric: 'avg_resolution_hours', compare: false }) };
    const out = runCard(ws, card, { preset: 'all_time' });

    const grouped = runGrouped(ws, { dims: ['team'] });
    const naive = grouped.reduce((s, r) => s + r.avg_resolution_hours, 0) / grouped.length;
    const truth = runTotals(ws).avg_resolution_hours;

    assert.equal(out.value, truth);
    assert.ok(Math.abs(out.value - naive) > 10, 'the per-group mean should differ sharply here');
    assert.equal(out.kind, 'average');
  });

  test('a scorecard reports the previous period for comparison', () => {
    const ws = newWorkspace();
    newTicket(ws, { created_at: '2026-06-20 10:00:00' });
    const card = { card_type: 'scorecard', config: validateCardConfig('scorecard', { metric: 'count', compare: true }) };
    const out = runCard(ws, card, { preset: 'custom', from: '2026-06-01', to: '2026-06-30' });
    assert.equal(out.value, 1);
    assert.equal(out.previous, 0);
    assert.ok(out.previous_period.from < '2026-06-01');
  });

  test('a rising breach count is marked as the wrong direction', () => {
    const cfg = validateCardConfig('scorecard', { metric: 'breached' });
    const out = runCard(newWorkspace(), { card_type: 'scorecard', config: cfg }, { preset: 'all_time' });
    assert.equal(out.lower_is_better, true);
    assert.equal(METRIC_KINDS.breached, 'sum');
  });

  test('a trend fills the months where nothing happened with zero', () => {
    const ws = newWorkspace();
    newTicket(ws, { created_at: '2026-01-10 10:00:00' });
    newTicket(ws, { created_at: '2026-04-10 10:00:00' });
    const card = { card_type: 'trend', config: validateCardConfig('trend', { metric: 'count', time_dim: 'month' }) };
    const out = runCard(ws, card, { preset: 'custom', from: '2026-01-01', to: '2026-04-30' });
    assert.deepEqual(out.rows.map((r) => r.period), ['2026-01', '2026-02', '2026-03', '2026-04']);
    assert.deepEqual(out.rows.map((r) => r.value), [1, 0, 0, 1]);
  });

  test('a trend split into series gives every series a value in every period', () => {
    const ws = newWorkspace();
    newTicket(ws, { created_at: '2026-01-10 10:00:00', priority: 'high' });
    newTicket(ws, { created_at: '2026-02-10 10:00:00', priority: 'low' });
    const card = { card_type: 'trend', config: validateCardConfig('trend', { metric: 'count', time_dim: 'month', series_dim: 'priority' }) };
    const out = runCard(ws, card, { preset: 'custom', from: '2026-01-01', to: '2026-02-28' });
    assert.deepEqual(out.series.sort(), ['high', 'low']);
    for (const row of out.rows) {
      for (const s of out.series) assert.equal(typeof row[s], 'number');
    }
    assert.equal(out.rows.find((r) => r.period === '2026-01').low, 0);
  });

  test('a donut past its limit keeps the remainder as "Other" so the parts still sum', () => {
    const ws = newWorkspace();
    for (const c of ['A', 'B', 'C', 'D', 'E', 'F']) newTicket(ws, { category: c });
    const card = { card_type: 'donut', config: validateCardConfig('donut', { group_by: 'category', metric: 'count', limit: 3 }) };
    const out = runCard(ws, card, { preset: 'all_time' });
    assert.equal(out.rows.length, 4);
    assert.match(out.rows.at(-1).group_key, /^Other/);
    assert.equal(out.rows.reduce((s, r) => s + r.value, 0), 6);
    assert.equal(out.total, 6);
  });

  test('"Other" never fabricates an average', () => {
    // Summing averages is meaningless, so the rolled-up row reports none.
    const ws = newWorkspace();
    for (const c of ['A', 'B', 'C', 'D']) {
      newTicket(ws, { category: c, status: 'resolved', created_at: '2026-06-01 00:00:00', resolved_at: '2026-06-01 05:00:00' });
    }
    const card = { card_type: 'bar', config: validateCardConfig('bar', { group_by: 'category', metrics: ['count', 'avg_resolution_hours'], limit: 3 }) };
    const out = runCard(ws, card, { preset: 'all_time' });
    const other = out.rows.find((r) => r.is_other);
    assert.ok(other);
    assert.equal(other.avg_resolution_hours, null);
    assert.equal(other.count, 1);
  });

  test('a table sorts and limits, and says how many rows there really were', () => {
    const ws = newWorkspace();
    for (let i = 0; i < 3; i++) newTicket(ws, { team: 'Busy' });
    newTicket(ws, { team: 'Quiet' });
    const card = { card_type: 'table', config: validateCardConfig('table', { group_by: 'team', metrics: ['count'], sort_by: 'count', sort_dir: 'desc', limit: 3 }) };
    const out = runCard(ws, card, { preset: 'all_time' });
    assert.equal(out.rows[0].group_key, 'Busy');
    assert.equal(out.rows[0].count, 3);
    assert.equal(out.total_rows, 2);
  });

  test('a heatmap crosses two dimensions and totals both ways', () => {
    const ws = newWorkspace();
    newTicket(ws, { team: 'A', priority: 'high' });
    newTicket(ws, { team: 'A', priority: 'low' });
    newTicket(ws, { team: 'B', priority: 'high' });
    const card = { card_type: 'pivot', config: validateCardConfig('pivot', { row_dim: 'team', col_dim: 'priority' }) };
    const out = runCard(ws, card, { preset: 'all_time' });
    assert.equal(out.grandTotal, 3);
    assert.equal(out.rowTotals.A, 2);
    assert.equal(out.colTotals.high, 2);
  });

  test("a card's own period overrides the board's", () => {
    const ws = newWorkspace();
    newTicket(ws, { created_at: '2020-01-01 10:00:00' });
    const cfg = validateCardConfig('scorecard', { metric: 'count', compare: false, date_range: { preset: 'all_time' } });
    const out = runCard(ws, { card_type: 'scorecard', config: cfg }, { preset: 'last_7_days' });
    assert.equal(out.value, 1, "the card's all-time window should win over the board's last 7 days");
  });

  test('an empty period counts as zero, not as unknown', () => {
    // SUM over no rows is NULL in SQL. Left as null, a scorecard comparing
    // against a quiet period silently dropped its trend line, and a chart
    // drew a gap where the truth was a floor.
    const ws = newWorkspace();
    const totals = runTotals(ws, { from: '2026-01-01', to: '2026-01-31' });
    assert.equal(totals.count, 0);
    assert.equal(totals.resolved, 0, 'nothing resolved is zero resolved');
    assert.equal(totals.breached, 0, 'nothing breached is zero breached');
    // An average of nothing genuinely has no value, and 0 would claim an
    // instant resolution.
    assert.equal(totals.avg_resolution_hours, null);
    assert.equal(totals.avg_csat, null);
  });

  test('a scorecard still shows its comparison when the previous period was empty', () => {
    const ws = newWorkspace();
    newTicket(ws, { created_at: '2026-06-20 10:00:00', status: 'resolved', resolved_at: '2026-06-21 10:00:00' });
    const card = { card_type: 'scorecard', config: validateCardConfig('scorecard', { metric: 'resolved', compare: true }) };
    const out = runCard(ws, card, { preset: 'custom', from: '2026-06-01', to: '2026-06-30' });
    assert.equal(out.value, 1);
    assert.equal(out.previous, 0, 'the quiet period before should read as zero, not null');
  });

  test('a card only ever sees its own workspace', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    newTicket(a, {});
    newTicket(b, {});
    newTicket(b, {});
    const cfg = validateCardConfig('scorecard', { metric: 'count', compare: false });
    assert.equal(runCard(a, { card_type: 'scorecard', config: cfg }, { preset: 'all_time' }).value, 1);
    assert.equal(runCard(b, { card_type: 'scorecard', config: cfg }, { preset: 'all_time' }).value, 2);
  });
});

describe('analytics: boards', () => {
  test('a board is created with its cards in one call, in order', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const board = createBoard(ws, user, {
      name: 'My report',
      date_range: { preset: 'last_30_days' },
      cards: [
        { title: 'One', card_type: 'scorecard', config: { metric: 'count' } },
        { title: 'Two', card_type: 'bar', config: { group_by: 'team', metrics: ['count'] } },
      ],
    });
    assert.equal(board.cards.length, 2);
    assert.deepEqual(board.cards.map((c) => c.title), ['One', 'Two']);
    assert.deepEqual(board.cards.map((c) => c.position), [0, 1]);
  });

  test('a board needs a name', () => {
    const ws = newWorkspace();
    assert.throws(() => createBoard(ws, newUser(ws), { name: '   ' }), /Give the report a name/);
  });

  test('a private board is invisible to everyone else, and reads as missing', () => {
    const ws = newWorkspace();
    const author = newUser(ws, 'agent');
    const other = newUser(ws, 'agent');
    const board = createBoard(ws, author, { name: 'Mine only', visibility: 'private' });

    assert.equal(listBoards(ws, author).length, 1);
    assert.equal(listBoards(ws, other).length, 0);
    // 404 rather than 403: that the report exists is itself not shared.
    assert.throws(() => getBoard(ws, board.id, other), (e) => e.status === 404);
  });

  test('only the author or an admin can change a board', () => {
    const ws = newWorkspace();
    const author = newUser(ws, 'agent');
    const other = newUser(ws, 'agent');
    const boss = newUser(ws, 'admin');
    const board = createBoard(ws, author, { name: 'Shared' });

    assert.throws(() => updateBoard(ws, board.id, other, { name: 'Hijacked' }), (e) => e.status === 403);
    assert.doesNotThrow(() => updateBoard(ws, board.id, boss, { name: 'Renamed by admin' }));
    assert.equal(getBoard(ws, board.id, author).name, 'Renamed by admin');
  });

  test('a board from another workspace cannot be reached', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    const board = createBoard(a, newUser(a), { name: 'A only' });
    assert.throws(() => getBoard(b, board.id, newUser(b)), (e) => e.status === 404);
  });

  test('deleting a board takes its cards with it', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const board = createBoard(ws, user, {
      name: 'Doomed',
      cards: [{ card_type: 'scorecard', config: { metric: 'count' } }],
    });
    const cardId = board.cards[0].id;
    deleteBoard(ws, board.id, user);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM analytics_cards WHERE id = ?').get(cardId).c, 0);
  });

  test('cards can be added, retyped and removed', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const board = createBoard(ws, user, { name: 'Board' });

    const card = addCard(ws, board.id, user, { card_type: 'scorecard', config: { metric: 'count' } });
    assert.equal(card.card_type, 'scorecard');

    // Retyping revalidates against the new type, so leftover configuration
    // from the old one cannot survive.
    const retyped = updateCard(ws, card.id, user, {
      card_type: 'bar',
      config: { group_by: 'team', metrics: ['count'] },
    });
    assert.equal(retyped.card_type, 'bar');
    assert.equal(retyped.config.group_by, 'team');
    assert.ok(!('metric' in retyped.config));

    deleteCard(ws, card.id, user);
    assert.equal(getBoard(ws, board.id, user).cards.length, 0);
  });

  test('retyping a card to something its config cannot satisfy is refused', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const board = createBoard(ws, user, { name: 'Board' });
    const card = addCard(ws, board.id, user, { card_type: 'scorecard', config: { metric: 'count' } });
    // A pivot needs two dimensions, which a scorecard's config has none of.
    assert.throws(() => updateCard(ws, card.id, user, { card_type: 'pivot' }), (e) => e.status === 400);
  });

  test('reordering rewrites the whole order', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const board = createBoard(ws, user, {
      name: 'Board',
      cards: [
        { title: 'A', card_type: 'scorecard', config: { metric: 'count' } },
        { title: 'B', card_type: 'scorecard', config: { metric: 'resolved' } },
        { title: 'C', card_type: 'scorecard', config: { metric: 'breached' } },
      ],
    });
    const [a, b, c] = board.cards.map((x) => x.id);
    const after = reorderCards(ws, board.id, user, [c, a, b]);
    assert.deepEqual(after.cards.map((x) => x.title), ['C', 'A', 'B']);
  });

  test("reordering refuses a card that is not on the board", () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const one = createBoard(ws, user, { name: 'One', cards: [{ card_type: 'scorecard', config: { metric: 'count' } }] });
    const two = createBoard(ws, user, { name: 'Two', cards: [{ card_type: 'scorecard', config: { metric: 'count' } }] });
    assert.throws(() => reorderCards(ws, one.id, user, [two.cards[0].id]), /not on this report/);
  });

  test('one broken card does not blank out the rest of the board', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    const board = createBoard(ws, user, {
      name: 'Board',
      cards: [
        { title: 'Fine', card_type: 'scorecard', config: { metric: 'count' } },
        { title: 'Also fine', card_type: 'bar', config: { group_by: 'team', metrics: ['count'] } },
      ],
    });
    // Corrupt one card's stored config behind the service's back, the way a
    // hand-edited row or a future schema change could.
    db.prepare('UPDATE analytics_cards SET config = ? WHERE id = ?')
      .run(JSON.stringify({ group_by: 'no_such_dimension', metrics: ['count'] }), board.cards[1].id);

    const results = runBoard(ws, getBoard(ws, board.id, user));
    assert.equal(results.length, 2);
    assert.ok(results[0].data, 'the healthy card still rendered');
    assert.ok(results[1].error, 'the broken card reported its own error');
  });

  test('a board run returns one result per card, keyed by card id', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    newTicket(ws, {});
    const board = createBoard(ws, user, {
      name: 'Board',
      date_range: { preset: 'all_time' },
      cards: [
        { card_type: 'scorecard', config: { metric: 'count' } },
        { card_type: 'donut', config: { group_by: 'priority', metric: 'count' } },
      ],
    });
    const results = runBoard(ws, getBoard(ws, board.id, user));
    assert.deepEqual(results.map((r) => r.id), board.cards.map((c) => c.id));
    assert.equal(results[0].data.value, 1);
  });

  test('changing the board period re-frames its cards without touching them', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    newTicket(ws, { created_at: '2020-05-05 10:00:00' });
    const board = createBoard(ws, user, {
      name: 'Board',
      date_range: { preset: 'last_7_days' },
      cards: [{ card_type: 'scorecard', config: { metric: 'count' } }],
    });
    assert.equal(runBoard(ws, getBoard(ws, board.id, user))[0].data.value, 0);

    updateBoard(ws, board.id, user, { date_range: { preset: 'all_time' } });
    const after = getBoard(ws, board.id, user);
    assert.equal(after.cards.length, 1, 'the cards themselves were not rewritten');
    assert.equal(runBoard(ws, after)[0].data.value, 1);
  });
});

describe('analytics: templates and metadata', () => {
  test('every template builds a board whose every card validates and runs', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'agent');
    newTicket(ws, { assignee_id: user.id, status: 'resolved', resolved_at: '2026-06-16 10:00:00' });

    for (const tpl of BOARD_TEMPLATES) {
      const board = createBoard(ws, user, templateBody(tpl, null));
      assert.equal(board.cards.length, tpl.cards.length, `${tpl.key} lost cards on creation`);
      const results = runBoard(ws, board);
      const broken = results.filter((r) => r.error);
      assert.deepEqual(broken, [], `${tpl.key} has cards that do not run: ${JSON.stringify(broken)}`);
    }
  });

  test('the overview template still covers what the old fixed page showed', () => {
    const overview = BOARD_TEMPLATES.find((t) => t.key === 'overview');
    const types = new Set(overview.cards.map((c) => c.card_type));
    // Volume, trend, a breakdown and the agent table all had a panel before.
    assert.ok(types.has('scorecard') && types.has('trend') && types.has('table'));
    assert.ok(overview.cards.some((c) => c.config.group_by === 'assignee'));
  });

  test('metadata offers exactly what the validator accepts', () => {
    const meta = analyticsMeta();
    assert.equal(meta.card_types.length, 6);
    for (const m of meta.metrics) assert.ok(m.kind, `${m.key} has no roll-up kind`);
    for (const d of meta.dimensions) {
      assert.doesNotThrow(() => validateCardConfig('table', { group_by: d.key, metrics: ['count'] }),
        `dimension ${d.key} is offered but rejected`);
    }
    for (const t of meta.time_dimensions) {
      assert.doesNotThrow(() => validateCardConfig('trend', { metric: 'count', time_dim: t }),
        `time dimension ${t} is offered but rejected`);
    }
    for (const p of meta.date_presets) {
      if (p.key === 'custom') continue;
      assert.doesNotThrow(() => resolveRange({ preset: p.key }), `preset ${p.key} is offered but cannot resolve`);
    }
  });
});
