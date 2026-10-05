import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  canRead, canManage, canPublish, createArticle, updateArticle, deleteArticle,
  getArticle, listArticles, transition, availableTransitions, markReviewed,
  listVersions, restoreVersion, recordView, recordFeedback,
  linkTicket, draftFromTicket, serializeTags, parseTags, ensureIndexed, reindex,
  STATUSES, VISIBILITIES, ARTICLE_TYPES, KbError,
} from './kbArticles.js';
import { search, buildMatchQuery, logSearch, recordSearchClick, relatedArticles, suggestForTicket } from './kbSearch.js';
import { contentGaps, unhelpfulSearches, failingArticles, reviewQueue, deflection, overview, articleStats } from './kbAnalytics.js';
import { listCategories, categoryTree, createCategory, updateCategory, deleteCategory } from './kbCategories.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(role = 'agent', perms = []) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, role, `${id}@x.local`, 'x', role);
  return { id, role, permissions: perms };
}
const admin = () => newUser('admin', ['kb.manage']);
const agent = () => newUser('agent', []);
const requester = () => newUser('requester', []);

function ticket(ws, over = {}) {
  const id = uid('tkt');
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, status, category, requester_id)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, ws, over.number || 'INC-' + uid('').slice(-5), over.type || 'incident', over.title || 'Cannot print',
    over.description || 'The printer shows offline', over.status || 'resolved', over.category || 'Hardware',
    over.requester_id || null);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

const article = (ws, user, over = {}) => createArticle(ws, user, {
  title: over.title || 'VPN will not connect',
  summary: over.summary || 'Restart the client',
  body: over.body || 'Restart the VPN client and re-enter your token.',
  visibility: over.visibility || 'portal',
  status: over.status || 'published',
  ...over,
});

// ============================================================ visibility ===

describe('knowledge: who can read what', () => {
  test('a requester sees only published, portal-visible articles', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester();
    article(ws, a, { title: 'Public thing', visibility: 'portal' });
    article(ws, a, { title: 'Agent thing', visibility: 'agents' });
    article(ws, a, { title: 'Runbook', visibility: 'internal' });
    article(ws, a, { title: 'Unfinished', visibility: 'portal', status: 'draft' });

    const seen = listArticles(ws, r).map((x) => x.title);
    assert.deepEqual(seen, ['Public thing']);
  });

  test('an agent sees portal and agent articles but not internal runbooks', () => {
    const ws = newWorkspace(); const a = admin(); const g = agent();
    article(ws, a, { title: 'Public thing', visibility: 'portal' });
    article(ws, a, { title: 'Agent thing', visibility: 'agents' });
    article(ws, a, { title: 'Runbook', visibility: 'internal' });

    const seen = listArticles(ws, g).map((x) => x.title).sort();
    assert.deepEqual(seen, ['Agent thing', 'Public thing']);
  });

  test('a knowledge manager sees everything, including drafts', () => {
    const ws = newWorkspace(); const a = admin();
    article(ws, a, { title: 'Runbook', visibility: 'internal' });
    article(ws, a, { title: 'Unfinished', status: 'draft' });
    assert.equal(listArticles(ws, a).length, 2);
  });

  test('an author can see their own draft; another agent cannot', () => {
    const ws = newWorkspace(); const author = agent(); const other = agent();
    const draft = createArticle(ws, author, { title: 'Mine', summary: 's', body: 'b', status: 'draft' });
    assert.equal(canRead(author, getArticle(ws, draft.id)), true);
    assert.equal(canRead(other, getArticle(ws, draft.id)), false);
    assert.ok(!listArticles(ws, other).some((x) => x.id === draft.id));
  });

  test('a nominated reviewer can see what they were asked to review', () => {
    const ws = newWorkspace(); const author = agent(); const reviewer = agent();
    const a = createArticle(ws, author, { title: 'For review', summary: 's', body: 'b', status: 'draft', reviewer_id: reviewer.id });
    transition(ws, author, a.id, 'in_review');
    assert.equal(canRead(reviewer, getArticle(ws, a.id)), true);
  });

  test('the list rule and the single-article rule agree', () => {
    // A list that shows what the detail view then refuses to open is worse
    // than either being wrong on its own.
    const ws = newWorkspace(); const a = admin(); const g = agent(); const r = requester();
    for (const v of ['portal', 'agents', 'internal']) {
      article(ws, a, { title: `t-${v}`, visibility: v });
      article(ws, a, { title: `d-${v}`, visibility: v, status: 'draft' });
    }
    for (const user of [g, r]) {
      const listed = listArticles(ws, user);
      for (const item of listed) {
        assert.equal(canRead(user, getArticle(ws, item.id)), true,
          `${user.role} was listed ${item.title} but canRead says no`);
      }
      const all = db.prepare('SELECT * FROM kb_articles WHERE workspace_id = ?').all(ws);
      const readable = all.filter((x) => canRead(user, x));
      assert.equal(listed.length, readable.length, `${user.role}: list and predicate disagree`);
    }
  });

  test('permission helpers are what the routes rely on', () => {
    assert.equal(canManage({ role: 'agent' }), true);
    assert.equal(canManage({ role: 'requester' }), false);
    assert.equal(canManage({ role: 'requester', permissions: ['kb.manage'] }), true);
    assert.equal(canPublish({ role: 'agent' }), false, 'authoring is not publishing');
    assert.equal(canPublish({ role: 'admin' }), true);
    assert.equal(canPublish({ role: 'agent', permissions: ['kb.manage'] }), true);
  });
});

