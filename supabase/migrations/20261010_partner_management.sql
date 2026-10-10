-- 浙江民办校作战地图：渠道与售后服务点集合升级（2026-10-10）
-- 已建库项目在 Supabase SQL Editor 中以项目管理员执行整份脚本。
-- 事务可重复执行；仅扩展集合约束和保存 RPC，不修改记录、成员或版本。
begin;

alter table public.school_map_records
  drop constraint if exists school_map_records_collection_check;
alter table public.school_map_records
  add constraint school_map_records_collection_check check (collection in (
    'schools', 'deliveries', 'opportunities', 'persons', 'stakeholders',
    'channels', 'servicePoints'
  ));

-- CREATE OR REPLACE 保留现有函数的 owner 与 EXECUTE 权限。
-- 原成员检查、版本冲突、批次回滚和空 search_path 均保留。
create or replace function public.apply_school_map_changes(
  p_workspace_id text,
  p_changes jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_change jsonb;
  v_collection text;
  v_id text;
  v_base_version bigint;
  v_conflicts jsonb;
  v_results jsonb := '[]'::jsonb;
  v_record public.school_map_records%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = '请先登录沙盘成员账号';
  end if;

  -- 锁住本人的成员记录，避免写入中途撤销权限。
  perform 1 from public.school_map_members
    where workspace_id = p_workspace_id and user_id = v_user_id
    for share;
  if not found then
    raise exception using errcode = '42501', message = '当前账号没有该工作区权限';
  end if;

  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'array' then
    raise exception using errcode = '22023', message = 'p_changes 必须为 JSON 数组';
  end if;
  if pg_catalog.jsonb_array_length(p_changes) > 2000 then
    raise exception using errcode = '22023', message = '单次最多保存 2000 条变更';
  end if;

  -- 同一工作区的 RPC 按顺序提交；避免多记录批次之间的交叉锁死。
  perform 1 from public.school_map_workspaces
    where id = p_workspace_id for update;
  if not found then
    raise exception using errcode = '42501', message = '工作区不存在';
  end if;

  for v_change in select value from pg_catalog.jsonb_array_elements(p_changes)
  loop
    if pg_catalog.jsonb_typeof(v_change) <> 'object'
       or pg_catalog.jsonb_typeof(v_change -> 'collection') is distinct from 'string'
       or (v_change ->> 'collection') not in (
         'schools', 'deliveries', 'opportunities', 'persons', 'stakeholders',
         'channels', 'servicePoints'
       ) then
      raise exception using errcode = '22023', message = '不支持的业务数据类型';
    end if;

    if pg_catalog.jsonb_typeof(v_change -> 'id') is distinct from 'string'
       or pg_catalog.length(v_change ->> 'id') not between 1 and 200
       or pg_catalog.jsonb_typeof(v_change -> 'payload') is distinct from 'object'
       or pg_catalog.jsonb_typeof(v_change -> 'payload' -> 'id') is distinct from 'string'
       or (v_change -> 'payload' ->> 'id') is distinct from (v_change ->> 'id') then
      raise exception using errcode = '22023', message = '记录 id 与 payload.id 必须一致';
    end if;

    if pg_catalog.jsonb_typeof(v_change -> 'deleted') is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'deleted 必须为布尔值';
    end if;

    if pg_catalog.jsonb_typeof(v_change -> 'base_version') is distinct from 'number'
       or (v_change ->> 'base_version') !~ '^[0-9]+$' then
      raise exception using errcode = '22023', message = 'base_version 必须为非负整数';
    end if;
    if (v_change ->> 'base_version')::numeric > 9007199254740991 then
      raise exception using errcode = '22023', message = 'base_version 超出浏览器安全整数范围';
    end if;
  end loop;

  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) item
    group by item ->> 'collection', item ->> 'id'
    having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = '同一批次不能重复提交同一条记录';
  end if;

  -- 检查整个批次，任意一条版本过期都不写入任何记录。
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'collection', item ->> 'collection',
    'id', item ->> 'id',
    'expected', (item ->> 'base_version')::bigint,
    'actual', coalesce(record.version, 0)
  )), '[]'::jsonb)
    into v_conflicts
    from pg_catalog.jsonb_array_elements(p_changes) item
    left join public.school_map_records record
      on record.workspace_id = p_workspace_id
      and record.collection = item ->> 'collection'
      and record.id = item ->> 'id'
    where coalesce(record.version, 0) <> (item ->> 'base_version')::bigint;

  if pg_catalog.jsonb_array_length(v_conflicts) > 0 then
    raise exception using
      errcode = '40001',
      message = '其他成员已修改相同记录，请保留本地备份后重新加载云端数据',
      detail = pg_catalog.jsonb_build_object('conflicts', v_conflicts)::text;
  end if;

  for v_change in select value from pg_catalog.jsonb_array_elements(p_changes)
  loop
    v_collection := v_change ->> 'collection';
    v_id := v_change ->> 'id';
    v_base_version := (v_change ->> 'base_version')::bigint;

    insert into public.school_map_records as existing (
      workspace_id, collection, id, payload, version, deleted, updated_at, updated_by
    ) values (
      p_workspace_id, v_collection, v_id, v_change -> 'payload',
      1, (v_change ->> 'deleted')::boolean, pg_catalog.now(), v_user_id
    )
    on conflict (workspace_id, collection, id) do update
      set payload = excluded.payload,
          version = existing.version + 1,
          deleted = excluded.deleted,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      where existing.version = v_base_version
    returning * into v_record;

    -- 防止管理员直接改表等 RPC 之外的写入与该批次相互覆盖。
    if not found then
      select coalesce(version, 0) into v_base_version
        from public.school_map_records
        where workspace_id = p_workspace_id and collection = v_collection and id = v_id;
      raise exception using
        errcode = '40001',
        message = '记录版本已变化，整个批次已撤销',
        detail = pg_catalog.jsonb_build_object('conflicts', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'collection', v_collection, 'id', v_id,
            'expected', (v_change ->> 'base_version')::bigint,
            'actual', coalesce(v_base_version, 0)
          )
        ))::text;
    end if;

    v_results := v_results || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_record));
  end loop;

  return pg_catalog.jsonb_build_object('records', v_results);
end;
$$;

commit;
