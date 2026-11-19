# Plan du prototype Kind (appli web d'abord)

## Étape 1 — Mise en route
1. Initialiser un dépôt Git dans `C:\dev\kind`, créer un dépôt GitHub et activer GitHub Pages (HTTPS).
2. Publier `reference/web/kind-live-temps-reel.html` comme première version, l'ouvrir sur le téléphone du porteur, tester le mode démo puis un vrai trajet.

## Étape 2 — Analyse dans le navigateur
1. Porter en JavaScript l'algorithme de `reference/analyse/` : calibrage, axes par le GPS, événements, notes, seuils par profil.
2. Vérifier sur `data/trajet-test-...zip` que l'on retrouve les résultats de la référence Python (score bus 57, voiture 89 ; freinages 54, accélérations 51, virages 63 en profil bus).

## Étape 3 — Parcours conducteur
1. Identification (code conducteur + PIN), choix du véhicule et du profil.
2. Démarrage automatique de l'enregistrement quand le véhicule roule ; trajet à vide non noté.
3. Reconnaissance des courses par le GTFS (`data/gtfs-imagine-epinal.zip`) : début au premier arrêt de la ligne, bouton « Début de course » en secours.
4. Fin de service : ressenti avant le score, puis bilan (design : `reference/web/bilan-conducteur-mobile.html`).

## Étape 4 — Supabase
1. Projet hébergé en Europe ; tables réseaux, lignes, arrêts, conducteurs, véhicules, services, courses, événements, ressentis ; règles d'accès.
2. Import du GTFS d'Épinal.
3. Envoi des courses depuis l'appli web (avec file d'attente locale si pas de réseau) ; données brutes dans le stockage.

## Étape 5 — Tableau de bord exploitation
1. Reprendre `reference/web/tableau-de-bord-exploitation.html` sur les vraies données Supabase.
2. Filtres période, ligne, conducteur ; aménagements à étudier ; formation ciblée.

## Ensuite — Pilote
Appli Android native (Kotlin) pour un enregistrement fiable toute la journée, mêmes serveur et tableau de bord. Notice conducteur, consultation du CSE, note RGPD, convention de pilote, téléphones dédiés.