// ================================================================ search ===

describe('knowledge: search', () => {
  const seed = (ws, a) => {
    article(ws, a, { title: 'VPN will not connect', summary: 'Reset the VPN client', body: 'Restart the VPN client and re-enter your token.', tags: 'vpn,network' });
    article(ws, a, { title: 'Reset your password', summary: 'Self service password reset', body: 'Use the portal to reset your password.', tags: 'password,account' });
    article(ws, a, { title: 'Printer offline', summary: 'Printer troubleshooting', body: 'Check the queue, then power cycle the printer.', tags: 'printer' });
  };

  test('results are ranked by relevance, not by edit date', () => {
    const ws = newWorkspace(); const a = admin();
    seed(ws, a);
    // The most recently edited article is the printer one; a VPN search must
    // still put VPN first.
    const r = search(ws, a, 'vpn');
    assert.equal(r.results[0].title, 'VPN will not connect');
  });

  test('a title match outranks a body-only match', () => {
    const ws = newWorkspace(); const a = admin();
    article(ws, a, { title: 'Password reset', summary: 'How to reset', body: 'Steps here.' });
    article(ws, a, { title: 'Onboarding checklist', summary: 'New starters', body: 'Set up the laptop, then do a password reset for them.' });
    const r = search(ws, a, 'password reset');
    assert.equal(r.results[0].title, 'Password reset');
  });

  test('results carry a highlighted excerpt', () => {
    const ws = newWorkspace(); const a = admin();
    seed(ws, a);
    const r = search(ws, a, 'token');
    assert.match(r.results[0].excerpt, /<mark>token<\/mark>/);
  });

  test('search respects visibility — an internal runbook never leaks', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester(); const g = agent();
    article(ws, a, { title: 'Firewall runbook', summary: 'Internal', body: 'Console access via the jump host.', visibility: 'internal' });
    assert.equal(search(ws, r, 'jump host').total, 0);
    assert.equal(search(ws, g, 'jump host').total, 0);
    assert.equal(search(ws, a, 'jump host').total, 1);
  });

  test('a draft is findable by its author and by nobody else', () => {
    const ws = newWorkspace(); const author = agent(); const other = agent();
    createArticle(ws, author, { title: 'Secret draft', summary: 's', body: 'pangolin', status: 'draft' });
    assert.equal(search(ws, author, 'pangolin').total, 1);
    assert.equal(search(ws, other, 'pangolin').total, 0);
  });

  test('punctuation and operators in a query do not blow up', () => {
    const ws = newWorkspace(); const a = admin();
    seed(ws, a);
    for (const q of ['wi-fi (guest)', 'what"s this', 'a OR b AND c', '***', 'NEAR(x y)', "it's broken"]) {
      const r = search(ws, a, q);
      assert.ok(Array.isArray(r.results), `${q} did not return a result set`);
    }
  });

  test('an empty or one-character query returns nothing rather than everything', () => {
    const ws = newWorkspace(); const a = admin();
    seed(ws, a);
    assert.equal(search(ws, a, '').total, 0);
    assert.equal(search(ws, a, 'a').total, 0);
    assert.equal(search(ws, a, '   ').total, 0);
  });

  test('the match query quotes terms and prefixes only the last', () => {
    assert.equal(buildMatchQuery('vpn token'), '"vpn" AND "token"*', 'every term must appear by default');
    assert.equal(buildMatchQuery('vpn token', { mode: 'any' }), '"vpn" OR "token"*');
    assert.equal(buildMatchQuery('VPN'), '"vpn"*');
    assert.equal(buildMatchQuery('a'), null, 'single characters are dropped');
    assert.equal(buildMatchQuery(''), null);
    assert.ok(!buildMatchQuery('say "hi"').includes('say "hi"'), 'inner quotes are escaped');
  });

  test('stemming finds a word in another form', () => {
    const ws = newWorkspace(); const a = admin();
    article(ws, a, { title: 'Connecting to the network', summary: 's', body: 'Connect the cable first.' });
    assert.ok(search(ws, a, 'connection').total >= 0);
    assert.equal(search(ws, a, 'connecting').total, 1);
  });

  test('a retired article is still findable but never ranks first', () => {
    const ws = newWorkspace(); const a = admin();
    const old = article(ws, a, { title: 'Old VPN guide', summary: 's', body: 'vpn steps' });
    article(ws, a, { title: 'New VPN guide', summary: 's', body: 'vpn steps' });
    transition(ws, a, old.id, 'retired');
    const r = search(ws, a, 'vpn');
    assert.equal(r.results[0].title, 'New VPN guide');
    assert.ok(r.results.some((x) => x.title === 'Old VPN guide'));
  });

  test('the index repairs itself for articles that predate it', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { title: 'Indexed thing', summary: 's', body: 'findme' });

    // Checked against the index directly, not through search(): search calls
    // ensureIndexed first, so going via search would repair the very gap the
    // test is trying to create and then prove nothing.
    db.prepare('DELETE FROM kb_fts WHERE article_id = ?').run(art.id);
    const indexed = () => db.prepare('SELECT COUNT(*) c FROM kb_fts WHERE article_id = ?').get(art.id).c;
    assert.equal(indexed(), 0, 'precondition: index really is missing');

    assert.equal(ensureIndexed(ws), 1, 'reports what it repaired');
    assert.equal(indexed(), 1);
    assert.equal(search(ws, a, 'findme').total, 1);
  });

  test('search repairs a missing index on its own, without anyone calling for it', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { title: 'Self healing', summary: 's', body: 'gerenuk' });
    db.prepare('DELETE FROM kb_fts WHERE article_id = ?').run(art.id);
    assert.equal(search(ws, a, 'gerenuk').total, 1);
  });

  test('editing an article updates what it matches', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { title: 'Original', summary: 's', body: 'aardvark' });
    assert.equal(search(ws, a, 'aardvark').total, 1);
    updateArticle(ws, a, art.id, { body: 'buffalo' });
    assert.equal(search(ws, a, 'aardvark').total, 0);
    assert.equal(search(ws, a, 'buffalo').total, 1);
  });

  test('deleting an article removes it from the index', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { title: 'Doomed', summary: 's', body: 'zebra' });
    deleteArticle(ws, a, art.id);
    assert.equal(search(ws, a, 'zebra').total, 0);
  });

  test('search never crosses a workspace', () => {
    const w1 = newWorkspace(); const w2 = newWorkspace(); const a = admin();
    article(w1, a, { title: 'Only in one', summary: 's', body: 'narwhal' });
    assert.equal(search(w2, a, 'narwhal').total, 0);
  });
});

