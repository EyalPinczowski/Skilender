-- Product rename (Skillstack and Skilender -> Upversion): the built-in practice items carry the product name in
-- their provider text. Update rows already loaded from the catalog seed. Data only, no schema
-- change, safe to run more than once. The catalog tables are created by a later migration, so
-- nothing happens while the table does not exist yet (the seed then loads the new name).
set local role {{owner}};

do $$
begin
  if to_regclass('{{schema}}.catalog_items') is not null then
    update {{schema}}.catalog_items
       set provider = 'Upversion practice'
     where provider in ('Skillstack practice', 'Skilender practice');
  end if;
end
$$;
