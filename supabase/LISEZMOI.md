# Mettre en place Supabase pour Kind

Environ 20 minutes, dans votre navigateur, sur https://supabase.com. Rien à installer.

**À ne jamais envoyer à personne, ni à Claude** : le mot de passe de la base de données, la clé
`service_role` (ou « secret key »). Les deux seules informations à me transmettre sont l'adresse du
projet et la clé publique (étape 6) : elles sont faites pour être visibles dans une page web.

## 1. Créer le projet (en Europe)

1. Connectez-vous à Supabase, puis **New project**.
2. Nom : `kind`. Région : **West EU (Paris)** (à défaut Frankfurt), pour rester en Europe (RGPD).
3. Choisissez un mot de passe de base de données solide et gardez-le pour vous (gestionnaire de mots de passe).
4. Attendez que le projet soit prêt (1 à 2 minutes).

## 2. Régler la connexion

Menu **Authentication** › **Sign In / Providers** (ou *Providers* selon la version) :

1. **Email** : activé. Désactivez **Confirm email** (les comptes conducteurs n'ont pas de vraie adresse).
2. **Allow anonymous sign-ins** : activé (pour les passagers, qui n'ont pas de compte).

Menu **Authentication** › **URL Configuration** : *Site URL* = `https://thomaspeignard-arch.github.io/kind/`

## 3. Créer les tables

Menu **SQL Editor** › **New query** :

1. Copiez tout le contenu de `supabase/schema.sql`, collez, puis **Run**. Le résultat doit être « Success ».
2. Nouvelle requête : copiez tout `supabase/gtfs-imagine.sql` (lignes et arrêts d'Épinal), **Run**.

Les deux fichiers peuvent être relancés sans risque (pas de doublon).

## 4. Créer les comptes

Menu **Authentication** › **Users** › **Add user** › **Create new user**, en cochant **Auto Confirm User** :

| Compte | E-mail | Mot de passe |
|---|---|---|
| Vous (responsable d'exploitation) | votre adresse | un mot de passe solide |
| Un conducteur de test, code `C-1042` | `c-1042@conducteurs.example.com` | son **PIN à 6 chiffres** |

Pour chaque conducteur : l'adresse est son code en minuscules suivi de `@conducteurs.example.com`
(adresse fictive, aucun e-mail n'est envoyé), et le mot de passe est son PIN à 6 chiffres.

## 5. Donner un rôle à chaque compte

**SQL Editor** › nouvelle requête, en remplaçant `VOTRE_EMAIL` :

```sql
insert into profils (user_id, reseau_id, role)
select id, 'imagine', 'responsable' from auth.users where email = 'VOTRE_EMAIL';

insert into profils (user_id, reseau_id, role, code_conducteur)
select id, 'imagine', 'conducteur', 'C-1042' from auth.users where email = 'c-1042@conducteurs.example.com';
```

Pour un compte d'autorité organisatrice (résultats agrégés par ligne seulement), même chose avec le rôle `'ao'`.

## 6. Me transmettre l'adresse et la clé publique

Menu **Project Settings** › **API** (ou **Data API** et **API Keys**) :

- **Project URL** : de la forme `https://xxxxxxxx.supabase.co`
- **clé publique** : `anon public`, ou `publishable` (commence par `sb_publishable_` ou `eyJ`)

Envoyez-moi ces deux valeurs. Je les mettrai dans `commun/supabase-config.js`, puis je brancherai
l'envoi des trajets depuis l'appli et le tableau de bord d'exploitation.

## À savoir

- Projet gratuit : il se met en pause après une semaine sans activité ; un clic sur **Restore** dans
  Supabase le réveille.
- Qui voit quoi : un conducteur voit ses trajets ; le responsable voit tous les trajets du réseau ;
  l'autorité organisatrice ne voit que des moyennes par ligne et par mois, à partir de 5 trajets,
  sans conducteur. Les trajets de test et les démos ne sont jamais comptés.
- Les données brutes (CSV compressés) vont dans le stockage privé `trajets-bruts`, pour pouvoir les
  réanalyser avec le script Python de référence.