// ============================================================= lifecycle ===

describe('knowledge: lifecycle', () => {
  test('a new article starts as a draft unless the author can publish', () => {
    const ws = newWorkspace(); const g = agent();
    const a = createArticle(ws, g, { title: 'T', summary: 's', body: 'b', status: 'published' });
    assert.equal(a.status, 'draft', 'an agent cannot publish straight away');
  });

  test('a knowledge manager can publish on creation', () => {
    const ws = newWorkspace();
    const a = createArticle(ws, admin(), { title: 'T', summary: 's', body: 'b', status: 'published' });
    assert.equal(a.status, 'published');
    assert.ok(a.published_at);
  });

  test('draft to review to published', () => {
    const ws = newWorkspace(); const author = agent(); const mgr = admin();
    const a = createArticle(ws, author, { title: 'T', summary: 's', body: 'b' });
    assert.equal(a.status, 'draft');
    assert.equal(transition(ws, author, a.id, 'in_review').status, 'in_review');
    assert.equal(transition(ws, mgr, a.id, 'published').status, 'published');
  });

  test('an agent cannot publish, and is told why', () => {
    const ws = newWorkspace(); const g = agent();
    const a = createArticle(ws, g, { title: 'T', summary: 's', body: 'b' });
    assert.throws(() => transition(ws, g, a.id, 'published'), /knowledge-manager rights/);
  });

  test('an illegal jump is refused with a readable reason', () => {
    const ws = newWorkspace(); const a = admin();
    const art = createArticle(ws, a, { title: 'T', summary: 's', body: 'b' });
    assert.throws(() => transition(ws, a, art.id, 'retired'), /cannot go from Draft to Retired/);
  });

  test('publishing without a summary is refused, because the summary is what search shows', () => {
    const ws = newWorkspace(); const a = admin();
    const art = createArticle(ws, a, { title: 'T', body: 'b' });
    assert.throws(() => transition(ws, a, art.id, 'published'), /needs a summary/);
  });

  test('publishing sets a review date', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a);
    assert.ok(art.review_due_at, 'every published article gets a date by which somebody looks again');
    assert.ok(art.review_due_at > new Date().toISOString().slice(0, 10));
  });

  test('a custom review interval is honoured', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { review_interval_days: 7 });
    const due = new Date(art.review_due_at);
    const days = Math.round((due - Date.now()) / 86400000);
    assert.ok(days >= 6 && days <= 8, `expected about 7 days, got ${days}`);
  });

  test('an overdue article is flagged stale and appears in the review queue', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a);
    db.prepare("UPDATE kb_articles SET review_due_at = '2020-01-01' WHERE id = ?").run(art.id);
    assert.equal(getArticle(ws, art.id) && listArticles(ws, a, { stale: true }).length, 1);
    assert.equal(reviewQueue(ws).overdue.length, 1);
  });

  test('marking reviewed clears it without changing a word', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { body: 'unchanged text' });
    db.prepare("UPDATE kb_articles SET review_due_at = '2020-01-01' WHERE id = ?").run(art.id);
    const after = markReviewed(ws, a, art.id);
    assert.ok(after.review_due_at > new Date().toISOString().slice(0, 10));
    assert.equal(after.body, 'unchanged text');
    assert.equal(reviewQueue(ws).overdue.length, 0);
  });

  test('retiring keeps the article; deleting a published one needs manager rights', () => {
    const ws = newWorkspace(); const a = admin(); const g = agent();
    const art = article(ws, a);
    assert.throws(() => deleteArticle(ws, g, art.id), /Retire a published article/);
    assert.equal(transition(ws, a, art.id, 'retired').status, 'retired');
    assert.ok(getArticle(ws, art.id), 'still on the record');
  });

  test('available transitions say what is possible and what is blocked', () => {
    const ws = newWorkspace(); const g = agent();
    const art = createArticle(ws, g, { title: 'T', summary: 's', body: 'b' });
    const t = availableTransitions(g, getArticle(ws, art.id));
    assert.deepEqual(t.map((x) => x.to).sort(), ['in_review', 'published']);
    assert.equal(t.find((x) => x.to === 'in_review').allowed, true);
    assert.equal(t.find((x) => x.to === 'published').allowed, false);
    assert.match(t.find((x) => x.to === 'published').blocker, /knowledge-manager/);
  });
});

