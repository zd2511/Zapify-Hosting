-- Run this once in the Supabase SQL editor.
create extension if not exists pgcrypto;
create table if not exists public.projects (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 site_name text not null check (char_length(site_name) between 1 and 60),
 slug text not null unique,
 cf_project_name text unique,
 cf_deployment_id text,
 live_url text,
 status text not null default 'draft' check (status in ('draft','deploying','published','failed')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists projects_user_created_idx on public.projects(user_id,created_at desc);
alter table public.projects enable row level security;
drop policy if exists "read own projects" on public.projects;
create policy "read own projects" on public.projects for select using (auth.uid()=user_id);
drop policy if exists "create own draft projects" on public.projects;
create policy "create own draft projects" on public.projects for insert with check (auth.uid()=user_id and cf_project_name is null and cf_deployment_id is null and live_url is null and status='draft');
-- No client UPDATE policy. Deployment metadata is changed only by the Worker service role.
