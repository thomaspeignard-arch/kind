"""Analyse de douceur de conduite à partir d'un enregistrement Sensor Logger."""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt

RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

FS = 50.0  # fréquence de travail (Hz)


def load(name):
    df = pd.read_csv(RAW / name)
    df = df.drop_duplicates("seconds_elapsed").sort_values("seconds_elapsed")
    return df


tot = load("TotalAcceleration.csv")  # accélération brute, gravité comprise, repère téléphone
loc = load("Location.csv")

# --- Couverture temporelle : l'accéléromètre peut s'interrompre (mise en veille Android)
t_acc = tot["seconds_elapsed"].to_numpy()
gaps = np.diff(t_acc)
cover = {
    "acc_debut": float(t_acc[0]), "acc_fin": float(t_acc[-1]),
    "gps_debut": float(loc["seconds_elapsed"].iloc[0]), "gps_fin": float(loc["seconds_elapsed"].iloc[-1]),
    "plus_grand_trou_s": float(gaps.max()), "debut_trou_s": float(t_acc[gaps.argmax()]),
    "nb_trous_sup_0_5s": int((gaps > 0.5).sum()),
}

# On analyse jusqu'au premier gros trou de l'accéléromètre
t0 = max(t_acc[0], 1.0)
t1 = t_acc[gaps.argmax()] if gaps.max() > 2 else t_acc[-1]
t = np.arange(t0, t1, 1 / FS)
A = np.column_stack([np.interp(t, tot["seconds_elapsed"], tot[c]) for c in ["x", "y", "z"]])
valid = np.ones_like(t, dtype=bool)
for i in np.where(gaps > 0.5)[0]:
    valid &= ~((t > t_acc[i]) & (t < t_acc[i + 1]))

# --- Vitesse, accélération et virage mesurés par le GPS (références indépendantes)
tl = loc["seconds_elapsed"].to_numpy()
v_gps = loc["speed"].clip(lower=0).to_numpy()
bv, av = butter(2, 0.15 / (FS / 2))
v_s = filtfilt(bv, av, np.interp(t, tl, v_gps))
a_gps = np.gradient(v_s, 1 / FS)
bearing = np.unwrap(np.radians(loc["bearing"].to_numpy()))
cent_gps = np.interp(t, tl, v_gps * np.gradient(bearing, tl))

# --- Repère véhicule : vertical = gravité mesurée à l'arrêt (téléphone fixé sur son support)
still = v_s < 0.3
up = A[still].mean(axis=0)
up /= np.linalg.norm(up)
e1 = np.cross(up, [1.0, 0, 0]); e1 /= np.linalg.norm(e1)
e2 = np.cross(up, e1)
b, a = butter(2, 1.5 / (FS / 2))  # ne garder que ce que ressent un passager
h1, h2 = filtfilt(b, a, A @ e1), filtfilt(b, a, A @ e2)

# --- Axe avant : l'angle qui colle le mieux à l'accélération GPS
moving = (v_s > 2) & valid
corr = []
for deg in range(360):
    th = np.radians(deg)
    corr.append(np.corrcoef(filtfilt(bv, av, np.cos(th) * h1 + np.sin(th) * h2)[moving], a_gps[moving])[0, 1])
best = np.radians(int(np.nanargmax(corr)))
lon = np.cos(best) * h1 + np.sin(best) * h2
lat = -np.sin(best) * h1 + np.cos(best) * h2
bs, as_ = butter(2, 0.3 / (FS / 2))
if np.corrcoef(filtfilt(bs, as_, lat)[moving], cent_gps[moving])[0, 1] < 0:
    lat = -lat  # positif = virage à droite (le cap GPS tourne dans le sens horaire)

# --- Correction des biais lents (pente de la route, dévers, léger défaut d'inclinaison)
bb, ab = butter(1, 0.05 / (FS / 2))
lon = lon - filtfilt(bb, ab, lon - a_gps)
lat = lat - filtfilt(bb, ab, lat - cent_gps)
c_long = float(np.corrcoef(filtfilt(bv, av, lon)[moving], a_gps[moving])[0, 1])
c_lat = float(np.corrcoef(filtfilt(bs, as_, lat)[moving], cent_gps[moving])[0, 1])
b2, a2 = butter(2, 1.0 / (FS / 2))

