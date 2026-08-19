-- Additive auth-link migration for an existing Fohlioo Supabase project.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- Link an anonymous install to a Supabase Auth user.
-- UNIQUE allows many NULL user_id rows (unsigned installs) and at most
-- one shopper per signed-in account.
alter table shoppers
  add column if not exists user_id uuid references auth.users(id);

create unique index if not exists shoppers_user_id_unique
  on shoppers (user_id) where user_id is not null;

-- Maps every extension install to a canonical shopper. Lets a second
-- browser keep sending events after auth merge moved them onto an
-- existing user row.
create table if not exists shopper_installs (
  extension_id text primary key,
  shopper_id uuid references shoppers(id) on delete cascade not null,
  created_at timestamptz default now()
);

create index if not exists idx_shopper_installs_shopper on shopper_installs (shopper_id);

insert into shopper_installs (extension_id, shopper_id)
select extension_id, id from shoppers
on conflict (extension_id) do nothing;

-- Webapp writes these after login; API consumes them on exchange.
create table if not exists extension_auth_codes (
  code text primary key,
  user_id uuid references auth.users(id) not null,
  extension_id text not null,
  expires_at timestamptz not null,
  used boolean default false,
  created_at timestamptz default now()
);

-- App-level user record (webapp will fill this on signup).
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'shopper' check (role in ('shopper', 'brand')),
  first_name text,
  marketing_opt_in boolean default false,
  created_at timestamptz default now()
);

alter table shopper_installs enable row level security;
alter table extension_auth_codes enable row level security;
alter table profiles enable row level security;
