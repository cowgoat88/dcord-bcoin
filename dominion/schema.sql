-- DOOMSTAR: DOMINION — the online tables, for Neon Postgres with the Data API.
--
-- The database stores matches, who sits where, and each person's moves.
-- It never stores the game: every client re-runs each round from the moves.
-- Row-level security does the refereeing: a person may only post for their
-- own seat, once per round and kind, and nobody can read another person's
-- plotted orders until every person in the match has posted theirs.
--
-- auth.user_id() is the signed-in user's id from the request's JWT; the
-- Data API sets it up (pg_session_jwt) when it is enabled. Run this once
-- in the Neon SQL editor after enabling the Data API with Neon Auth.

create table if not exists matches (
  id          uuid primary key default gen_random_uuid(),
  seed        integer not null,
  config      jsonb not null,               -- { seats: [{ faction, name, ai }], draft, council }
  created_by  text not null default auth.user_id(),
  created_at  timestamptz not null default now()
);

create table if not exists seats (
  match_id    uuid not null references matches(id) on delete cascade,
  seat        integer not null,
  user_id     text not null default auth.user_id(),
  joined_at   timestamptz not null default now(),
  primary key (match_id, seat)
);

create table if not exists moves (
  match_id    uuid not null references matches(id) on delete cascade,
  round       integer not null,
  seat        integer not null,
  kind        text not null check (kind in ('draft', 'plot')),
  payload     jsonb not null,
  user_id     text not null default auth.user_id(),
  created_at  timestamptz not null default now(),
  primary key (match_id, round, seat, kind)
);

alter table matches enable row level security;
alter table seats   enable row level security;
alter table moves   enable row level security;

-- Anyone signed in can see a match (to join it by its id) and create one.
create policy matches_read   on matches for select to authenticated using (true);
create policy matches_create on matches for insert to authenticated with check (created_by = auth.user_id());

-- Seats are public within the game; you can only sit yourself down, in a
-- seat the match has for a person (not a rival).
create policy seats_read on seats for select to authenticated using (true);
create policy seats_take on seats for insert to authenticated with check (
  user_id = auth.user_id()
  and exists (
    select 1 from matches m
    where m.id = match_id
      and seat between 1 and jsonb_array_length(m.config -> 'seats')
      and coalesce((m.config -> 'seats' -> (seat - 1) ->> 'ai')::boolean, false) = false
  )
);

-- Moves: only for a seat you hold.
create policy moves_post on moves for insert to authenticated with check (
  user_id = auth.user_id()
  and exists (select 1 from seats s where s.match_id = moves.match_id and s.seat = moves.seat and s.user_id = auth.user_id())
);

-- Draft picks are public at once. Plotted orders are yours alone until
-- every person seated in the match has posted for that round.
create or replace function plot_revealed(p_match uuid, p_round integer) returns boolean
language sql stable security definer set search_path = public as $$
  select (select count(*) from moves where match_id = p_match and round = p_round and kind = 'plot')
      >= (select count(*) from seats where match_id = p_match)
$$;

create policy moves_read on moves for select to authenticated using (
  kind = 'draft'
  or user_id = auth.user_id()
  or plot_revealed(match_id, round)
);

-- No updates or deletes: a posted move is final.
grant select, insert on matches, seats, moves to authenticated;
