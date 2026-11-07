-- 精选窗口最近一次完整读到末尾的时间：上游 v1 的 ETag 只承诺当页，定期无条件全量对账兜住后页更正。
ALTER TABLE aihot_mirror_state ADD COLUMN IF NOT EXISTS full_read_at timestamptz;