# --- Jerk longitudinal (à-coups)
jerk = np.gradient(filtfilt(b2, a2, lon), 1 / FS)

# --- Seuils de confort pour un passager debout (m/s² et m/s³)
# Seuils (limite, brusque, très brusque) selon le profil de véhicule
PROFILS = {
    # passagers debout : Krašna et al. 2021 recommandent de rester sous 1,5 m/s² en pointe
    "bus": {"nom": "Bus urbain, passagers debout", "acc": (1.0, 1.5, 2.5), "jerk": (1.5, 3.0, 5.0)},
    # passagers assis et attachés
    "car": {"nom": "Autocar, passagers assis et attachés", "acc": (1.5, 2.5, 3.5), "jerk": (2.5, 5.0, 8.0)},
    "voiture": {"nom": "Voiture", "acc": (2.0, 3.0, 4.0), "jerk": (3.0, 6.0, 10.0)},
}
PROFIL = sys.argv[3] if len(sys.argv) > 3 else "bus"
P = PROFILS[PROFIL]
SEUILS = {"long": P["acc"], "lat": P["acc"], "jerk": P["jerk"]}


def niveau(x, s):
    ax = np.abs(x)
    return np.where(ax >= s[2], 3, np.where(ax >= s[1], 2, np.where(ax >= s[0], 1, 0)))


n_long, n_lat, n_jerk = niveau(lon, SEUILS["long"]), niveau(lat, SEUILS["lat"]), niveau(jerk, SEUILS["jerk"])
etat = np.maximum.reduce([n_long, n_lat, n_jerk])
etat[~valid] = 0
roulant = (v_s > 1) & valid

# --- Événements : épisodes continus au-dessus du seuil « limite »
def episodes(signal, s, kind, sign_names):
    lvl = niveau(signal, s)
    lvl[~valid] = 0
    ev = []
    i = 0
    n = len(t)
    while i < n:
        if lvl[i] >= 1:
            j = i
            while j < n and lvl[j] >= 1:
                j += 1
            if (j - i) / FS >= 0.4:  # au moins 0,4 s
                seg = signal[i:j]
                k = i + int(np.argmax(np.abs(seg)))
                ev.append({
                    "type": kind,
                    "sens": sign_names[0] if signal[k] < 0 else sign_names[1],
                    "t": float(t[k]), "pic": float(signal[k]),
                    "duree_s": round((j - i) / FS, 1),
                    "niveau": {1: "limite", 2: "brusque", 3: "tres"}[int(lvl[i:j].max())],
                    "vitesse_kmh": round(float(v_s[k] * 3.6), 0),
                })
            i = j
        else:
            i += 1
    return ev


events = (
    episodes(lon, SEUILS["long"], "longitudinal", ("freinage", "accélération"))
    + episodes(lat, SEUILS["lat"], "latéral", ("virage à gauche", "virage à droite"))
    + episodes(jerk, SEUILS["jerk"], "à-coup", ("à-coup", "à-coup"))
)
events.sort(key=lambda e: e["t"])

# position et heure de chaque événement
start_epoch = int(pd.read_csv(RAW / "Metadata.csv")["recording epoch time"].iloc[0]) / 1000
for e in events:
    e["lat_gps"] = float(np.interp(e["t"], tl, loc["latitude"]))
    e["lon_gps"] = float(np.interp(e["t"], tl, loc["longitude"]))
    e["heure"] = pd.Timestamp(start_epoch + e["t"], unit="s", tz="UTC").tz_convert("Europe/Paris").strftime("%H:%M:%S")

# --- Score de douceur : part du temps de roulage en état « doux », pénalités pour les brusques
dt = 1 / FS
temps_roulage = roulant.sum() * dt
part_douce = float((etat[roulant] == 0).mean())
part_limite = float((etat[roulant] == 1).mean())
part_brusque = float((etat[roulant] >= 2).mean())
nb_brusques = sum(1 for e in events if e["niveau"] == "brusque")
# chaque point de temps « limite » coûte 0,5 point, chaque point « brusque » en coûte 2
score_temps = 100 - 100 * (0.5 * part_limite + 2 * part_brusque)

