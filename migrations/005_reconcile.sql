-- 账单补差。
--
-- 平台出账有延迟：任务刚成功时去查消耗明细还没有这一笔，
-- 所以结算只能先按估算记。等账单出来再回头补上差额。
--
-- 实测的差距不小——同一张图估算 8、账单 20；一条 4 秒视频估算 120、账单 180。
-- 不补差的话这些差额会一直挂在那儿，月底跟平台对不上。
ALTER TYPE quota_op ADD VALUE IF NOT EXISTS 'reconcile';

-- 记下这个任务的账单核对到哪一步了，避免反复去查已经对完的。
ALTER TABLE tasks ADD COLUMN cost_reconciled_at timestamptz;

-- 补差扫描要按「结算完但还没对账」找任务
CREATE INDEX tasks_pending_reconcile ON tasks (finished_at)
  WHERE status = 'success' AND cost_reconciled_at IS NULL;
