-- Entry and exit times, so a journal can be read back against what the market
-- was doing at that minute. Nullable: existing rows have none, and an author
-- writing up an old trade may not remember the exact time.
ALTER TABLE trade_journals ADD COLUMN IF NOT EXISTS buy_time time;
ALTER TABLE trade_journals ADD COLUMN IF NOT EXISTS sell_time time;
