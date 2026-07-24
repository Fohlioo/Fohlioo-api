-- Fohlioo — schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query).
-- Fresh-project script: no migrations, safe to run once on a new project.

create extension if not exists "uuid-ossp";
create extension if not exists vector; -- needed later for AWIN catalogue embeddings, enable now to avoid a second migration

-- Shoppers: one row per extension install. Anonymous until email is set.
create table if not exists shoppers (
  id uuid primary key default gen_random_uuid(),
  extension_id text unique not null,
  email text unique,
  segment text not null default 'unclassified' check (segment in (
    'investment_dresser',
    'trend_chaser',
    'quiet_minimalist',
    'brand_loyalist',
    'unclassified'
  )),
  segment_confidence numeric not null default 0,
  event_count int not null default 0,
  last_active_at timestamptz,
  created_at timestamptz default now()
);

-- Events: append-only raw signal log. This is the source of truth —
-- everything else (signals, segments) is derived from this table.
-- Typed columns cover what the signals engine reads; everything else
-- (dwell_ms, scroll_pct, sizes, section labels, order totals) lives in payload.
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  shopper_id uuid references shoppers(id) not null,
  event_type text not null,
  product_url text,
  product_name text,
  product_brand text,
  product_price numeric,
  original_price numeric,
  currency text,
  category text,
  colour text,
  -- Client-side event time (falls back to server time on insert when the
  -- extension doesn't send one). Signals are computed against occurred_at.
  occurred_at timestamptz not null default now(),
  payload jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_events_shopper_occurred on events (shopper_id, occurred_at);
create index if not exists idx_events_shopper_type_occurred on events (shopper_id, event_type, occurred_at);
create index if not exists idx_events_brand on events (product_brand);

-- Derived signals: computed after each ingest from the events table by
-- lib/signals.ts. Not written directly by the ingestion endpoints.
-- Null means "not derivable yet" (e.g. no purchases → no return_rate).
create table if not exists shopper_signals (
  shopper_id uuid primary key references shoppers(id),
  consideration_arc_days numeric,
  dwell_time_p75_ms numeric,
  return_rate numeric,
  full_price_rate numeric,
  brand_hhi_index numeric,
  colour_palette_entropy numeric,
  purchase_frequency_30d numeric,
  avg_order_value numeric,
  unique_brands_30d int,
  sale_browse_ratio numeric,
  event_count int not null default 0,
  updated_at timestamptz default now()
);

-- Segment history: appended by lib/segments.ts whenever a shopper's segment
-- (or confidence band) changes. Powers Phase 2 segment-migration alerts.
create table if not exists segment_history (
  id uuid primary key default gen_random_uuid(),
  shopper_id uuid references shoppers(id) not null,
  segment text not null,
  confidence numeric not null,
  event_count_at_time int,
  computed_at timestamptz default now()
);

create index if not exists idx_segment_history_shopper on segment_history (shopper_id, computed_at);

-- Bumps a shopper's activity counters in one round trip after a batch insert.
create or replace function increment_shopper_activity(p_shopper_id uuid, p_count int)
returns void
language sql
as $$
  update shoppers
  set event_count = event_count + p_count,
      last_active_at = now()
  where id = p_shopper_id;
$$;

-- Row Level Security — locked down by default. The API writes using the
-- Supabase service role key, which bypasses RLS, so shoppers/extensions
-- never need direct table access. Tighten/extend these policies once the
-- brand analytics portal needs scoped read access.
alter table shoppers enable row level security;
alter table events enable row level security;
alter table shopper_signals enable row level security;
alter table segment_history enable row level security;
