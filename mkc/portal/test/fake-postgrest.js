/* A small in-memory stand-in for Supabase's REST API (PostgREST), used by the
 * route tests. It reads the real table definitions from the migration, so a
 * query that names a column that doesn't exist fails here exactly as it would
 * against the live database — the bug most likely to slip through otherwise.
 *
 * Supports what the portal code uses: select with embedded relations
 * (incl. !inner), eq / is / in / ilike filters (also on embedded columns),
 * order, limit, insert (with on_conflict merge), patch and delete. It also
 * answers Resend and Gemini calls so routes run end to end without a network.
 *
 * Kept in step with the copy in mkc/portal-manager/test/.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CORE = {
  'core.people': ['id', 'auth_user_id', 'email', 'full_name', 'phone', 'active', 'created_at', 'updated_at'],
  'core.tool_access': ['person_id', 'tool', 'role', 'created_at'],
  'core.audit_log': ['id', 'at', 'actor_person_id', 'tool', 'action', 'entity', 'entity_id', 'detail'],
  'core.sessions': ['token_hash', 'email', 'person_id', 'created_at', 'expires_at', 'ip', 'user_agent'],
  'core.magic_links': ['token_hash', 'email', 'created_at', 'expires_at', 'used_at', 'ip']
};

export function schemaFromMigration(sqlPath) {
  const sql = readFileSync(sqlPath, 'utf8');
  const tables = { ...CORE };
  const re = /create table (portal\.\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const cols = [];
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      const w = (t.match(/^([a-z_][a-z0-9_]*)\s+/) || [])[1];
      if (!w || ['constraint', 'primary', 'unique', 'check', 'foreign'].includes(w)) continue;
      cols.push(w);
    }
    tables[m[1]] = cols;
  }
  for (const v of Object.keys(VIEWS)) if (sql.includes(`create view ${v} `)) tables[v] = VIEWS[v].cols;
  return tables;
}

// Views from the migration, computed from the tables on each read.
const VIEWS = {
  'portal.company_overview': {
    cols: ['company_id', 'contacts', 'drafts', 'last_published_at'],
    rows: (db) => db['portal.companies'].map((c) => {
      const ups = db['portal.updates'].filter((u) => u.company_id === c.id);
      const pub = ups.filter((u) => u.status === 'published' && u.published_at).map((u) => u.published_at).sort();
      return {
        company_id: c.id,
        contacts: db['portal.contact_companies'].filter((l) => l.company_id === c.id).length,
        drafts: ups.filter((u) => u.status === 'draft').length,
        last_published_at: pub.length ? pub[pub.length - 1] : null
      };
    })
  }
};

const REL = {
  'core.people': { tool_access: { table: 'core.tool_access', local: 'id', foreign: 'person_id', many: true } },
  'portal.contact_companies': {
    companies: { table: 'portal.companies', local: 'company_id', foreign: 'id', many: false },
    contacts: { table: 'portal.contacts', local: 'contact_id', foreign: 'id', many: false }
  }
};

const UNIQUE = {
  'core.people': [['email:lower']],
  'core.tool_access': [['person_id', 'tool']],
  'core.sessions': [['token_hash']],
  'core.magic_links': [['token_hash']],
  'portal.contacts': [['email:lower']],
  'portal.companies': [['clickup_account_id']],
  'portal.contact_companies': [['contact_id', 'company_id']],
  'portal.staff_company_assignments': [['person_id', 'company_id']],
  'portal.client_magic_links': [['token_hash']],
  'portal.client_sessions': [['token_hash']]
};

function splitTop(s) {
  const out = []; let depth = 0; let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(sel) {
  return splitTop(sel || '*').map((part) => {
    const m = part.match(/^(\w+)(!inner)?\((.*)\)$/);
    if (m) return { embed: m[1], inner: Boolean(m[2]), cols: parseSelect(m[3]) };
    return { col: part };
  });
}

function likeToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    if (c === '%' || c === '*') re += '.*';
    else if (c === '_') re += '.';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function test(value, op) {
  const [kind, ...rest] = op.split('.');
  const arg = rest.join('.');
  const v = value === undefined ? null : value;
  if (kind === 'eq') return v !== null && String(v) === arg;
  if (kind === 'neq') return v === null || String(v) !== arg;
  if (kind === 'is') return arg === 'null' ? v === null : String(v) === arg;
  if (kind === 'in') return v !== null && arg.replace(/^\(|\)$/g, '').split(',').includes(String(v));
  if (kind === 'ilike') return v !== null && likeToRegex(arg).test(String(v));
  throw new Error(`fake postgrest: unsupported operator ${kind}`);
}

export function fakeBackend({ sqlPath, seed = {}, gemini, resend } = {}) {
  const schema = schemaFromMigration(sqlPath);
  const db = {};
  for (const t of Object.keys(schema)) db[t] = [];
  for (const [t, rows] of Object.entries(seed)) db[t] = rows.map((r) => ({ ...r }));
  const sent = { emails: [], gemini: [] };
  let auditId = 0;

  const fail = (status, message) => new Response(JSON.stringify({ message }), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (rows, status = 200) => new Response(JSON.stringify(rows), { status, headers: { 'Content-Type': 'application/json' } });

  function checkCols(table, cols) {
    const known = schema[table];
    if (!known) return `relation "${table}" does not exist`;
    const bad = cols.filter((c) => c !== '*' && !known.includes(c));
    return bad.length ? `column ${table}.${bad[0]} does not exist` : null;
  }

  function project(table, row, sel) {
    const out = {};
    for (const s of sel) {
      if (s.col === '*') Object.assign(out, row);
      else if (s.col) out[s.col] = row[s.col] === undefined ? null : row[s.col];
      else {
        const rel = REL[table] && REL[table][s.embed];
        const kids = db[rel.table].filter((k) => k[rel.foreign] === row[rel.local]);
        out[s.embed] = rel.many ? kids.map((k) => project(rel.table, k, s.cols)) : (kids[0] ? project(rel.table, kids[0], s.cols) : null);
      }
    }
    return out;
  }

  function filterRows(table, params, sel) {
    let rows = VIEWS[table] ? VIEWS[table].rows(db) : db[table];
    const embedFilters = {};
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
      if (k.includes('.')) { const [rel, col] = k.split('.'); (embedFilters[rel] ||= []).push([col, v]); continue; }
      const err = checkCols(table, [k]);
      if (err) throw fail(400, err);
      rows = rows.filter((r) => test(r[k], v));
    }
    const embeds = (sel || []).filter((s) => s.embed);
    for (const e of embeds) {
      const rel = REL[table] && REL[table][e.embed];
      if (!rel) throw fail(400, `no relationship between ${table} and ${e.embed}`);
      const err = checkCols(rel.table, e.cols.filter((c) => c.col).map((c) => c.col));
      if (err) throw fail(400, err);
      const f = embedFilters[e.embed] || [];
      for (const [col] of f) { const ce = checkCols(rel.table, [col]); if (ce) throw fail(400, ce); }
      if (e.inner) {
        rows = rows.filter((r) => db[rel.table].some((k) => k[rel.foreign] === r[rel.local] && f.every(([col, v]) => test(k[col], v))));
      }
    }
    return { rows, embedFilters };
  }

  function uniqueClash(table, row, ignore) {
    for (const key of UNIQUE[table] || []) {
      const val = (r, k) => { const [c, mod] = k.split(':'); const x = r[c]; return mod === 'lower' && typeof x === 'string' ? x.toLowerCase() : x; };
      if (key.some((k) => val(row, k) == null)) continue;
      const hit = db[table].find((r) => r !== ignore && key.every((k) => val(r, k) === val(row, k)));
      if (hit) return { hit, key };
    }
    return null;
  }

  function defaults(table, row) {
    const cols = schema[table];
    const now = new Date().toISOString();
    const d = {};
    if (cols.includes('id') && table !== 'core.audit_log') d.id = randomUUID();
    if (table === 'core.audit_log') { d.id = ++auditId; d.at = now; d.detail = {}; }
    for (const c of ['created_at', 'updated_at']) if (cols.includes(c)) d[c] = now;
    if (cols.includes('active')) d.active = true;
    if (table.endsWith('magic_links')) { d.expires_at = new Date(Date.now() + 15 * 60_000).toISOString(); d.used_at = null; }
    if (table === 'portal.updates') Object.assign(d, { status: 'draft', summary: '', notes: '', body_html: '', published_at: null, published_by: null });
    if (table === 'portal.companies') Object.assign(d, { branding: {}, clickup_account_id: null, primary_owner_person_id: null });
    if (table === 'portal.contacts') d.full_name = '';
    return { ...d, ...row };
  }

  async function rest(url, init) {
    const u = new URL(url);
    const table = `${(init.headers['Content-Profile'] || init.headers['Accept-Profile'])}.${u.pathname.replace('/rest/v1/', '')}`;
    if (!schema[table]) return fail(404, `relation "${table}" does not exist`);
    const method = init.method || 'GET';
    const params = [...u.searchParams.entries()];
    const sel = parseSelect(u.searchParams.get('select'));
    try {
      if (method === 'GET') {
        const err = checkCols(table, sel.filter((s) => s.col).map((s) => s.col));
        if (err) return fail(400, err);
        let { rows, embedFilters } = filterRows(table, params, sel);
        const order = u.searchParams.get('order');
        if (order) {
          const [col, dir] = order.split('.');
          rows = [...rows].sort((a, b) => (String(a[col] ?? '') < String(b[col] ?? '') ? -1 : String(a[col] ?? '') > String(b[col] ?? '') ? 1 : 0) * (dir === 'desc' ? -1 : 1));
        }
        const limit = Number(u.searchParams.get('limit')) || rows.length;
        return ok(rows.slice(0, limit).map((r) => {
          const p = project(table, r, sel);
          for (const [rel, f] of Object.entries(embedFilters)) {
            if (Array.isArray(p[rel])) p[rel] = p[rel].filter((k) => f.every(([col, v]) => test(k[col], v)));
          }
          return p;
        }));
      }
      if (VIEWS[table] && method !== 'GET') return fail(405, `cannot write to view ${table}`);
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        const list = Array.isArray(body) ? body : [body];
        const merge = (init.headers.Prefer || '').includes('merge-duplicates');
        const out = [];
        for (const row of list) {
          const err = checkCols(table, Object.keys(row));
          if (err) return fail(400, err);
          const full = defaults(table, row);
          const clash = uniqueClash(table, full);
          if (clash) {
            if (!merge) return fail(409, `duplicate key value violates unique constraint (${clash.key.join(',')})`);
            Object.assign(clash.hit, row);
            out.push(clash.hit);
          } else { db[table].push(full); out.push(full); }
        }
        return ok(out.map((r) => ({ ...r })), 201);
      }
      if (method === 'PATCH') {
        const changes = JSON.parse(init.body);
        const err = checkCols(table, Object.keys(changes));
        if (err) return fail(400, err);
        if (table === 'core.audit_log') return fail(403, 'core.audit_log is append-only');
        const { rows } = filterRows(table, params, []);
        for (const r of rows) {
          const next = { ...r, ...changes };
          const clash = uniqueClash(table, next, r);
          if (clash) return fail(409, 'duplicate key value violates unique constraint');
          Object.assign(r, changes, schema[table].includes('updated_at') ? { updated_at: new Date(Date.now() + 1).toISOString() } : {});
        }
        return ok(rows.map((r) => ({ ...r })));
      }
      if (method === 'DELETE') {
        if (table === 'core.audit_log') return fail(403, 'core.audit_log is append-only');
        const { rows } = filterRows(table, params, []);
        db[table] = db[table].filter((r) => !rows.includes(r));
        return ok(rows);
      }
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }
    return fail(405, 'method');
  }

  async function fetchImpl(url, init = {}) {
    const href = String(url);
    if (href.startsWith('https://fake.supabase.test/rest/v1/')) return rest(href, { ...init, headers: init.headers || {} });
    if (href.startsWith('https://api.resend.com/')) {
      sent.emails.push(JSON.parse(init.body));
      return resend ? resend(init) : new Response('{"id":"x"}', { status: 200 });
    }
    if (href.startsWith('https://generativelanguage.googleapis.com/')) {
      sent.gemini.push({ url: href, init });
      return gemini ? gemini(href, init) : new Response('{}', { status: 500 });
    }
    throw new Error(`unexpected network call in test: ${href}`);
  }

  return { db, sent, fetch: fetchImpl, schema };
}

/** Sets the env, installs the fake as global fetch, and returns a request helper. */
export function install(backend, env = {}) {
  Object.assign(process.env, {
    SUPABASE_URL: 'https://fake.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    RESEND_API_KEY: 'test-resend',
    FROM_EMAIL: 'Test <test@example.com>',
    ...env
  });
  globalThis.fetch = backend.fetch;
}

export function call(handler, path, { method = 'GET', body, cookie, origin, host = 'app.test', ip = '203.0.113.9' } = {}) {
  const headers = { host, 'user-agent': 'node-test', 'x-forwarded-for': ip };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return handler.fetch(new Request(`https://${host}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}
