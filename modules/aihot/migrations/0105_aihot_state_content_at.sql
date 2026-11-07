-- 内容生成/应用时间：只有拿到并应用了新内容才推进；304 确认未变，不冒充新内容。
ALTER TABLE aihot_mirror_state ADD COLUMN IF NOT EXISTS content_at timestamptz;