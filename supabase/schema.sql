-- Kind — schéma Supabase (PostgreSQL)
-- À lancer une fois dans Supabase › SQL Editor, sur un projet hébergé en Europe.
-- Relançable : les objets existants sont conservés ou remplacés.
--
-- Qui voit quoi (règles d'accès, « Row Level Security ») :
--   conducteur   : ses propres trajets ;
--   passager     : ses propres trajets (connexion anonyme) ;
--   responsable  : tous les trajets de son réseau ;
--   ao (autorité organisatrice) : seulement des résultats agrégés par ligne (vue ao_lignes),
--                  jamais un trajet ni un conducteur, et seulement à partir de 5 trajets.
-- Les trajets de test et les démos ne sont jamais comptés dans les agrégats.

-- ---------- réseau, lignes, arrêts (import du GTFS : supabase/gtfs-imagine.sql) ----------
create table if not exists reseaux (
  id        text primary key,                       -- par exemple 'imagine'
  nom       text not null,
  pays      text not null default 'FR',
  -- réglages de l'exploitant ; vitesse_pics : off (défaut) | conducteur | troncons | nominatif (pas en France)
  options   jsonb not null default '{"vitesse_pics":"off"}'
);

create table if not exists lignes (
  reseau_id text not null references reseaux(id) on delete cascade,
  id        text not null,
  nom_court text not null,
  nom       text,
  couleur   text,
  primary key (reseau_id, id)
);

create table if not exists arrets (
  reseau_id text not null references reseaux(id) on delete cascade,
  id        text not null,
  nom       text not null,
  lat       double precision not null,
  lon       double precision not null,
  primary key (reseau_id, id)
);

-- ---------- personnes ----------
-- Un profil par compte Supabase (auth.users). Les conducteurs sont pseudonymisés : seul leur code est connu.
create table if not exists profils (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  reseau_id       text not null references reseaux(id),
  role            text not null check (role in ('conducteur', 'responsable', 'ao')),
  code_conducteur text,
  cree_le         timestamptz not null default now()
);

-- fonctions d'aide aux règles d'accès (security definer : évite que les règles se lisent elles-mêmes en boucle)
create or replace function public.mon_role(r text) returns text
  language sql stable security definer set search_path = public as
$$ select role from profils where user_id = auth.uid() and reseau_id = r $$;

create or replace function public.mon_reseau() returns text
  language sql stable security definer set search_path = public as
$$ select reseau_id from profils where user_id = auth.uid() $$;

-- ---------- trajets ----------
-- Un trajet = un service conducteur ou un trajet passager, avec ses résultats calculés dans le téléphone.
create table if not exists trajets (
  id              uuid primary key default gen_random_uuid(),
  reseau_id       text not null references reseaux(id),
  auteur          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id_local        bigint not null,                  -- identifiant dans le téléphone : renvoyer deux fois ne crée pas de doublon
  role            text not null check (role in ('conducteur', 'passager')),
  code_conducteur text,                             -- pseudonyme, null pour un passager
  mode            text not null check (mode in ('ligne', 'libre', 'test')),
  ligne_id        text,
  sens            int,
  vehicule        text,
  profil          text not null check (profil in ('bus', 'car', 'voiture')),
  campagne        text,                             -- code de campagne de mesure (passagers)
  simulation      boolean not null default false,   -- démo : jamais comptée
  debut           timestamptz not null,
  fin             timestamptz,
  score           int,
  sous_notes      jsonb,                            -- freinages, accélérations, virages
  ressenti        numeric(3, 1) check (ressenti between 0 and 10),
  vitesse         jsonb,                            -- vitesse commerciale, roulage, temps à l'arrêt
  aux_arrets      jsonb,                            -- accostage et départ d'arrêt
  qualite         jsonb,                            -- qualité de la mesure
  ponctualite     jsonb,                            -- rattachement GTFS par course
  ralentissements jsonb,
  fichier_brut    text,                             -- chemin du CSV compressé dans le stockage
  recu_le         timestamptz not null default now(),
  unique (auteur, id_local)
);
create index if not exists trajets_reseau_debut on trajets (reseau_id, debut);
create index if not exists trajets_ligne on trajets (reseau_id, ligne_id);

create table if not exists courses (
  trajet_id   uuid not null references trajets(id) on delete cascade,
  n           int not null,
  t_debut     real, t_fin real,
  sens        int,
  destination text,
  score       int,
  trip_id     text,                                 -- course GTFS rattachée, null si hors service
  primary key (trajet_id, n)
);

create table if not exists evenements (
  trajet_id uuid not null references trajets(id) on delete cascade,
  course_n  int,
  critere   text not null,                          -- freinage, accélération, virage
  type      text,                                   -- virage à droite / à gauche…
  niveau    int not null check (niveau between 0 and 3),
  t         real not null,
  pic       real,
  kmh       int,
  lat       double precision,
  lon       double precision
);
create index if not exists evenements_trajet on evenements (trajet_id);

-- ---------- règles d'accès ----------
alter table reseaux    enable row level security;
alter table lignes     enable row level security;
alter table arrets     enable row level security;
alter table profils    enable row level security;
alter table trajets    enable row level security;
alter table courses    enable row level security;
alter table evenements enable row level security;

-- le réseau, ses lignes et ses arrêts sont publics (données GTFS ouvertes)
drop policy if exists lecture_publique on reseaux;  create policy lecture_publique on reseaux  for select using (true);
drop policy if exists lecture_publique on lignes;   create policy lecture_publique on lignes   for select using (true);
drop policy if exists lecture_publique on arrets;   create policy lecture_publique on arrets   for select using (true);

-- chacun lit son propre profil
drop policy if exists mon_profil on profils;
create policy mon_profil on profils for select using (user_id = auth.uid());

-- trajets : chacun envoie et relit les siens ; le responsable lit ceux de son réseau
drop policy if exists envoyer on trajets;
-- un trajet « conducteur » doit venir du compte de ce conducteur, dans son réseau ;
-- un passager (connexion anonyme) ne peut envoyer que des trajets « passager », sans code conducteur
create policy envoyer on trajets for insert with check (
  auteur = auth.uid() and (
    (role = 'passager' and code_conducteur is null)
    or (role = 'conducteur' and exists (select 1 from profils p where p.user_id = auth.uid() and p.role = 'conducteur'
                                        and p.code_conducteur = trajets.code_conducteur and p.reseau_id = trajets.reseau_id))));
drop policy if exists corriger on trajets;
create policy corriger on trajets for update using (auteur = auth.uid())
  with check (auteur = auth.uid() and (role = 'passager' or exists (select 1 from profils p where p.user_id = auth.uid()
              and p.role = 'conducteur' and p.code_conducteur = trajets.code_conducteur and p.reseau_id = trajets.reseau_id)));
drop policy if exists lire on trajets;
create policy lire on trajets for select using (auteur = auth.uid() or mon_role(reseau_id) = 'responsable');

-- courses et événements suivent leur trajet
drop policy if exists envoyer on courses;
create policy envoyer on courses for insert with check (exists (select 1 from trajets t where t.id = trajet_id and t.auteur = auth.uid()));
drop policy if exists remplacer on courses;
create policy remplacer on courses for delete using (exists (select 1 from trajets t where t.id = trajet_id and t.auteur = auth.uid()));
drop policy if exists lire on courses;
create policy lire on courses for select using (exists (select 1 from trajets t where t.id = trajet_id and (t.auteur = auth.uid() or mon_role(t.reseau_id) = 'responsable')));

drop policy if exists envoyer on evenements;
create policy envoyer on evenements for insert with check (exists (select 1 from trajets t where t.id = trajet_id and t.auteur = auth.uid()));
drop policy if exists remplacer on evenements;
create policy remplacer on evenements for delete using (exists (select 1 from trajets t where t.id = trajet_id and t.auteur = auth.uid()));
drop policy if exists lire on evenements;
create policy lire on evenements for select using (exists (select 1 from trajets t where t.id = trajet_id and (t.auteur = auth.uid() or mon_role(t.reseau_id) = 'responsable')));

-- ---------- vue agrégée pour l'autorité organisatrice ----------
-- Par ligne et par mois, hors tests et démos, à partir de 5 trajets. Sans conducteur ni trajet individuel.
-- La vue s'exécute avec les droits de son créateur : elle ne renvoie que le réseau de la personne connectée
-- (responsable ou ao).
create or replace view ao_lignes with (security_invoker = false) as
select t.reseau_id, t.ligne_id, date_trunc('month', t.debut)::date as mois,
       count(*)                                                    as trajets,
       round(avg(t.score))                                         as score_moyen,
       round(avg((t.vitesse->>'vitesse_commerciale_kmh')::numeric), 1) as vitesse_commerciale_kmh,
       round(avg((t.qualite->>'douteuse')::boolean::int) * 100)    as part_mesures_douteuses
from trajets t
where t.mode <> 'test' and not t.simulation and t.ligne_id is not null
  and t.reseau_id = mon_reseau() and mon_role(t.reseau_id) in ('responsable', 'ao')
group by 1, 2, 3
having count(*) >= 5;
revoke all on ao_lignes from anon;
grant select on ao_lignes to authenticated;

-- ---------- stockage des données brutes ----------
-- Seau privé « trajets-bruts » : chaque auteur dépose ses CSV compressés dans un dossier à son identifiant ;
-- le responsable du réseau peut les relire pour les réanalyser avec la référence Python.
insert into storage.buckets (id, name, public) values ('trajets-bruts', 'trajets-bruts', false) on conflict (id) do nothing;
drop policy if exists "deposer ses donnees brutes" on storage.objects;
create policy "deposer ses donnees brutes" on storage.objects for insert to authenticated
  with check (bucket_id = 'trajets-bruts' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "relire les donnees brutes" on storage.objects;
create policy "relire les donnees brutes" on storage.objects for select to authenticated
  using (bucket_id = 'trajets-bruts' and ((storage.foldername(name))[1] = auth.uid()::text
         or exists (select 1 from trajets t where t.fichier_brut = name and mon_role(t.reseau_id) = 'responsable')));
