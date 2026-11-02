-- Calendar (v0.4, spec 3.8): the Google Calendar connection, the app's own calendar, the events
-- the app wrote, and a read-only copy of busy times. Tier 2 (spec 3.B): none of it goes to events,
-- logs or AI models.
-- Never stored: event descriptions or attendees. Busy rows keep a title, a time range and a kind only.
-- The refresh token and the PKCE verifier are stored only as ciphertext (encrypted in the API; the
-- key is never in the database). The account export leaves both ciphertext columns out.
--
-- calendar_connections: one row per user. The app can add, read, change (not user_id or provider)
--   and delete it (disconnect).
-- calendar_oauth_states: short-lived (expires_at); the app can add, read and delete its own rows;
--   no update. state_hash is unique across users (the callback looks a state up by its hash).
-- calendar_event_links: one row per plan block the app wrote to its own calendar. Plan-scoped
--   (cascade with the plan). task_id is plain text on purpose: replacing a plan's tasks must not
--   drop the link to an event that is already in the calendar.
-- calendar_locked_blocks: blocks the user moved or deleted in the calendar; the sync leaves them alone.
-- calendar_busy: busy times copied from the user's calendars, as minutes of a local date.
-- calendar_sources: which calendars count (blocks_time false by default; the primary calendar's
--   default is handled in code).
-- Deleting an account removes all six tables' rows (cascade from app_users).
set local role {{owner}};

