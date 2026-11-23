-- В новых проектах Supabase таблицы, созданные SQL-запросом, не открываются для Data API автоматически:
-- у service_role нет прав на чтение и запись, и функции получают «permission denied for table …».
-- Все функции (api, bot, cron) ходят в базу ключом service_role, поэтому права даём только ему.
-- anon и authenticated не получают ничего: RLS включён, политик нет, из браузера база закрыта.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- То же для таблиц, которые появятся в следующих миграциях
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

notify pgrst, 'reload schema';
