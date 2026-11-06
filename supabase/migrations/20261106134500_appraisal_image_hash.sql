alter table public.appraisals
    add column if not exists image_hash text;

create index if not exists appraisals_image_hash_idx
    on public.appraisals (image_hash)
    where image_hash is not null;

create or replace function public.find_appraisal_by_image_hash(
    p_image_hash text,
    p_max_distance integer default 8
)
returns setof public.appraisals
language sql
stable
security definer
set search_path = ''
as $$
    select a.*
    from public.appraisals as a
    cross join lateral (
        select sum(
            bit_count((
                get_byte(decode(a.image_hash, 'hex'), bytes.byte_index)
                # get_byte(decode(lower(p_image_hash), 'hex'), bytes.byte_index)
            )::bit(8))
        ) as distance
        from generate_series(0, 7) as bytes(byte_index)
    ) as image_distance
    where p_image_hash ~* '^[0-9a-f]{16}$'
      and p_max_distance between 0 and 16
      and a.image_hash is not null
      and image_distance.distance <= p_max_distance
    order by image_distance.distance, a.created_at asc
    limit 1
$$;

revoke all on function public.find_appraisal_by_image_hash(text, integer)
    from public, anon, authenticated;
grant execute on function public.find_appraisal_by_image_hash(text, integer)
    to service_role;