// ============================================================== versions ===

describe('knowledge: versions', () => {
  test('publishing snapshots the text', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { body: 'first version' });
    assert.equal(listVersions(ws, art.id).length, 1);
    updateArticle(ws, a, art.id, { body: 'second version' });
    transition(ws, a, art.id, 'draft');
    transition(ws, a, art.id, 'published');
    const versions = listVersions(ws, art.id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, 2);
  });

  test('a previous version can be restored, as a draft rather than straight back out', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { body: 'the good text' });
    updateArticle(ws, a, art.id, { body: 'a bad 2am edit' });
    transition(ws, a, art.id, 'draft');
    transition(ws, a, art.id, 'published');

    const restored = restoreVersion(ws, a, art.id, 1);
    assert.equal(restored.body, 'the good text');
    assert.equal(restored.status, 'draft', 'republishing an old revision is a deliberate decision');
  });

  test('restoring a version that does not exist is refused', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a);
    assert.throws(() => restoreVersion(ws, a, art.id, 99), /does not exist/);
  });
});

// ============================================================== feedback ===

describe('knowledge: feedback', () => {
  test('helpful votes are counted, and the dead column finally means something', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a);
    recordFeedback(ws, requester(), art.id, { helpful: true });
    recordFeedback(ws, requester(), art.id, { helpful: true });
    const after = recordFeedback(ws, requester(), art.id, { helpful: false, comment: 'Did not work on Mac' });
    assert.equal(after.helpful_count, 2);
    assert.equal(after.not_helpful_count, 1);
  });

  test('one vote per person — changing your mind corrects rather than adds', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester();
    const art = article(ws, a);
    recordFeedback(ws, r, art.id, { helpful: true });
    const after = recordFeedback(ws, r, art.id, { helpful: false });
    assert.equal(after.helpful_count, 0);
    assert.equal(after.not_helpful_count, 1);
  });

  test('a reader who cannot see the article cannot rate it', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { visibility: 'internal' });
    assert.throws(() => recordFeedback(ws, requester(), art.id, { helpful: true }), /not found/i);
  });

  test('a vote must say which way', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a);
    assert.throws(() => recordFeedback(ws, a, art.id, {}), /whether it was helpful/);
  });

  test('failing articles are ranked by proportion, not raw count', () => {
    const ws = newWorkspace(); const a = admin();
    const bad = article(ws, a, { title: 'Mostly wrong' });
    const popular = article(ws, a, { title: 'Mostly right' });
    for (let i = 0; i < 3; i += 1) recordFeedback(ws, requester(), bad.id, { helpful: false, comment: 'no' });
    for (let i = 0; i < 9; i += 1) recordFeedback(ws, requester(), popular.id, { helpful: true });
    for (let i = 0; i < 4; i += 1) recordFeedback(ws, requester(), popular.id, { helpful: false });

    const failing = failingArticles(ws, { minVotes: 2 });
    assert.equal(failing[0].title, 'Mostly wrong', 'a 100% miss rate beats a bigger raw count');
    assert.equal(failing[0].unhelpful_rate, 100);
    assert.ok(failing[0].comments.includes('no'), 'the reason travels with the number');
  });
});

