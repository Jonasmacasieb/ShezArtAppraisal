create or replace function public.find_appraisal_match_by_object_name(p_object_name text)
returns setof public.appraisals
language sql
stable
security definer
set search_path = ''
as $$
    with query_name as (
        select trim(regexp_replace(lower(btrim(p_object_name)), '[^a-z0-9]+', ' ', 'g')) as name
    )
    select a.*
    from public.appraisals as a
    cross join query_name as q
    cross join lateral (
        select trim(regexp_replace(lower(btrim(a.object_name)), '[^a-z0-9]+', ' ', 'g')) as name
    ) as stored
    where q.name <> ''
      and (
        stored.name = q.name
        or (
            array_length(regexp_split_to_array(stored.name, ' '), 1) >= 2
            and stored.name like q.name || '%'
        )
        or (
            array_length(regexp_split_to_array(q.name, ' '), 1) >= 2
            and q.name like stored.name || '%'
        )
      )
    order by (stored.name = q.name) desc, a.created_at asc
    limit 1
$$;

revoke all on function public.find_appraisal_match_by_object_name(text)
    from public, anon, authenticated;
grant execute on function public.find_appraisal_match_by_object_name(text)
    to service_role;
