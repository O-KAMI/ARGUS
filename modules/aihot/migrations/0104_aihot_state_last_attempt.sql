-- 请求时间与有效验证分开：每次真正发出请求都记 last_attempt_at，畸形 200 不刷新 last_ok_at。
ALTER TABLE aihot_mirror_state ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;