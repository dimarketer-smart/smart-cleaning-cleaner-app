-- Неудачные переносы сделки в CRM при смене статуса заказа. cron повторяет их; успешный перенос удаляет строку.
create table if not exists crm_sync_errors (
  order_id   bigint primary key references orders(id) on delete cascade,
  to_status  text not null,
  error      text not null,
  attempts   int  not null default 1,
  updated_at timestamptz not null default now()
);
alter table crm_sync_errors enable row level security;
grant select, insert, update, delete on crm_sync_errors to service_role;
notify pgrst, 'reload schema';
