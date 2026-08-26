-- 提交时刻。
-- 每分钟调用上限要按「最近 60 秒发出去了几次」来算，
-- 用 updated_at 代替不行：轮询也会刷新它，会把限流窗口算成一直是满的。
ALTER TABLE tasks ADD COLUMN submitted_at timestamptz;

CREATE INDEX tasks_rpm_window ON tasks (provider_id, capability, submitted_at)
  WHERE submitted_at IS NOT NULL;