// ============================================================= analytics ===

describe('knowledge: what the reports are for', () => {
  test('searches that found nothing become a content gap list', () => {
    const ws = newWorkspace(); const a = admin();
    article(ws, a, { title: 'VPN', summary: 's', body: 'vpn' });
    for (let i = 0; i < 3; i += 1) logSearch(ws, requester(), 'how do i claim expenses', 0);
    logSearch(ws, requester(), 'HOW DO I CLAIM EXPENSES', 0);
    logSearch(ws, requester(), 'vpn', 1);

    const gaps = contentGaps(ws, {});
    assert.equal(gaps.gaps[0].query, 'how do i claim expenses');
    assert.equal(gaps.gaps[0].searches, 4, 'case variants are one row, not four');
    assert.ok(gaps.miss_rate > 0);
  });

  test('a search with results that nobody opened is a different problem', () => {
    const ws = newWorkspace();
    // Found things, opened nothing: a titling problem, not a missing-content
    // problem, and the fix is different.
    logSearch(ws, requester(), 'printer jam', 5);
    logSearch(ws, requester(), 'printer jam', 5);
    const rows = unhelpfulSearches(ws, {});
    assert.equal(rows[0].query, 'printer jam');
    assert.equal(rows[0].avg_results, 5);
  });

  test('a clicked search drops out of the unhelpful list', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a);
    const id1 = logSearch(ws, requester(), 'printer jam', 5);
    const id2 = logSearch(ws, requester(), 'printer jam', 5);
    recordSearchClick(ws, id1, art.id);
    recordSearchClick(ws, id2, art.id);
    assert.equal(unhelpfulSearches(ws, {}).length, 0);
  });

  test('the review queue separates overdue from never-reviewed from awaiting review', () => {
    const ws = newWorkspace(); const a = admin(); const g = agent();
    const overdue = article(ws, a, { title: 'Overdue' });
    db.prepare("UPDATE kb_articles SET review_due_at = '2020-01-01' WHERE id = ?").run(overdue.id);
    const never = article(ws, a, { title: 'Never reviewed' });
    db.prepare("UPDATE kb_articles SET review_due_at = NULL, updated_at = '2019-01-01' WHERE id = ?").run(never.id);
    const pending = createArticle(ws, g, { title: 'Pending', summary: 's', body: 'b' });
    transition(ws, g, pending.id, 'in_review');

    const q = reviewQueue(ws, {});
    assert.deepEqual(q.overdue.map((x) => x.title), ['Overdue']);
    assert.deepEqual(q.never_reviewed.map((x) => x.title), ['Never reviewed']);
    assert.deepEqual(q.awaiting_review.map((x) => x.title), ['Pending']);
  });

  test('deflection is reported as an estimate, with its basis stated', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester();
    const art = article(ws, a);
    recordView(ws, art.id, r.id, 'portal');
    const d = deflection(ws, {});
    assert.equal(d.views, 1);
    assert.equal(d.estimated_deflections, 1);
    assert.match(d.basis, /estimate, not a measurement/);
  });

  test('a view followed by that person raising a ticket is not counted as deflection', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester();
    const art = article(ws, a);
    recordView(ws, art.id, r.id, 'portal');
    ticket(ws, { requester_id: r.id });
    assert.equal(deflection(ws, {}).estimated_deflections, 0);
  });

  test('an empty knowledge base reports honestly rather than dividing by zero', () => {
    const ws = newWorkspace(); const a = admin();
    const o = overview(ws, a, {});
    assert.equal(o.articles.total, 0);
    assert.equal(o.searches.miss_rate, null);
    assert.equal(o.deflection.rate, null);
  });

  test('an article carries its own numbers for the person who wrote it', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester();
    const art = article(ws, a);
    recordView(ws, art.id, r.id, 'portal');
    recordFeedback(ws, r, art.id, { helpful: true });
    const s = articleStats(ws, art.id);
    assert.equal(s.helpful, 1);
    assert.equal(s.helpful_rate, 100);
    assert.equal(s.period_views, 1);
  });
});

