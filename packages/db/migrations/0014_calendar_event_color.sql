-- Calendar event colours (v0.3b follow-up, spec 3.8). Additive and backward compatible: one new
-- nullable column, nothing is dropped or renamed, RLS is unchanged.
--
-- calendar_event_links.last_color: the Google colorId ('1'..'11') last written to the event, so a
--   change of the task's colour (or an event written before colours existed, where it is null)
--   is noticed and patched on the next sync (the event itself is never read back for this).
set local role {{owner}};

alter table {{schema}}.calendar_event_links
  add column if not exists last_color text
    check (last_color is null or last_color in ('1','2','3','4','5','6','7','8','9','10','11'));

-- The app login may update only the working columns (see 0011 and 0013); extend that list.
grant update (last_color) on {{schema}}.calendar_event_links to {{app_user}};