create table {{schema}}.calendar_connections (
  user_id uuid primary key references {{schema}}.app_users (id) on delete cascade,
  provider text not null default 'google' check (provider in ('google')),
  app_calendar_id text check (app_calendar_id is null or char_length(app_calendar_id) between 1 and 500),
  status text not null default 'connected'
    check (status in ('connected', 'needs_reconnect', 'disconnected')),
  granted_scopes text[] not null default '{}' check (cardinality(granted_scopes) <= 20),
  -- Encrypted in the API; null once disconnected.
  refresh_token_ciphertext text check (refresh_token_ciphertext is null or char_length(refresh_token_ciphertext) <= 8000),
  last_synced_at timestamptz,
  last_error_code text check (last_error_code is null or char_length(last_error_code) between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table {{schema}}.calendar_oauth_states (
  user_id uuid not null references {{schema}}.app_users (id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  state_hash text not null unique check (char_length(state_hash) between 16 and 200),
  pkce_verifier_ciphertext text not null check (char_length(pkce_verifier_ciphertext) <= 4000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, id),
  check (expires_at > created_at)
);
create index calendar_oauth_states_expires_idx on {{schema}}.calendar_oauth_states (expires_at);

create table {{schema}}.calendar_event_links (
  user_id uuid not null,
  plan_id uuid not null,
  block_key text not null check (btrim(block_key) <> '' and char_length(block_key) <= 200),
  task_id text not null check (btrim(task_id) <> '' and char_length(task_id) <= 200),
  event_id text not null check (btrim(event_id) <> '' and char_length(event_id) <= 500),
  generation integer not null default 1 check (generation >= 0),
  last_start timestamptz not null,
  last_end timestamptz not null,
  etag text check (etag is null or char_length(etag) <= 500),
  updated_at timestamptz not null default now(),
  primary key (user_id, plan_id, block_key),
  foreign key (user_id, plan_id) references {{schema}}.plans (user_id, id) on delete cascade,
  check (last_end > last_start)
);

create table {{schema}}.calendar_locked_blocks (
  user_id uuid not null,
  plan_id uuid not null,
  block_key text not null check (btrim(block_key) <> '' and char_length(block_key) <= 200),
  task_id text not null check (btrim(task_id) <> '' and char_length(task_id) <= 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null check (reason in ('moved', 'deleted')),
  created_at timestamptz not null default now(),
  primary key (user_id, plan_id, block_key),
  foreign key (user_id, plan_id) references {{schema}}.plans (user_id, id) on delete cascade,
  check (ends_at > starts_at)
);

create table {{schema}}.calendar_busy (
  user_id uuid not null references {{schema}}.app_users (id) on delete cascade,
  date date not null,
  external_event_id text not null check (btrim(external_event_id) <> '' and char_length(external_event_id) <= 500),
  source_calendar_id text not null check (btrim(source_calendar_id) <> '' and char_length(source_calendar_id) <= 500),
  start_minute integer not null check (start_minute between 0 and 1440),
  end_minute integer not null check (end_minute between 0 and 1440),
  title text not null default '' check (char_length(title) <= 300),
  kind text not null check (kind in ('busy', 'tentative', 'all_day')),
  blocks_day boolean not null default false,
  primary key (user_id, external_event_id, date),
  check (end_minute > start_minute)
);
create index calendar_busy_date_idx on {{schema}}.calendar_busy (user_id, date);

create table {{schema}}.calendar_sources (
  user_id uuid not null references {{schema}}.app_users (id) on delete cascade,
  calendar_id text not null check (btrim(calendar_id) <> '' and char_length(calendar_id) <= 500),
  name text not null default '' check (char_length(name) <= 300),
  blocks_time boolean not null default false,
  primary key (user_id, calendar_id)
);

alter table {{schema}}.calendar_connections enable row level security;
alter table {{schema}}.calendar_oauth_states enable row level security;
alter table {{schema}}.calendar_event_links enable row level security;
alter table {{schema}}.calendar_locked_blocks enable row level security;
alter table {{schema}}.calendar_busy enable row level security;
alter table {{schema}}.calendar_sources enable row level security;

create policy app_user_select on {{schema}}.calendar_connections
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.calendar_connections
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_update on {{schema}}.calendar_connections
  for update to {{app_user}}
  using (user_id = (select {{schema}}.current_user_id()))
  with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.calendar_connections
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.calendar_connections for select to {{backup}} using (true);

create policy app_user_select on {{schema}}.calendar_oauth_states
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.calendar_oauth_states
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.calendar_oauth_states
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.calendar_oauth_states for select to {{backup}} using (true);

create policy app_user_select on {{schema}}.calendar_event_links
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.calendar_event_links
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_update on {{schema}}.calendar_event_links
  for update to {{app_user}}
  using (user_id = (select {{schema}}.current_user_id()))
  with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.calendar_event_links
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.calendar_event_links for select to {{backup}} using (true);

create policy app_user_select on {{schema}}.calendar_locked_blocks
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.calendar_locked_blocks
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_update on {{schema}}.calendar_locked_blocks
  for update to {{app_user}}
  using (user_id = (select {{schema}}.current_user_id()))
  with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.calendar_locked_blocks
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.calendar_locked_blocks for select to {{backup}} using (true);

create policy app_user_select on {{schema}}.calendar_busy
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.calendar_busy
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_update on {{schema}}.calendar_busy
  for update to {{app_user}}
  using (user_id = (select {{schema}}.current_user_id()))
  with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.calendar_busy
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.calendar_busy for select to {{backup}} using (true);

create policy app_user_select on {{schema}}.calendar_sources
  for select to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy app_user_insert on {{schema}}.calendar_sources
  for insert to {{app_user}} with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_update on {{schema}}.calendar_sources
  for update to {{app_user}}
  using (user_id = (select {{schema}}.current_user_id()))
  with check (user_id = (select {{schema}}.current_user_id()));
create policy app_user_delete on {{schema}}.calendar_sources
  for delete to {{app_user}} using (user_id = (select {{schema}}.current_user_id()));
create policy backup_select on {{schema}}.calendar_sources for select to {{backup}} using (true);

-- Keys and the owner never change; only the working columns can be updated.
revoke update on {{schema}}.calendar_connections from {{app_user}};
grant update (app_calendar_id, status, granted_scopes, refresh_token_ciphertext, last_synced_at,
  last_error_code, updated_at) on {{schema}}.calendar_connections to {{app_user}};
revoke update on {{schema}}.calendar_oauth_states from {{app_user}};
revoke update on {{schema}}.calendar_event_links from {{app_user}};
grant update (task_id, event_id, generation, last_start, last_end, etag, updated_at)
  on {{schema}}.calendar_event_links to {{app_user}};
revoke update on {{schema}}.calendar_locked_blocks from {{app_user}};
grant update (task_id, starts_at, ends_at, reason) on {{schema}}.calendar_locked_blocks to {{app_user}};
revoke update on {{schema}}.calendar_busy from {{app_user}};
grant update (source_calendar_id, start_minute, end_minute, title, kind, blocks_day)
  on {{schema}}.calendar_busy to {{app_user}};
revoke update on {{schema}}.calendar_sources from {{app_user}};
grant update (name, blocks_time) on {{schema}}.calendar_sources to {{app_user}};

comment on column {{schema}}.calendar_connections.refresh_token_ciphertext is
  'Encrypted in the API. Never exported, never logged.';
comment on column {{schema}}.calendar_oauth_states.pkce_verifier_ciphertext is
  'Encrypted in the API. Never exported, never logged.';
