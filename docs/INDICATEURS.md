# Kind — indicateurs de vitesse, performance et qualité

Complète CLAUDE.md. Tout se calcule à partir du CSV 5 Hz (vitesse GPS, positions) et du GTFS.

## 1. Vitesse

| Indicateur | Définition | Conducteur | Exploitation |
|---|---|---|---|
| Vitesse commerciale | distance / durée totale du trajet (arrêts compris), km/h | oui | oui, par ligne, tranche horaire, période |
| Vitesse de roulage | distance / temps où v > 3 km/h | oui | oui |
| Part du temps à l'arrêt | arrêts aux points d'arrêt GTFS (≤ 30 m) vs arrêts ailleurs (feux, congestion) | oui | oui |
| Vitesse max du trajet | max de la vitesse GPS lissée (passe-bas 0,15 Hz) | **option** | **option** |
| Dépassements de vitesse | durée et lieux où v > seuil du tronçon | **option** | **option, voir règle ci-dessous** |

### Règle pour l'option « pics de vitesse »

- Paramètre par exploitant : `options.vitesse_pics` = `off` (défaut) | `conducteur` | `troncons` | `nominatif`.
  - `off` : rien n'est calculé ni stocké au-delà de la vitesse moyenne.
  - `conducteur` : le conducteur voit ses propres pics ; l'exploitation ne les voit pas.
  - `troncons` : l'exploitation voit les pics agrégés par tronçon / arrêt / ligne, **sans nom de conducteur** (minimum 5 trajets par agrégat).
  - `nominatif` : visible par conducteur côté exploitation. **Non proposé en France** (voir note CNIL), réservé aux pays où c'est autorisé, activation par un admin avec confirmation.
- Seuil de vitesse : en prototype, un seuil unique par exploitant (ex. 50 km/h) et une liste de tronçons à seuil spécifique. Plus tard : limites OpenStreetMap (`maxspeed`).
- Note CNIL (France) : un dispositif de géolocalisation des véhicules de salariés ne peut pas servir à contrôler le respect des limitations de vitesse. La vitesse moyenne reste possible. D'où `off` par défaut et pas de `nominatif` en France. À valider avec un juriste avant tout pilote.

## 2. Performance (exploitation, et conducteur pour ses propres trajets)

| Indicateur | Définition |
|---|---|
| Ponctualité | écart à l'horaire GTFS (stop_times) à chaque arrêt desservi : en avance > 1 min, à l'heure, en retard > 3 min (seuils paramétrables). L'avance est signalée à part. |
| Temps de parcours par inter-arrêt | durée entre deux arrêts consécutifs, comparée à la médiane du même inter-arrêt sur la période |
| Temps de stationnement à l'arrêt | durée v < 3 km/h à ≤ 30 m d'un arrêt |
| Points de ralentissement | zones hors arrêt où v < 10 km/h plus de 20 s, agrégées sur tous les trajets (feux, congestion, aménagements) |
| Kilomètres et trajets mesurés | couverture du dispositif par ligne / conducteur / véhicule |

Rattachement au GTFS : trouver la course (trip_id) dont la suite d'arrêts et l'horaire collent le mieux au trajet. Si aucune course ne colle, le trajet est « hors service » et sort des indicateurs de ponctualité.

## 3. Qualité (confort voyageur)

| Indicateur | Définition |
|---|---|
| Score global et sous-notes | déjà défini (freinages, accélérations, virages) |
| Taux de conduite douce | % du temps en mouvement sans événement ≥ limite |
| Accostage et départ d'arrêt | note des événements dans les 150 m avant/après chaque arrêt : c'est là que les voyageurs sont debout |
| Moments brusques / 10 km | normalisé pour comparer des trajets de longueur différente |
| Ressenti conducteur | note 1-5 saisie en fin de trajet, corrélée au score |
| Qualité de la mesure | trous > 1 s, corrélation des axes avec le GPS ; trajet marqué « mesure douteuse » si corrélation avant < 0,6 ou trous > 5 % du temps |

## 4. Affichage

- Conducteur (fin de trajet) : score + 3 sous-notes, puis une ligne « vitesse commerciale · ponctualité · stationnements ». Pics de vitesse seulement si l'option est `conducteur` ou plus.
- Exploitation : un onglet « Performance » (vitesse commerciale, ponctualité, inter-arrêts, points de ralentissement) à côté de l'onglet « Confort » existant. Mêmes filtres (période, ligne, conducteur).
- Toujours afficher la qualité de mesure à côté d'un score.

## 5. Ordre de réalisation conseillé

1. Vitesse commerciale, vitesse de roulage, temps à l'arrêt (simple, sans GTFS horaire).
2. Paramètre `options.vitesse_pics` avec `off` par défaut et vitesse max côté conducteur.
3. Accostage / départ d'arrêt et qualité de mesure.
4. Rattachement à la course GTFS, puis ponctualité et inter-arrêts.
5. Points de ralentissement agrégés.
