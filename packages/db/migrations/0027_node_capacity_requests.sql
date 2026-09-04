-- The panel can now ask a node to change its own SERVER_MAX_PEERS. These columns
-- mirror what the node reports about that change; they are a cache, not the
-- source of truth. The node keeps its own spool and answers GET /server/capacity
-- whether or not the panel is around.
--
-- 0026 is taken by the key internal-name change; this is 0027 on purpose.
alter table nodes add column capacity_state text not null default 'idle';
alter table nodes add column capacity_requested_peers integer;
alter table nodes add column capacity_message text;
alter table nodes add column capacity_log text not null default '';
alter table nodes add column capacity_at timestamptz;

comment on column nodes.capacity_state is
  'Mirrored from the node''s capacity spool: idle | requested | running | succeeded | failed.';
comment on column nodes.capacity_requested_peers is
  'The SERVER_MAX_PEERS value of the last request. Not what the node is running - that is reported live.';
