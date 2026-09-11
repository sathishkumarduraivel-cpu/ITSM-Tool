// Microsoft Graph directory sync (Azure AD / Entra ID) -- an app-only
// client-credentials grant, deliberately separate from the OAuth delegated
// login flow in services/sso.js: that flow only ever hears from a user who
// successfully signs themselves in (it can't enumerate the tenant or notice
// someone was removed), and its Microsoft app registration is typically
// granted delegated `User.Read` only. This needs application permissions
// (`User.Read.All` / `Directory.Read.All`, admin-consented once in Entra ID)
// to list and watch the whole directory instead.
import fetch from 'node-fetch';

const SELECT_FIELDS = 'id,displayName,mail,userPrincipalName,accountEnabled,department,jobTitle,officeLocation,employeeId';
// `manager` is a navigation property, not a plain field -- it has to be
// $expand-ed (with its own nested $select) rather than listed in $select,
// or Graph rejects the request.
const EXPAND = 'manager($select=id)';

async function getAppOnlyToken(config) {
  const resp = await fetch(`https://login.microsoftonline.com/${config.tenant_id}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.client_id,
      client_secret: config.client_secret,
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error_description || 'Could not obtain a Microsoft Graph app-only token.');
  return data.access_token;
}

function normalize(u) {
  return {
    dn: u.id, // stable reconciliation key, matching LDAP's "dn" field name so directorySync.js can treat both providers identically
    id: u.id,
    displayname: u.displayName,
    mail: u.mail || u.userPrincipalName,
    accountenabled: u.accountEnabled,
    department: u.department,
    title: u.jobTitle,
    physicaldeliveryofficename: u.officeLocation,
    employeeid: u.employeeId,
    manager: u.manager?.id || null, // present only when $expand=manager succeeded and the user has one set
  };
}

export async function search(config) {
  const token = await getAppOnlyToken(config);
  const entries = [];
  let url = `https://graph.microsoft.com/v1.0/users?$select=${SELECT_FIELDS}&$expand=${encodeURIComponent(EXPAND)}&$top=999`;
  // Graph paginates via @odata.nextLink -- follow it until exhausted so a
  // sync never silently stops partway through a large tenant.
  let guard = 0;
  while (url && guard < 1000) {
    guard += 1;
    // eslint-disable-next-line no-await-in-loop
    const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    // eslint-disable-next-line no-await-in-loop
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || 'Microsoft Graph user list request failed.');
    for (const u of data.value || []) entries.push(normalize(u));
    url = data['@odata.nextLink'] || null;
  }
  return entries;
}

export async function testConnection(config) {
  try {
    const token = await getAppOnlyToken(config);
    const resp = await fetch(`https://graph.microsoft.com/v1.0/users?$select=${SELECT_FIELDS}&$top=5`, { headers: { authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || 'Microsoft Graph request failed.');
    return { ok: true, sampleCount: (data.value || []).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
