# Kind — mesure de la douceur de conduite des bus

Nom de code du projet : **Kind**. Ce fichier donne le contexte complet à Claude Code. Le porteur du projet n'est pas développeur : explique ce que tu fais en français simple, demande avant toute action irréversible, et fais-lui lancer les tests sur son téléphone.

## Le produit

Une appli smartphone, fixée dans la cabine, qui mesure la douceur de conduite (freinages, accélérations, virages, à-coups) avec les capteurs du téléphone, sans boîtier. Objectif : le confort et la sécurité des passagers (surtout debout et âgés), pas l'éco-conduite.

Deux publics :
- **Conducteur** (smartphone) : indicateur en temps réel « verre d'eau », bilan de fin de service, coaching automatique.
- **Responsable d'exploitation et autorité organisatrice** (ordinateur) : tableau de bord par période, ligne, conducteur, arrêt.

Marchés : bus urbains d'abord, transport scolaire dès le départ (autocars), puis transport de personnes à mobilité réduite, auto-écoles. International à moyen terme.

## Périmètre du prototype (priorité au fonctionnel)

**Choix : appli web d'abord**, pour tester et faire des démos vite, sur n'importe quel téléphone (iPhone compris), sans rien installer côté utilisateur. L'appli Android native (Kotlin) viendra ensuite pour le pilote, avec le même serveur et le même tableau de bord.

