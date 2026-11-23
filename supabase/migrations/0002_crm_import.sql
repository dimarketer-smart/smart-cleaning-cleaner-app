-- Импорт заказов из CRM Big Prodast.
-- Заказ помнит сделку, из которой создан: повторно та же сделка не импортируется.
alter table orders add column if not exists crm_deal_id     text unique;
alter table orders add column if not exists crm_deal_number int;

-- Сделки, которые стоят на этапе импорта, но не прошли проверку (нет адреса, даты, м² и т. п.).
-- Админу пишем один раз на каждую новую причину; когда сделку поправят и она импортируется, строка удаляется.
create table if not exists crm_import_issues (
  deal_id     text primary key,
  deal_number int,
  reason      text not null,
  updated_at  timestamptz not null default now()
);
alter table crm_import_issues enable row level security;
