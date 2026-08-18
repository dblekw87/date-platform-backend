-- 시가총액 — the field the 짝꿍 work has been blocked on.
--
-- The pairing rule has a direction and the direction follows size: 삼성전기
-- rising pulls 삼화콘덴서 and 코칩 behind it and not the other way round. So a
-- large cap in the leader slot is normal and typical; what does not work is a
-- large cap as the follower, because it is too heavy to move on somebody else's
-- news and late when it does.
--
-- That means the success test has to differ by size - a bigger follower needs a
-- longer window - and none of it could be measured, because no row here knew how
-- big anything was. The note saying so has sat in the plan for weeks.
--
-- KIS was sending it the whole time. The ranking response carries lstn_stcn
-- beside stck_prpr and the per-symbol quote carries both plus hts_avls; nothing
-- here read any of them. So this costs no additional request.
--
-- Computed as price times shares in both paths rather than taking hts_avls in
-- one and multiplying in the other. hts_avls disagreed with the product by
-- about 0.7% on 삼성전자 - a different snapshot, or preferred shares excluded -
-- and one column holding two definitions is worse than either.
--
-- Won rather than 억원, because every other money column here is won.

ALTER TABLE market_price_samples
  ADD COLUMN IF NOT EXISTS market_cap numeric;

-- The question is "how big were the followers on the days the pair worked", so
-- it is read alongside the session rather than on its own.
CREATE INDEX IF NOT EXISTS market_price_samples_cap_idx
  ON market_price_samples (session_date, market_cap)
  WHERE market_cap IS NOT NULL;
