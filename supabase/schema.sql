-- 浙江民办校作战地图：共享工作区与原子增量保存
-- 在 Supabase SQL Editor 中以项目管理员执行。可重复运行；不自动上传业务数据。
begin;

create table if not exists public.school_map_workspaces (
  id text primary key check (length(id) between 1 and 100),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.school_map_members (
  workspace_id text not null references public.school_map_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create index if not exists school_map_members_user_idx
  on public.school_map_members (user_id, workspace_id);

create table if not exists public.school_map_records (
  workspace_id text not null references public.school_map_workspaces(id) on delete cascade,
  collection text not null check (collection in (
    'schools', 'deliveries', 'opportunities', 'persons', 'stakeholders'
  )),
  id text not null check (length(id) between 1 and 200),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and jsonb_typeof(payload -> 'id') is not distinct from 'string'
    and payload ->> 'id' = id
  ),
  version bigint not null default 1 check (version > 0),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  primary key (workspace_id, collection, id)
);

create index if not exists school_map_records_updated_idx
  on public.school_map_records (workspace_id, updated_at);

comment on table public.school_map_records is
  '业务记录；仅成员可读，浏览器写入必须经过 apply_school_map_changes；deleted 保留删除版本，防止旧设备复活记录。';

insert into public.school_map_workspaces (id, name)
values ('zhejiang-schools', '浙江民办校业务沙盘')
on conflict (id) do nothing;

-- 创建工作区不创建成员。登录账号必须由管理员另外加入成员表。
alter table public.school_map_workspaces enable row level security;
alter table public.school_map_members enable row level security;
alter table public.school_map_records enable row level security;

revoke all on table public.school_map_workspaces from public, anon, authenticated;
revoke all on table public.school_map_members from public, anon, authenticated;
revoke all on table public.school_map_records from public, anon, authenticated;
grant select on table public.school_map_members to authenticated;
grant select on table public.school_map_records to authenticated;

drop policy if exists school_map_members_read_self on public.school_map_members;
create policy school_map_members_read_self on public.school_map_members
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists school_map_records_read_member on public.school_map_records;
create policy school_map_records_read_member on public.school_map_records
  for select to authenticated
  using (exists (
    select 1 from public.school_map_members member
    where member.workspace_id = school_map_records.workspace_id
      and member.user_id = (select auth.uid())
  ));

-- 没有 INSERT / UPDATE / DELETE 的 RLS policy，也没有客户端对应表权限。
-- 以下 RPC 使用创建者权限，但始终从 JWT 的 auth.uid() 判断成员身份。
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
         'schools', 'deliveries', 'opportunities', 'persons', 'stakeholders'
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

revoke all on function public.apply_school_map_changes(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_school_map_changes(text, jsonb) to authenticated;

-- 单次读取完整快照，避免 REST 分页期间并发变更造成混合版本。
-- 显式检查成员资格，撤销成员后返回拒绝访问，而不是误认工作区为空。
create or replace function public.read_school_map_snapshot(p_workspace_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_records jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = '请先登录沙盘成员账号';
  end if;

  perform 1 from public.school_map_members
    where workspace_id = p_workspace_id and user_id = v_user_id
    for share;
  if not found then
    raise exception using errcode = '42501', message = '当前账号没有该工作区权限';
  end if;

  select coalesce(pg_catalog.jsonb_agg(
    pg_catalog.to_jsonb(record) order by record.collection, record.id
  ), '[]'::jsonb)
    into v_records
    from public.school_map_records record
    where record.workspace_id = p_workspace_id;

  return pg_catalog.jsonb_build_object('records', v_records);
end;
$$;

revoke all on function public.read_school_map_snapshot(text)
  from public, anon, authenticated;
grant execute on function public.read_school_map_snapshot(text) to authenticated;

-- 开启 Realtime publication，供后续需要订阅推送时使用。
-- 当前网页使用定时拉取，publication 并非保存成功的前提。
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_catalog.pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public' and tablename = 'school_map_records'
     ) then
    alter publication supabase_realtime add table public.school_map_records;
  end if;
end;
$$;

commit;
