// Thin wrapper over the `ldapjs` client, used by both the login route (a
// live bind to validate a directory-sourced user's password) and directory
// sync (a service-account search to enumerate/reconcile users).
//
// A note on `ldapjs` itself: as of this writing the package is marked
// "decommissioned" on npm -- its sole maintainer stopped maintaining it
// (unrelated to any known vulnerability) and there is no actively-maintained
// successor in the Node.js ecosystem for LDAP client+server support. It is
// still used here deliberately: it's the last complete implementation
// available, LDAP's wire protocol (BER/ASN.1) is a different order of
// complexity to hand-roll than the hand-rolled OAuth/HTTP elsewhere in this
// app, and it's only ever used to talk to a directory server the admin
// themselves configured (an internal, trusted connection, not
// internet-facing). Flagged here and in the admin UI's help text so this
// tradeoff is visible, not silent -- pin the version and keep an eye out for
// a maintained fork before relying on this for a security-critical path in
// production long-term.
import ldap from 'ldapjs';

const CONNECT_TIMEOUT_MS = 5000;
const OP_TIMEOUT_MS = 15000;

function createClient(config) {
  const client = ldap.createClient({
    url: config.url,
    connectTimeout: CONNECT_TIMEOUT_MS,
    timeout: OP_TIMEOUT_MS,
    tlsOptions: config.rejectUnauthorized === false ? { rejectUnauthorized: false } : undefined,
  });
  // ldapjs's own docs warn that an unhandled 'error' event on the client
  // prints a stack trace and kills the entire Node process -- every client
  // this module creates MUST have a listener (even a no-op one) so a
  // misconfigured or unreachable directory server degrades to a normal
  // rejected promise instead of taking the whole app down.
  client.on('error', () => {});
  return client;
}

function unbindQuietly(client) {
  try { client.unbind(); } catch { /* already closed */ }
}

function flattenEntry(entry) {
  const out = { dn: entry.pojo.objectName };
  for (const attr of entry.pojo.attributes) {
    // Multi-valued attributes (e.g. memberOf) keep their array; everything
    // else -- the overwhelming majority of what's read here -- collapses to
    // its single value so callers don't have to unwrap a 1-element array
    // for every ordinary field.
    out[attr.type.toLowerCase()] = attr.values.length > 1 ? attr.values : attr.values[0];
  }
  return out;
}

function runSearch(config, filter, sizeLimit, paged) {
  return new Promise((resolve, reject) => {
    const client = createClient(config);
    client.bind(config.bindDN, config.bindPassword, (bindErr) => {
      if (bindErr) {
        unbindQuietly(client);
        return reject(new Error(`Service account bind failed: ${bindErr.message}`));
      }
      const entries = [];
      client.search(config.baseDN, { scope: 'sub', filter: filter || config.userFilter || '(objectClass=user)', sizeLimit, paged }, (err, res) => {
        if (err) { unbindQuietly(client); return reject(err); }
        res.on('searchEntry', (entry) => entries.push(flattenEntry(entry)));
        res.on('error', (searchErr) => { unbindQuietly(client); reject(searchErr); });
        res.on('end', (result) => {
          unbindQuietly(client);
          // status 4 = sizeLimitExceeded -- expected/harmless when we asked
          // for a capped sizeLimit and the directory has more; every other
          // non-zero status is a real failure.
          if (result.status !== 0 && result.status !== 4) return reject(new Error(`LDAP search failed (status ${result.status})`));
          resolve(entries);
        });
      });
    });
  });
}

// Service-account search -- never an end user's own credential. Used by
// directory sync to enumerate everyone; login (routes/auth.js) doesn't call
// this at all -- it binds directly with the DN a prior sync already stored
// on the user's membership (directory_external_id).
export async function search(config, { filter, sizeLimit = 0 } = {}) {
  // `paged: true` lets ldapjs transparently request further pages via the
  // LDAP paged-results control (RFC 2696) -- without it, a directory
  // enforcing its own server-side page size (Active Directory defaults to
  // 1000) would silently truncate a full-directory sync partway through.
  // Not every LDAP server implements that control, though (some minimal/
  // legacy directories reject it outright), so a full (sizeLimit: 0) search
  // tries paged first and falls back to a plain search if the server
  // refuses the control -- better an unpaged (possibly truncated at the
  // server's own limit) sync than a completely failed one.
  if (sizeLimit !== 0) return runSearch(config, filter, sizeLimit, false);
  try {
    return await runSearch(config, filter, 0, true);
  } catch (e) {
    console.warn(`[directory-sync] paged search failed (${e.message}) -- retrying without paging`);
    return runSearch(config, filter, 0, false);
  }
}

// Validates a password by actually binding as the given DN -- the only
// trustworthy way to check an LDAP password (there's no readable hash to
// compare locally). An empty password is rejected before ever reaching the
// server: LDAP defines binding with no password as an "unauthenticated
// bind" that many servers accept unconditionally, which would otherwise let
// a blank password "succeed."
export function verifyBind(config, userDN, password) {
  return new Promise((resolve) => {
    if (!password) return resolve(false);
    const client = createClient(config);
    client.bind(userDN, password, (err) => {
      unbindQuietly(client);
      resolve(!err);
    });
  });
}

export async function testConnection(config) {
  try {
    const entries = await search(config, { sizeLimit: 5 });
    return { ok: true, sampleCount: entries.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
