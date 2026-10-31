-- Which platform an item came from, decided once at publish time. Reads used to re-derive this
-- from channel + sources.kind + a URL regex per query, which cannot express every platform.
ALTER TABLE publications ADD COLUMN platform text;
