-- Calendar sync (v0.3b WP6, spec 3.8): what the sync engine needs to remember between runs.
-- Additive and backward compatible: new nullable columns only, nothing is dropped or renamed.
--
-- calendar_sources.sync_token / window_start / window_end: Google's incremental-sync token for
--   the source and the date range (plan-local dates) the token covers. A new token is stored
--   after every listing; when it is missing, expired or no longer covers the range wanted, the
--   next sync does a full listing of that source.
-- calendar_connections.sync_timezone: the plan time zone the busy rows were last computed in.
--   Busy rows hold minutes of a local date, so a time-zone change clears them and resyncs.
-- calendar_event_links.last_summary: the title last written to the event, so an edit of the
--   task title is noticed and patched (the event itself is never read back for this).
set local role {{owner}};

alter table {{schema}}.calendar_sources
  add column if not exists sync_token text
    check (sync_token is null or char_length(sync_token) <= 2000),
  add column if not exists window_start date,
  add column if not exists window_end date;

alter table {{schema}}.calendar_connections
  add column if not exists sync_timezone text
    check (sync_timezone is null or char_length(sync_timezone) between 1 and 100);

alter table {{schema}}.calendar_event_links
  add column if not exists last_summary text
    check (last_summary is null or char_length(last_summary) <= 300);

-- The app login may update only the working columns (see 0011); extend that list.
grant update (sync_token, window_start, window_end) on {{schema}}.calendar_sources to {{app_user}};
grant update (sync_timezone) on {{schema}}.calendar_connections to {{app_user}};
grant update (last_summary) on {{schema}}.calendar_event_links to {{app_user}};

comment on column {{schema}}.calendar_sources.sync_token is
  'Google incremental-sync token. Not a credential, but never logged or exported.';
