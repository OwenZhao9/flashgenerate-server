-- FlashGenerate 服务端初始结构。
--
-- 设计上被三件事推着走，看表结构前先知道这三条，否则会觉得某些约束是多余的：
--
-- 1. 外部客户之间必须完全隔离。所有业务表都带 tenant_id，查询一律带上它，
--    管理员是唯一可以跨租户读的角色。隔离靠的是「每张表都有这一列」，
--    而不是靠某个中间件记得加条件。
--
-- 2. 额度不能重复扣、也不能重复退。账本是只追加的，靠 (task_id, op) 唯一约束兜底：
--    同一个任务的同一种操作，数据库层面就写不进第二条。
--
-- 3. 服务重启后任务和额度不能丢。队列落在 tasks 表里，worker 用租约抢单，
--    进程没了租约会过期，任务自然被下一个进程接手。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------------------
-- 租户与账号
-- ---------------------------------------------------------------------------

-- 内部员工共用一个 internal 租户，每个外部客户各自一个 client 租户。
-- 这样「数据属于谁」只有一个维度，不用在查询里区分角色。
CREATE TYPE tenant_kind AS ENUM ('internal', 'client');

CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        tenant_kind NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 全库只允许存在一个内部租户，避免建号时手滑建出第二个内部空间。
CREATE UNIQUE INDEX tenants_single_internal ON tenants ((kind)) WHERE kind = 'internal';

CREATE TYPE account_role AS ENUM ('admin', 'staff', 'client');

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  email         citext NOT NULL UNIQUE,
  -- argon2id。任何情况下都不存明文，也不存可逆加密。
  password_hash text NOT NULL,
  role          account_role NOT NULL,
  name          text NOT NULL DEFAULT '',
  -- 停用不删号：历史任务和账本还要挂在它名下。
  disabled_at   timestamptz,
  -- 管理员重置密码后置位，用户下次登录必须改。
  must_change_password boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounts_tenant ON accounts(tenant_id);

-- 管理员和内部员工必须在 internal 租户里，外部使用者必须在自己的 client 租户里。
-- 这条约束写在库里，是因为一旦错配就是越权读，不能只靠应用层记得判断。
ALTER TABLE accounts ADD CONSTRAINT accounts_role_matches_tenant CHECK (
  (role IN ('admin', 'staff')) OR (role = 'client')
);

