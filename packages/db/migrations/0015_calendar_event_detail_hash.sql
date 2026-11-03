-- Calendar event details (v0.3b follow-up, spec 3.8). Additive and backward compatible: one new
-- nullable column, nothing is dropped or renamed, RLS is unchanged.
--
-- calendar_event_links.last_detail_hash: SHA-256 (hex) of the description last written to the
--   event. The description itself is not stored. A null or different value makes the next sync
--   patch the event once, so events written before descriptions existed get one too.
set local role {{owner}};

alter table {{schema}}.calendar_event_links
  add column if not exists last_detail_hash text
    check (last_detail_hash is null or char_length(last_detail_hash) <= 64);

-- The app login may update only the working columns (see 0011, 0013 and 0014); extend that list.
grant update (last_detail_hash) on {{schema}}.calendar_event_links to {{app_user}};