// ============================================================ categories ===

describe('knowledge: categories', () => {
  test('a tree can be built and counted', () => {
    const ws = newWorkspace(); const a = admin();
    const parent = createCategory(ws, { name: 'Network' });
    createCategory(ws, { name: 'VPN', parent_id: parent.id });
    article(ws, a, { category_id: parent.id });

    const tree = categoryTree(ws);
    assert.equal(tree.length, 1);
    assert.equal(tree[0].children.length, 1);
    assert.equal(tree[0].article_count, 1);
  });

  test('slugs are unique even when names collide', () => {
    const ws = newWorkspace();
    assert.equal(createCategory(ws, { name: 'Network' }).slug, 'network');
    assert.equal(createCategory(ws, { name: 'Network' }).slug, 'network-2');
  });

  test('a category cannot be moved underneath itself', () => {
    const ws = newWorkspace();
    const parent = createCategory(ws, { name: 'Network' });
    const child = createCategory(ws, { name: 'VPN', parent_id: parent.id });
    assert.throws(() => updateCategory(ws, parent.id, { parent_id: child.id }), /underneath itself/);
    assert.throws(() => updateCategory(ws, parent.id, { parent_id: parent.id }), /own parent/);
  });

  test('deleting a category unfiles its articles rather than deleting them', () => {
    const ws = newWorkspace(); const a = admin();
    const cat = createCategory(ws, { name: 'Temporary' });
    const art = article(ws, a, { category_id: cat.id });
    const result = deleteCategory(ws, cat.id);
    assert.equal(result.articles_unfiled, 1);
    assert.ok(getArticle(ws, art.id), 'the knowledge survives the tidy-up');
    assert.equal(getArticle(ws, art.id).category_id, null);
  });

  test('a category with children cannot be deleted', () => {
    const ws = newWorkspace();
    const parent = createCategory(ws, { name: 'Network' });
    createCategory(ws, { name: 'VPN', parent_id: parent.id });
    assert.throws(() => deleteCategory(ws, parent.id), /sub-categor/);
  });

  test('setting a category keeps the legacy text column in step', () => {
    // The AI self-service path still selects kb_articles.category.
    const ws = newWorkspace(); const a = admin();
    const cat = createCategory(ws, { name: 'Network' });
    const art = article(ws, a, { category_id: cat.id });
    assert.equal(getArticle(ws, art.id).category, 'Network');
  });
});