# regrouper les événements simultanés (à moins de 2 s) en « moments »
moments = []
for e in events:
    if moments and e["t"] - moments[-1]["t_fin"] <= 2:
        m = moments[-1]
        m["t_fin"] = e["t"]
        m["composantes"].append(e)
        rang = {"limite": 1, "brusque": 2, "tres": 3}
        if rang[e["niveau"]] > rang[m["niveau"]]:
            m["niveau"] = e["niveau"]
    else:
        moments.append({"t": e["t"], "t_fin": e["t"], "niveau": e["niveau"], "composantes": [e]})
for m in moments:
    c = m["composantes"]
    principal = max([x for x in c if x["type"] != "à-coup"] or c, key=lambda x: abs(x["pic"]))
    m["libelle"] = principal["sens"]
    m["heure"] = c[0]["heure"]
    m["vitesse_kmh"] = principal["vitesse_kmh"]
    m["pic_ms2"] = round(principal["pic"], 2)
    m["jerk_max"] = round(max([abs(x["pic"]) for x in c if x["type"] == "à-coup"] or [0]), 2)
    m["lat_gps"], m["lon_gps"] = principal["lat_gps"], principal["lon_gps"]
dist_km = float(np.trapezoid(v_s[valid], dx=dt) / 1000)
brusques_10km = sum(1 for m in moments if m["niveau"] in ("brusque", "tres")) / max(dist_km, 0.1) * 10
# score = temps passé en conduite douce, moins 1 point par moment brusque pour 10 km
score = float(np.clip(score_temps - brusques_10km, 0, 100))
(OUT / "moments.json").write_text(json.dumps([{k: v for k, v in m.items() if k != "composantes"} for m in moments], ensure_ascii=False, indent=2))

# sous-scores par critère (même logique)
def sous_score(n):
    return float(np.clip(100 * (n[roulant] == 0).mean(), 0, 100))

resume = {
    "couverture": cover,
    "qualite_recalage": {"corr_longitudinale_gps": round(c_long, 2), "corr_laterale_gps": round(c_lat, 2)},
    "duree_roulage_s": round(float(temps_roulage), 0),
    "distance_km": round(float(np.trapezoid(v_s[valid], dx=dt) / 1000), 2),
    "vitesse_max_kmh": round(float(v_s.max() * 3.6), 0),
    "score": round(score),
    "sous_scores": {
        "freinages_demarrages": round(sous_score(n_long)),
        "virages": round(sous_score(n_lat)),
        "a_coups": round(sous_score(n_jerk)),
    },
    "parts_temps": {"douce": round(part_douce, 3), "limite": round(part_limite, 3), "brusque": round(part_brusque, 3)},
    "max": {
        "freinage": round(float(lon[valid].min()), 2), "acceleration": round(float(lon[valid].max()), 2),
        "lateral": round(float(np.abs(lat[valid]).max()), 2), "jerk": round(float(np.abs(jerk[valid]).max()), 2),
    },
    "nb_moments": {"limite": sum(1 for m in moments if m["niveau"] == "limite"), "brusque": sum(1 for m in moments if m["niveau"] in ("brusque", "tres")), "tres": sum(1 for m in moments if m["niveau"] == "tres")},
    "profil": PROFIL, "profil_nom": P["nom"], "score_temps": round(float(score_temps)), "brusques_10km": round(brusques_10km, 1),
    "seuils": SEUILS,
    "heure_debut": pd.Timestamp(start_epoch + t[0], unit="s", tz="UTC").tz_convert("Europe/Paris").strftime("%H:%M:%S"),
}
(OUT / "resume.json").write_text(json.dumps(resume, ensure_ascii=False, indent=2))
(OUT / "evenements.json").write_text(json.dumps(events, ensure_ascii=False, indent=2))

# séries à 5 Hz pour les graphiques
step = int(FS / 5)
series = pd.DataFrame({
    "t": t[::step], "vitesse_kmh": v_s[::step] * 3.6, "long": lon[::step], "lat": lat[::step],
    "jerk": jerk[::step], "etat": etat[::step], "valide": valid[::step],
})
series.to_csv(OUT / "series_5hz.csv", index=False)
loc[["seconds_elapsed", "latitude", "longitude", "speed"]].to_csv(OUT / "trace.csv", index=False)
print(json.dumps(resume, ensure_ascii=False, indent=2))
print(len(events), "événements")
for m in moments:
    print(m["heure"], m["niveau"], m["libelle"], m["pic_ms2"], "jerk", m["jerk_max"], m["vitesse_kmh"], "km/h")
