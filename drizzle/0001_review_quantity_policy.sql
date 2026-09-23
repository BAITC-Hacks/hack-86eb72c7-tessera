-- Политика задаётся источником до публикации снимка; без скрытых значений.
ALTER TABLE products ADD COLUMN quantity_precision integer;
ALTER TABLE products ADD COLUMN quantity_step numeric(30,8);
ALTER TABLE products ADD CONSTRAINT products_quantity_policy_check CHECK (
 (quantity_precision IS NULL AND quantity_step IS NULL) OR
 (quantity_precision IS NOT NULL AND quantity_step IS NOT NULL AND quantity_precision BETWEEN 0 AND 8
  AND quantity_step > 0 AND quantity_step = trunc(quantity_step, quantity_precision))
);
