create extension if not exists vector with schema extensions;

alter table public.appraisals
    add column if not exists image_embedding extensions.vector(1408);

create index if not exists appraisals_image_embedding_hnsw_idx
    on public.appraisals
    using hnsw (image_embedding extensions.vector_cosine_ops)
    where image_embedding is not null;

create or replace function public.find_appraisal_by_image_embedding(
    p_image_embedding extensions.vector(1408),
    p_match_threshold real default 0.72,
    p_match_count integer default 3
)
returns table (appraisal_id uuid, similarity real)
language sql
stable
security definer
set search_path = extensions
as $$
    select
        a.id,
        (1 - (a.image_embedding <=> p_image_embedding))::real as similarity
    from public.appraisals as a
    where a.image_embedding is not null
      and 1 - (a.image_embedding <=> p_image_embedding) >= p_match_threshold
    order by a.image_embedding <=> p_image_embedding
    limit least(greatest(p_match_count, 1), 5)
$$;

revoke all on function public.find_appraisal_by_image_embedding(
    extensions.vector, real, integer
) from public, anon, authenticated;
grant execute on function public.find_appraisal_by_image_embedding(
    extensions.vector, real, integer
) to service_role;