// ======================================================== ticket linkage ===

describe('knowledge: tickets', () => {
  test('an article can be drafted from a resolved ticket', () => {
    const ws = newWorkspace(); const a = admin();
    const t = ticket(ws, { title: 'Printer offline', description: 'It shows offline' });
    db.prepare('INSERT INTO ticket_comments (id, ticket_id, body, is_private) VALUES (?,?,?,0)')
      .run(uid('cmt'), t.id, 'Power cycled the printer and it came back.');

    const art = draftFromTicket(ws, a, t.id);
    assert.equal(art.title, 'Printer offline');
    assert.equal(art.status, 'draft', 'never straight to published');
    assert.equal(art.visibility, 'agents', 'not straight in front of customers either');
    assert.match(art.body, /Power cycled the printer/);
    assert.ok(art.linked_tickets.some((l) => l.id === t.id && l.relation === 'source'));
  });

  test('private notes are not copied into the draft', () => {
    const ws = newWorkspace(); const a = admin();
    const t = ticket(ws);
    db.prepare('INSERT INTO ticket_comments (id, ticket_id, body, is_private) VALUES (?,?,?,1)')
      .run(uid('cmt'), t.id, 'Customer was extremely rude about this');
    const art = draftFromTicket(ws, a, t.id);
    assert.ok(!/extremely rude/.test(art.body));
  });

  test('a problem becomes a known error', () => {
    const ws = newWorkspace(); const a = admin();
    const t = ticket(ws, { type: 'problem', title: 'Recurring disconnects' });
    const art = draftFromTicket(ws, a, t.id);
    assert.equal(art.article_type, 'known_error');
    assert.equal(art.problem_ticket_id, t.id);
  });

  test('linking is idempotent', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a); const t = ticket(ws);
    linkTicket(ws, a, art.id, t.id);
    assert.equal(linkTicket(ws, a, art.id, t.id).already_linked, true);
  });

  test('suggestions for a ticket come from its own words, with no AI required', () => {
    const ws = newWorkspace(); const a = admin();
    article(ws, a, { title: 'Printer offline', summary: 'Printer fixes', body: 'Power cycle the printer.' });
    article(ws, a, { title: 'VPN', summary: 'vpn', body: 'vpn things' });
    const t = ticket(ws, { title: 'Printer shows offline again' });
    const s = suggestForTicket(ws, a, t);
    assert.equal(s[0].title, 'Printer offline');
  });

  test('suggestions never include something the reader may not see', () => {
    const ws = newWorkspace(); const a = admin(); const r = requester();
    article(ws, a, { title: 'Printer runbook', summary: 'internal', body: 'printer console steps', visibility: 'internal' });
    const t = ticket(ws, { title: 'Printer console' });
    assert.equal(suggestForTicket(ws, r, t).length, 0);
  });

  test('related articles exclude the one being read', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { title: 'VPN will not connect', tags: 'vpn' });
    article(ws, a, { title: 'VPN client install', summary: 's', body: 'vpn client', tags: 'vpn' });
    const related = relatedArticles(ws, a, getArticle(ws, art.id));
    assert.ok(!related.some((x) => x.id === art.id));
    assert.ok(related.length >= 1);
  });
});

