create table if not exists public.appraisals (
    id uuid primary key default gen_random_uuid(),
    object_name text not null,
    brand text,
    model text,
    category text,
    rarity text,
    scan_summary text,
    objects jsonb not null default '[]'::jsonb,
    image_path text,
    created_at timestamptz not null default now()
);

create index if not exists appraisals_brand_model_idx
    on public.appraisals (lower(btrim(brand)), lower(btrim(model)));

alter table public.appraisals enable row level security;
revoke all on public.appraisals from public, anon, authenticated;
grant select on public.appraisals to anon, authenticated;
grant all on public.appraisals to service_role;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'appraisals'
          and policyname = 'Anyone can read appraisals'
    ) then
        create policy "Anyone can read appraisals"
            on public.appraisals
            for select
            to anon, authenticated
            using (true);
    end if;
end
$$;

insert into storage.buckets (id, name, public)
values ('appraisal-images', 'appraisal-images', true)
on conflict (id) do update set public = true;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'storage'
          and tablename = 'objects'
          and policyname = 'Anyone can view appraisal images'
    ) then
        create policy "Anyone can view appraisal images"
            on storage.objects
            for select
            to anon, authenticated
            using (bucket_id = 'appraisal-images');
    end if;
end
$$;

create table if not exists public.scan_rate_limits (
    ip_hash text primary key,
    window_started_at timestamptz not null,
    request_count integer not null check (request_count > 0)
);

create index if not exists scan_rate_limits_window_started_at_idx
    on public.scan_rate_limits (window_started_at);

alter table public.scan_rate_limits enable row level security;
revoke all on public.scan_rate_limits from public, anon, authenticated;
grant all on public.scan_rate_limits to service_role;

create or replace function public.find_appraisal_match(p_brand text, p_model text)
returns setof public.appraisals
language sql
stable
security definer
set search_path = ''
as $$
    select a.*
    from public.appraisals as a
    where nullif(btrim(p_brand), '') is not null
      and nullif(btrim(p_model), '') is not null
      and lower(btrim(a.brand)) = lower(btrim(p_brand))
      and lower(btrim(a.model)) = lower(btrim(p_model))
    order by a.created_at asc
    limit 1
$$;

revoke all on function public.find_appraisal_match(text, text) from public, anon, authenticated;
grant execute on function public.find_appraisal_match(text, text) to service_role;

create or replace function public.consume_scan_rate_limit(
    p_ip_hash text,
    p_window_seconds integer,
    p_max_requests integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    current_count integer;
begin
    if random() < 0.01 then
        delete from public.scan_rate_limits
        where window_started_at < now() - make_interval(secs => p_window_seconds * 24);
    end if;

    insert into public.scan_rate_limits (ip_hash, window_started_at, request_count)
    values (p_ip_hash, now(), 1)
    on conflict (ip_hash) do update
    set request_count = case
            when public.scan_rate_limits.window_started_at
                <= now() - make_interval(secs => p_window_seconds)
            then 1
            else public.scan_rate_limits.request_count + 1
        end,
        window_started_at = case
            when public.scan_rate_limits.window_started_at
                <= now() - make_interval(secs => p_window_seconds)
            then now()
            else public.scan_rate_limits.window_started_at
        end
    returning request_count into current_count;

    return current_count <= p_max_requests;
end
$$;

revoke all on function public.consume_scan_rate_limit(text, integer, integer)
    from public, anon, authenticated;
grant execute on function public.consume_scan_rate_limit(text, integer, integer)
    to service_role;