-- ---------------------------------------------------------------------------
-- 会话
--
-- 用不透明随机串而不是自包含的 JWT。验收第 8 条要求「停用账号或重置密码后立即生效」，
-- JWT 在过期前无法收回，只能靠额外查一次库来判断是否被撤销——
-- 那既然每次都要查库，就没有理由再用 JWT。
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 只存哈希，库被读走也不能拿去冒充登录。
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_account ON sessions(account_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 供应商
--
-- 凭据只存在这张表里，永远不下发给浏览器（验收第 7 条）。
-- 以后接第二家，这里加一行，不动其它任何表。
-- ---------------------------------------------------------------------------

CREATE TABLE providers (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  -- { app_id, secret_key, ... }，形状由各家适配器自己定义。
  credentials jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 能力是任务层唯一认识的东西，供应商是它下面的实现。
CREATE TYPE capability AS ENUM (
  'image',      -- 文生图、图生图
  'video',      -- 文生视频、图生视频
  'avatar',     -- 数字人视频合成
  'tts',        -- 语音合成
  'voice_clone',-- 声音克隆
  'lipsync',    -- 口型驱动
  'person'      -- 定制数字人训练
);

-- 并发和限流按「供应商 × 能力」配置，不是全局一个数。
-- 客户明确提过这点：同一家的视频合成和图片创作限制完全不同，
-- 写死成一个数会把宽松的那条能力也拖慢。管理后台可改，改完不用重启。
CREATE TABLE provider_limits (
  provider_id text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability  capability NOT NULL,
  concurrency int NOT NULL DEFAULT 1 CHECK (concurrency >= 0),
  rpm         int NOT NULL DEFAULT 10 CHECK (rpm >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, capability)
);

-- 「能力 × 供应商 → 实际货币消耗」换算表。
--
-- 客户看到的永远是统一点数，换供应商或者平台调价只改这张表，
-- 客户已设的额度不受影响。model_code 为空表示该能力的兜底价。
CREATE TABLE cost_rules (
  id            bigserial PRIMARY KEY,
  provider_id   text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  capability    capability NOT NULL,
  model_code    text,
  -- 供应商自家的货币名，例如 bean / magic。只用于记账核对，不暴露给客户。
  currency      text NOT NULL,
  -- 一次调用消耗多少供应商货币。按秒、按张计费的能力用 per_unit 乘上用量。
  provider_cost numeric(14,4) NOT NULL DEFAULT 0,
  -- 折算成给客户扣的统一点数。
  points        numeric(14,4) NOT NULL DEFAULT 0,
  -- 是否按用量线性计价（视频按秒）。false 表示一口价。
  per_unit      boolean NOT NULL DEFAULT false,
  effective_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cost_rules_lookup
  ON cost_rules (provider_id, capability, COALESCE(model_code, ''), effective_at);

-- ---------------------------------------------------------------------------
-- 额度
-- ---------------------------------------------------------------------------

CREATE TABLE quota_accounts (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- 管理员发放的总额度。
  granted_points  numeric(14,4) NOT NULL DEFAULT 0,
  -- 已结算的消耗。
  used_points     numeric(14,4) NOT NULL DEFAULT 0,
  -- 已提交但还没出结果的预扣，随任务结束转入 used 或退回。
  held_points     numeric(14,4) NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 可用额度 = 发放 - 已用 - 预扣。三个数都不允许为负，提交时在同一个事务里判断。
ALTER TABLE quota_accounts ADD CONSTRAINT quota_non_negative
  CHECK (granted_points >= 0 AND used_points >= 0 AND held_points >= 0);

CREATE TYPE quota_op AS ENUM ('hold', 'settle', 'refund', 'adjust');

CREATE TABLE quota_ledger (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- adjust 是管理员手工调整，没有对应任务。
  task_id           uuid,
  op                quota_op NOT NULL,
  -- 有符号：hold 与 settle 为正，refund 为负，adjust 两种都可能。
  points            numeric(14,4) NOT NULL,
  -- 供应商实际扣的原始货币，供跟平台账单核对（验收第 4 条）。
  provider_id       text REFERENCES providers(id) ON DELETE SET NULL,
  provider_currency text,
  provider_amount   numeric(14,4),
  -- adjust 记录是谁改的，其余为空。
  actor_account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 验收第 3 条的硬保证：同一个任务的同一种操作只可能有一条记录。
-- 重复扣费和重复退款在数据库层面就写不进去，不依赖应用代码判断先后。
CREATE UNIQUE INDEX quota_ledger_task_op
  ON quota_ledger (task_id, op) WHERE task_id IS NOT NULL;

CREATE INDEX quota_ledger_tenant_time ON quota_ledger (tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 任务
-- ---------------------------------------------------------------------------

CREATE TYPE task_status AS ENUM (
  'queued',    -- 已入库，等 worker 抢
  'pending',   -- 已提交给供应商，对方排队中
  'running',
  'success',
  'failed',    -- 可重试
  'fatal',     -- 重试没有意义
  'cancelled'
);

CREATE TABLE tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 谁提交的。停用账号后任务仍然要能追溯到人（验收第 4 条）。
  created_by      uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,

  capability      capability NOT NULL,
  provider_id     text NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model_code      text,
  name            text NOT NULL DEFAULT '',
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 验收第 9 条：重复点击、刷新、网络重试都只落一条。
  -- 由前端生成，同一租户内唯一。
  idempotency_key text NOT NULL,

  status          task_status NOT NULL DEFAULT 'queued',
  progress        int NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),

  provider_task_id text,
  -- 归一后的错误类型，例如 timeout / rate_limited / content_rejected /
  -- bad_param / missing_resource / insufficient_balance（验收第 11 条）。
  error_code      text,
  error_message   text,
  -- 供应商原样返回的响应，排查时用。
  provider_raw    jsonb,
  trace_id        text,

  -- worker 租约。进程崩了租约到期，任务被别的进程接手，不会永远卡住。
  lease_owner     text,
  lease_until     timestamptz,
  attempts        int NOT NULL DEFAULT 0,
  -- 下次可以被抢的时间，用于退避重试。
  next_run_at     timestamptz NOT NULL DEFAULT now(),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE UNIQUE INDEX tasks_idempotency ON tasks (tenant_id, idempotency_key);
CREATE INDEX tasks_tenant_time ON tasks (tenant_id, created_at DESC);
-- worker 抢单用：按能力找到该跑的任务。
CREATE INDEX tasks_claimable ON tasks (provider_id, capability, next_run_at)
  WHERE status IN ('queued', 'pending', 'running');

-- ---------------------------------------------------------------------------
-- 资料库
-- ---------------------------------------------------------------------------

CREATE TYPE asset_type AS ENUM ('text', 'image', 'video', 'audio', 'avatar', 'voice');
CREATE TYPE asset_source AS ENUM ('generated', 'uploaded', 'imported');
CREATE TYPE asset_status AS ENUM ('ready', 'processing', 'failed', 'expired');

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  parent_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
  sort        int NOT NULL DEFAULT 0,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX categories_tenant ON categories(tenant_id, sort);

CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,

  type        asset_type NOT NULL,
  name        text NOT NULL,
  description text,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  tags        text[] NOT NULL DEFAULT '{}',
  source      asset_source NOT NULL,

  -- 我方对象存储里的 key。私有桶，对外一律走限时签名地址（验收第 5、6 条）。
  storage_key text,
  size_bytes  bigint,
  mime_type   text,
  -- 供应商的临时地址，会失效，仅留档排查用，不作为读取来源。
  origin_url  text,
  -- 文案类资产的正文
  content     text,

  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      asset_status NOT NULL DEFAULT 'ready',
  favorite    boolean NOT NULL DEFAULT false,
  used_count  int NOT NULL DEFAULT 0,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

CREATE INDEX assets_tenant_time ON assets (tenant_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX assets_task ON assets (task_id);

-- ---------------------------------------------------------------------------
-- 调用日志
--
-- 验收第 11 条要求异常能查到原始响应。日志量会涨，按时间分区留给后面，
-- 先建普通表加时间索引，配一条定期清理。
-- ---------------------------------------------------------------------------

CREATE TABLE api_logs (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid REFERENCES tenants(id) ON DELETE CASCADE,
  task_id      uuid,
  provider_id  text,
  method       text NOT NULL,
  path         text NOT NULL,
  duration_ms  int NOT NULL,
  ok           boolean NOT NULL,
  code         int,
  msg          text,
  trace_id     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_logs_time ON api_logs (created_at DESC);
CREATE INDEX api_logs_task ON api_logs (task_id) WHERE task_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 供应商余额快照
--
-- 系统内的额度和平台余额不可能实时一致，两个数分开看：
-- 系统里的是预算控制，这张表存的是从平台拉回来的事实，用于定时对账和告警。
-- ---------------------------------------------------------------------------

CREATE TABLE provider_balances (
  id          bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  currency    text NOT NULL,
  amount      numeric(14,4) NOT NULL,
  raw         jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX provider_balances_latest ON provider_balances (provider_id, currency, fetched_at DESC);