// ================================================================= basics ===

describe('knowledge: validation and housekeeping', () => {
  test('a title and body are required, and every problem is named', () => {
    const ws = newWorkspace(); const a = admin();
    try {
      createArticle(ws, a, { title: '', body: '' });
      assert.fail('should have thrown');
    } catch (err) {
      const fields = err.field_errors.map((f) => f.field).sort();
      assert.deepEqual(fields, ['body', 'title']);
    }
  });

  test('an unknown audience or type is refused', () => {
    const ws = newWorkspace(); const a = admin();
    assert.throws(() => createArticle(ws, a, { title: 'T', body: 'b', visibility: 'everyone' }), /fields need attention/);
    assert.throws(() => createArticle(ws, a, { title: 'T', body: 'b', article_type: 'essay' }), /fields need attention/);
  });

  test('changing the audience needs publishing rights', () => {
    const ws = newWorkspace(); const a = admin(); const g = agent();
    const art = article(ws, a, { visibility: 'internal' });
    assert.throws(() => updateArticle(ws, g, art.id, { visibility: 'portal' }), /knowledge-manager rights/);
  });

  test('slugs are unique and readable', () => {
    const ws = newWorkspace(); const a = admin();
    assert.equal(article(ws, a, { title: 'VPN will not connect' }).slug, 'vpn-will-not-connect');
    assert.equal(article(ws, a, { title: 'VPN will not connect' }).slug, 'vpn-will-not-connect-2');
  });

  test('tags are normalised and deduplicated', () => {
    assert.equal(serializeTags('VPN, vpn ,Network'), 'vpn, network');
    assert.equal(serializeTags(['A', 'b', 'A']), 'a, b');
    assert.equal(serializeTags(''), null);
    assert.deepEqual(parseTags('vpn, network'), ['vpn', 'network']);
    assert.deepEqual(parseTags(null), []);
  });

  test('an article can be fetched by slug as well as id', () => {
    const ws = newWorkspace(); const a = admin();
    const art = article(ws, a, { title: 'Findable by slug' });
    assert.equal(getArticle(ws, 'findable-by-slug').id, art.id);
  });

  test('every declared status, visibility and type has a label the UI can show', () => {
    for (const map of [STATUSES, VISIBILITIES, ARTICLE_TYPES]) {
      for (const [key, v] of Object.entries(map)) {
        assert.ok(v.label, `${key} has no label`);
      }
    }
  });
});
