-- MKC Client Portal — foundation schema
--
-- Lives in the MKC-Admin project beside `core` (shared people, sessions,
-- tool access) and `booking`. Follows the same security model as those two:
--
--   * Only the server, holding the service-role key, can reach this schema.
--     anon and authenticated get no USAGE on it, so the public anon key
--     cannot see these tables through the REST API at all.
--   * RLS is enabled on every table with no policies, as a second wall: if a
--     grant is ever added by mistake, rows still stay invisible.
--   * Company scoping is enforced in the server on every request, from the
--     session — never from a company_id the browser sends.
--
-- Staff are core.people with a core.tool_access row for tool 'portal'.
-- Clients are portal.contacts — deliberately NOT core.people, which is the
-- MKC team roster. Client sessions live in their own tables so a client
-- session can never satisfy a staff check.

create schema if not exists portal;
revoke all on schema portal from public, anon, authenticated;
grant usage on schema portal to service_role;

create or replace function portal.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── Clients ─────────────────────────────────────────────────────────────

create table portal.companies (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null check (length(btrim(name)) between 1 and 200),
  division                text not null check (division in ('jtg', 'uny', 'mco')),
  clickup_account_id      text unique,
  branding                jsonb not null default '{}'::jsonb,
  primary_owner_person_id uuid references core.people (id) on delete set null,
  active                  boolean not null default true,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table portal.companies is
  'One row per client account. division is the MKC division that serves them (jtg, uny, mco) and picks the portal branding they see.';
comment on column portal.companies.clickup_account_id is
  'ClickUp ID of the account entry. The join key between ClickUp tasks and this portal.';

create table portal.contacts (
  id                 uuid primary key default gen_random_uuid(),
  -- Stored lower-case: sign-in matches emails exactly, so a mixed-case row
  -- would never receive a link.
  email              text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' and email = lower(email)),
  full_name          text not null default '',
  clickup_contact_id text,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index contacts_email_lower_key on portal.contacts (lower(email));
comment on table portal.contacts is
  'A client person who can sign in to the portal. Separate from core.people, which is the MKC team.';

create table portal.contact_companies (
  contact_id uuid not null references portal.contacts (id) on delete cascade,
  company_id uuid not null references portal.companies (id) on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (contact_id, company_id)
);
create index contact_companies_company_idx on portal.contact_companies (company_id);

-- ── Staff scoping ───────────────────────────────────────────────────────
-- super_admin and manager see every company; account_manager and
-- supervisor see only the companies assigned to them here.

create table portal.staff_company_assignments (
  person_id  uuid not null references core.people (id) on delete cascade,
  company_id uuid not null references portal.companies (id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (person_id, company_id)
);
create index staff_company_assignments_company_idx on portal.staff_company_assignments (company_id);

-- ── Published content ───────────────────────────────────────────────────

create table portal.updates (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references portal.companies (id) on delete cascade,
  type         text not null default 'update'
               check (type in ('update', 'task', 'guide', 'report', 'meeting')),
  title        text not null check (length(btrim(title)) between 1 and 200),
  summary      text not null default '' check (length(summary) <= 1000),
  notes        text not null default '' check (length(notes) <= 20000),
  body_html    text not null default '' check (length(body_html) <= 2000000),
  html_path    text,
  status       text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by   uuid references core.people (id) on delete set null,
  published_by uuid references core.people (id) on delete set null,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint updates_published_is_stamped check (status <> 'published' or published_at is not null)
);
create index updates_company_feed_idx on portal.updates (company_id, status, published_at desc);
comment on column portal.updates.body_html is
  'Self-contained HTML, rendered only inside a sandboxed frame served with its own CSP. Never inserted into a portal page directly.';
comment on column portal.updates.notes is
  'Staff working notes the page was built from. Internal only: never returned by any client-facing route.';
comment on column portal.updates.html_path is
  'Reserved for very large pages moved to Storage later. Empty while body_html holds the page.';

create table portal.files (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references portal.companies (id) on delete cascade,
  storage_path           text not null unique,
  name                   text not null check (length(btrim(name)) between 1 and 255),
  category               text not null default 'general',
  uploaded_by_person_id  uuid references core.people (id) on delete set null,
  uploaded_by_contact_id uuid references portal.contacts (id) on delete set null,
  created_at             timestamptz not null default now()
);
create index files_company_idx on portal.files (company_id, created_at desc);

-- ── ClickUp mirror and client requests ──────────────────────────────────

create table portal.tasks_mirror (
  clickup_task_id text primary key,
  company_id      uuid not null references portal.companies (id) on delete cascade,
  title           text not null,
  status          text not null default '',
  due_date        timestamptz,
  assignee_type   text not null default 'staff' check (assignee_type in ('client', 'staff')),
  client_visible  boolean not null default false,
  synced_at       timestamptz not null default now()
);
create index tasks_mirror_company_idx on portal.tasks_mirror (company_id, client_visible, due_date);
comment on table portal.tasks_mirror is
  'Read-only cache of client-facing ClickUp tasks. ClickUp wins every conflict; a resync overwrites this.';

create table portal.requests (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references portal.companies (id) on delete cascade,
  contact_id      uuid references portal.contacts (id) on delete set null,
  body            text not null check (length(btrim(body)) between 1 and 5000),
  clickup_task_id text,
  created_at      timestamptz not null default now()
);
create index requests_company_idx on portal.requests (company_id, created_at desc);

-- ── Notifications (used from the notifications phase) ───────────────────

create table portal.notification_prefs (
  contact_id    uuid primary key references portal.contacts (id) on delete cascade,
  push_enabled  boolean not null default true,
  email_enabled boolean not null default true,
  updated_at    timestamptz not null default now()
);

create table portal.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references portal.contacts (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- ── Client sign-in ──────────────────────────────────────────────────────
-- Same shape as core.magic_links / core.sessions, but keyed to a contact.
-- Only SHA-256 hashes of tokens are stored; the raw token lives in the
-- emailed link or the HTTP-only cookie and nowhere else.

create table portal.client_magic_links (
  token_hash text primary key,
  contact_id uuid not null references portal.contacts (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at    timestamptz,
  ip         text
);

create table portal.client_sessions (
  token_hash text primary key,
  contact_id uuid not null references portal.contacts (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip         text,
  user_agent text
);
create index client_sessions_contact_idx on portal.client_sessions (contact_id);

-- ── updated_at maintenance ──────────────────────────────────────────────

create trigger companies_touch before update on portal.companies
  for each row execute function portal.touch_updated_at();
create trigger contacts_touch before update on portal.contacts
  for each row execute function portal.touch_updated_at();
create trigger updates_touch before update on portal.updates
  for each row execute function portal.touch_updated_at();
create trigger notification_prefs_touch before update on portal.notification_prefs
  for each row execute function portal.touch_updated_at();

-- ── Lock-down ───────────────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'companies', 'contacts', 'contact_companies', 'staff_company_assignments',
    'updates', 'files', 'tasks_mirror', 'requests', 'notification_prefs',
    'push_subscriptions', 'client_magic_links', 'client_sessions'
  ] loop
    execute format('alter table portal.%I enable row level security', t);
    execute format('revoke all on portal.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on portal.%I to service_role', t);
  end loop;
end $$;

revoke all on function portal.touch_updated_at() from public, anon, authenticated;

-- ── Client list summary ─────────────────────────────────────────────────
-- One row per company with the counts the Portal Manager's client list
-- shows. Counting here avoids the API's 1,000-row page limit silently
-- under-counting busy clients. security_invoker: the view never widens
-- access beyond what the caller already has on the tables.

create view portal.company_overview with (security_invoker = true) as
select c.id as company_id,
       (select count(*) from portal.contact_companies cc where cc.company_id = c.id)::int as contacts,
       (select count(*) from portal.updates u where u.company_id = c.id and u.status = 'draft')::int as drafts,
       (select max(u.published_at) from portal.updates u where u.company_id = c.id and u.status = 'published') as last_published_at
from portal.companies c;

revoke all on portal.company_overview from public, anon, authenticated;
grant select on portal.company_overview to service_role;

-- ── Audit log is append-only ────────────────────────────────────────────
-- The portal records every staff and client action in core.audit_log under
-- tool = 'portal'. Nothing in any MKC app updates or deletes audit rows, so
-- making that structural costs nothing and means a compromised server key
-- still cannot rewrite history.

create or replace function core.audit_log_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- One update is allowed: the foreign key's ON DELETE SET NULL, which clears
  -- actor_person_id when a person record is deleted. Blocking it would make
  -- deleting anyone with audit history fail. Every other column must be
  -- untouched, so the row's record of what happened still cannot change.
  -- The person must really be gone: a direct UPDATE that nulls the actor of a
  -- person who still exists is refused, so "who did it" can't be wiped.
  if tg_op = 'UPDATE'
     and old.actor_person_id is not null and new.actor_person_id is null
     and not exists (select 1 from core.people p where p.id = old.actor_person_id)
     and (new.id, new.at, new.tool, new.action, new.entity, new.entity_id, new.detail)
         is not distinct from
         (old.id, old.at, old.tool, old.action, old.entity, old.entity_id, old.detail) then
    return new;
  end if;
  raise exception 'core.audit_log is append-only: % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists audit_log_no_rewrite on core.audit_log;
create trigger audit_log_no_rewrite before update or delete on core.audit_log
  for each row execute function core.audit_log_append_only();
drop trigger if exists audit_log_no_truncate on core.audit_log;
create trigger audit_log_no_truncate before truncate on core.audit_log
  for each statement execute function core.audit_log_append_only();

revoke all on function core.audit_log_append_only() from public, anon, authenticated;