1. **Appli conducteur web** (page unique, installable comme application web, mobile d'abord), qui reprend et complète `reference/web/kind-live-temps-reel.html`.
2. **Back-end Supabase** (le porteur a un compte), hébergé en Europe (RGPD).
3. **Bilan conducteur** dans l'appli web.
4. **Tableau de bord exploitation** web, branché sur Supabase.

Pile technique : HTML, CSS et JavaScript simples (modules ES), client Supabase JS, pas de framework lourd ni d'étape de compilation obligatoire. Hébergement gratuit en HTTPS (GitHub Pages, obligatoire pour accéder aux capteurs). Le porteur est sous Windows, avec Git et VS Code installés ; Android Studio et Flutter ne sont pas nécessaires pour cette phase.

Réseau de test : Imagine (agglomération d'Épinal), GTFS dans `data/`.

## Parcours conducteur

1. S'identifier une fois par service (code conducteur pseudonymisé + code PIN, ou badge). Le téléphone peut être partagé par véhicule.
2. Démarrer le service : choix ou détection du véhicule et du service.
3. Enregistrement automatique dès que le véhicule roule.
4. Le trajet à vide (dépôt → premier arrêt) est enregistré mais **non noté**. La course commence quand le bus atteint le premier arrêt de sa ligne (géorepérage GTFS, ~30 m) ou quand le conducteur appuie sur « Début de course ». Les courses s'enchaînent et sont reconnues par le GTFS (ligne, sens, horaire).
5. Fin de service : retour dépôt non noté ; le conducteur note son **ressenti avant de voir son score** (pour mesurer l'écart ressenti / mesuré), puis voit le bilan de la journée.

Pendant la conduite : seul le verre d'eau s'affiche, rien à lire. Écran maintenu allumé.

## Algorithme (référence validée en Python : `reference/analyse/`)

Testé sur un vrai trajet (`data/trajet-test-...zip`, export Sensor Logger) : concordance 99 % avec le GPS en avant/arrière, 95 % en latéral.

- Utiliser l'**accélération totale** (gravité comprise), pas l'accélération « linéaire » fusionnée d'Android : sur le Xiaomi de test, le **gyroscope est peu fiable** (cap intégré −12° contre +183° au GPS) et fausse la fusion.
- Verticale = gravité moyenne mesurée à l'arrêt (vitesse GPS < 0,3 m/s). Recalibrage lent à chaque arrêt.
- Projection dans le plan horizontal, filtre passe-bas 1,5 Hz (ce que ressent un passager).
- **Axe avant** : régression entre l'accélération horizontale et l'accélération déduite de la vitesse GPS. **Signe du latéral** : comparaison avec v × variation du cap GPS (cap qui augmente = virage à droite).
- Biais lents (pente, dévers) retirés par comparaison au GPS (passe-bas 0,05 Hz) en analyse différée ; en temps réel, passe-haut ~15 s.
- À-coup (jerk) : dérivée de l'accélération filtrée à 1 Hz.
- **Découpage en événements** (`evenements.py`) : freinages, accélérations, virages = épisodes où |a| ≥ 0,6 m/s² pendant ≥ 1 s. Niveau de chaque événement selon son pic et son à-coup.
- **Notes** : 100 doux, 70 limite, 30 brusque, 0 très brusque. Note par critère et score global = moyenne des événements.
- Chaque événement est rattaché à l'arrêt GTFS le plus proche (≤ 150 m) avec « à l'approche de » / « au départ de ».

### Seuils par profil de véhicule (m/s² : limite / brusque / très brusque ; à-coup m/s³)

| Profil | Accélération | À-coup |
|---|---|---|
| Bus urbain, passagers debout | 1,0 / 1,5 / 2,5 | 1,5 / 3 / 5 |
| Autocar, passagers assis et attachés | 1,5 / 2,5 / 3,5 | 2,5 / 5 / 8 |
| Voiture | 2,0 / 3,0 / 4,0 | 3 / 6 / 10 |

Source bus : Krašna et al. 2021 (`docs/`) — rester sous 1,5 m/s² en pointe et 1,0 m/s² au freinage, valeurs à abaisser pour les personnes âgées. Seuils indicatifs, à valider.

## Points techniques critiques

- **Capteurs dans le navigateur** : `DeviceMotionEvent` (avec demande d'autorisation sur iPhone) et `navigator.geolocation.watchPosition`. Page servie en HTTPS obligatoirement.
- **Limite connue de l'appli web** : l'enregistrement s'arrête si l'écran s'éteint ou si l'on change d'appli. Utiliser l'API Wake Lock pour garder l'écran allumé, prévenir le conducteur, détecter et signaler les trous dans les données. C'est acceptable pour les tests et démos (téléphone fixé et branché), pas pour une journée de service complète : ce sera le rôle de l'appli Android native.
- Sur le trajet de test, Android a coupé l'accéléromètre 145 s alors que le GPS continuait : toujours détecter ces trous.
- Stocker le trajet en cours localement (IndexedDB) et l'envoyer à Supabase quand le réseau est disponible, pour ne rien perdre en cas de coupure.
- Calcul des événements et des notes dans le navigateur à la fin de chaque course (porter `reference/analyse/` en JavaScript). Conserver aussi les données brutes compressées dans le stockage Supabase, pour pouvoir les réanalyser avec la référence Python.

## Données (Supabase, à créer)

Réseaux, lignes et arrêts (import GTFS), conducteurs (pseudonymes), véhicules, services, courses, événements notés, ressentis. Règles d'accès : un conducteur ne voit que ses trajets ; le responsable voit son réseau ; l'autorité organisatrice voit des résultats agrégés par ligne.

## Charte graphique (sobre, pas « look IA »)

Fond clair `#F6F6F4`, cartes blanches bordure `#E2E2DD`, texte `#1C1F23`, secondaire `#646A72`, accent bleu réseau `#1F4E79`. Police IBM Plex Sans. Angles faibles (6-10 px). Couleurs réservées aux données : doux `#3B82C4`, limite `#D4A017`, brusque `#E07B39`, très brusque `#C0392B`, bon `#3F8F6B`. Icônes au trait : freinage (flèche contre une barre), accélération (double chevron), virage (flèche courbe gauche/droite). Le verre d'eau : liquide qui penche avec l'accélération, couleur et bord d'écran selon le niveau.

## Références dans ce dossier

- `reference/web/kind-live-temps-reel.html` : prototype web du verre d'eau en temps réel (DeviceMotion + GPS), avec mode démo.
- `reference/web/bilan-conducteur-mobile.html` : design final du bilan conducteur.
- `reference/web/tableau-de-bord-exploitation.html` + `demo.json` : design du tableau de bord (données simulées).
- `reference/web/analyse-trajet-exploitation.html` : analyse détaillée d'un trajet.
- `reference/analyse/*.py` : algorithme de référence (pandas, numpy, scipy).

## Plan de travail

Voir `docs/PLAN.md`.
