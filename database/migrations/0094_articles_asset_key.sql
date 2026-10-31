-- The asset a post is about (a repo, a package, a project page), normalised. Two different posts
-- recommending the same asset must land on one key so grouping can merge them even when the
-- semantic recall window has expired. Extracted by regex at ingest, never by a model call.
ALTER TABLE articles ADD COLUMN asset_key text;
