-- What a migration file contained at the moment it was applied. The ledger keys on the file name alone, so
-- an edited historical file is neither re-run nor noticed: the schema and the file then disagree in silence.
-- Rows written before this column carry no checksum and are left unverifiable; every row from here on is.
ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
