-- The content kinds the learning track judged for an item, kept on the publication so the
-- important-announcements read can admit learning-track industry news without re-joining analyses.
ALTER TABLE publications ADD COLUMN learning_kinds text[];
