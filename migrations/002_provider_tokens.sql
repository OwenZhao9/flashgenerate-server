-- 供应商访问凭证的共享存放处。
--
-- 平台有一条硬规则：重新获取凭证后，之前的凭证立即失效。
-- 浏览器时代这条靠 localStorage 锁 + BroadcastChannel 在标签页之间勉强协调，
-- 多开还是会互相踢。搬到服务端之后本来一个进程一个凭证就没事了，
-- 但只要将来跑第二个实例（滚动发布的那几十秒就会同时存在两个），
-- 两边各自刷新一次就又开始互相顶。
--
-- 所以凭证放库里，刷新时先 SELECT ... FOR UPDATE 占住这一行，
-- 抢不到的那个实例等着读结果，全局同一时刻只会有一次刷新。
CREATE TABLE provider_tokens (
  provider_id  text PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  token        text NOT NULL,
  expires_at   timestamptz NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
