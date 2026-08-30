-- 计价接入平台的公开价格目录。
--
-- 原来 cost_rules 只按「供应商 × 能力 × 模型」定价，这不够：
-- 同一个模型换个分辨率、换个输入类型（文生视频 / 视频生视频），单价差好几倍。
-- doubao-seedance-2.0 1080P 文生 35 蝉豆/秒，视频生 60 蝉豆/秒，差 71%。
-- 少了这两维，报价一定是错的。
--
-- 另外对口型是「基础费 80 + 按秒 1~2」这种两段式，也得单独留一列。

ALTER TABLE cost_rules
  ADD COLUMN variant      text,
  ADD COLUMN resolution   text,
  -- 同一次生成，新模型同时标了蝉豆价和魔力价，实际扣哪种看账户持有哪种。
  -- 两个都存着，将来改用魔力结算不用重新拉目录。
  ADD COLUMN magic_cost   numeric(14,4),
  -- 两段式计费的固定部分，例如对口型的基础费
  ADD COLUMN base_cost    numeric(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN base_points  numeric(14,4) NOT NULL DEFAULT 0,
  -- catalog 表示这条是从平台价格目录同步来的，manual 表示人工填的。
  -- 同步只覆盖自己写过的行，不动人工调整过的价。
  ADD COLUMN source       text NOT NULL DEFAULT 'manual',
  -- 同步时目录的版本号，用于追溯这个价是哪一版来的
  ADD COLUMN catalog_version text;

DROP INDEX IF EXISTS cost_rules_lookup;

-- 查价的键加上两维。COALESCE 是因为空维度要参与唯一性判断，
-- 而 Postgres 的唯一索引里 NULL 互不相等，不折成空串会放进重复行。
CREATE UNIQUE INDEX cost_rules_lookup ON cost_rules (
  provider_id,
  capability,
  COALESCE(model_code, ''),
  COALESCE(variant, ''),
  COALESCE(resolution, ''),
  effective_at
);

-- 价格目录快照。
--
-- 留着有两个用处：目录版本变了能对出改了哪几项；
-- 以及任何一笔历史消耗都能追回当时按的是哪一版价。
CREATE TABLE price_catalogs (
  id          bigserial PRIMARY KEY,
  provider_id text NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  version     text NOT NULL,
  updated_at  timestamptz,
  payload     jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  -- 同步到 cost_rules 的结果：改了几条、几个模型没映射上
  applied     int NOT NULL DEFAULT 0,
  unmapped    jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE UNIQUE INDEX price_catalogs_version ON price_catalogs (provider_id, version);
CREATE INDEX price_catalogs_time ON price_catalogs (provider_id, fetched_at DESC);
