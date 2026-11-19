"""Découpe le trajet en freinages, accélérations et virages, puis note chacun.

Chaque événement reçoit un niveau (doux, limite, brusque, très brusque) selon son pic
d'accélération et son à-coup, avec les seuils du profil. Les notes par critère et le
score global sont la moyenne des notes des événements : 100 doux, 70 limite, 30 brusque,
0 très brusque.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(sys.argv[1])
GTFS_STOPS = Path(sys.argv[2])
FS = 5
NOTE = [100, 70, 30, 0]
NIVEAU = ["douce", "limite", "brusque", "tres"]

tr = pd.read_csv(OUT / "trace.csv")
stops = pd.read_csv(GTFS_STOPS, encoding="utf-8-sig", dtype=str)
stops = stops[stops.location_type.fillna("0") == "0"].copy()
stops["lat"] = stops.stop_lat.astype(float)
stops["lon"] = stops.stop_lon.astype(float)


def dist(lat1, lon1, lat2, lon2):
    x = np.radians(lon2 - lon1) * np.cos(np.radians((lat1 + lat2) / 2))
    y = np.radians(lat2 - lat1)
    return 6371000 * np.hypot(x, y)


def pos(t):
    return np.interp(t, tr.seconds_elapsed, tr.latitude), np.interp(t, tr.seconds_elapsed, tr.longitude)


def episodes(x, seuil=0.6, duree_min=1.0, trou=1.0):
    """Épisodes où |x| dépasse le seuil de détection (un événement, même doux)."""
    on = np.abs(x) >= seuil
    g = int(trou * FS)
    ev, i, n = [], 0, len(x)
    while i < n:
        if on[i]:
            j = i
            while j < n and (on[j] or on[j:j + g].any()):
                j += 1
            if (j - i) / FS >= duree_min:
                ev.append((i, j))
            i = j
        else:
            i += 1
    return ev


def niveau(val, seuils):
    a = abs(val)
    return 0 if a < seuils[0] else 1 if a < seuils[1] else 2 if a < seuils[2] else 3


for pr in ["bus", "car", "voiture"]:
    d = OUT / pr
    s = pd.read_csv(d / "series_5hz.csv")
    s = s[s.valide].reset_index(drop=True)
    res = json.load(open(d / "resume.json"))
    th, tj = res["seuils"]["long"], res["seuils"]["jerk"]
    t0_epoch = pd.Timestamp(f"2026-11-19 {res['heure_debut']}", tz="Europe/Paris")
    t_first = s.t.iloc[0]
    lon, lat, jerk = s["long"].to_numpy(), s["lat"].to_numpy(), s.jerk.abs().to_numpy()

    evts = []
    for nom, serie in [("freinage", np.minimum(lon, 0)), ("accélération", np.maximum(lon, 0)), ("virage", lat)]:
        for i, j in episodes(serie):
            k = i + int(np.argmax(np.abs(serie[i:j])))
            pic = float(serie[k])
            jm = float(jerk[max(0, i - FS):j + FS].max()) if nom != "virage" else 0.0
            nv = max(niveau(pic, th), niveau(jm, tj))
            t = float(s.t[k])
            libelle = nom if nom != "virage" else ("virage à droite" if pic > 0 else "virage à gauche")
            la, lo = pos(t)
            dd = dist(stops.lat.to_numpy(), stops.lon.to_numpy(), la, lo)
            q = int(dd.argmin())
            st = stops.iloc[q]
            a_, b_ = dist(*pos(t - 3), st.lat, st.lon), dist(*pos(t + 3), st.lat, st.lon)
            evts.append({
                "critere": nom, "libelle": libelle, "t": t, "niveau": NIVEAU[nv], "note": NOTE[nv],
                "pic_ms2": round(pic, 2), "jerk_max": round(jm, 2), "vitesse_kmh": round(float(s.vitesse_kmh[k])),
                "heure": (t0_epoch + pd.Timedelta(seconds=t - t_first)).strftime("%H:%M:%S"),
                "lat_gps": round(float(la), 6), "lon_gps": round(float(lo), 6),
                "arret": st.stop_name.title() if st.stop_name.isupper() else st.stop_name,
                "d_arret": int(round(float(dd[q]))),
                "rel": "au niveau de" if dd[q] < 15 else ("à l’approche de" if b_ < a_ else "au départ de"),
            })
    evts.sort(key=lambda e: e["t"])

    sous = {}
    for nom in ["freinage", "accélération", "virage"]:
        e = [x for x in evts if x["critere"] == nom]
        sous[nom] = {
            "nombre": len(e),
            "brusques": sum(1 for x in e if x["niveau"] in ("brusque", "tres")),
            "note": int(round(np.mean([x["note"] for x in e]))) if e else 100,
        }
    res["sous_notes"] = sous
    res["score"] = int(round(np.mean([x["note"] for x in evts]))) if evts else 100
    res["nb_evenements"] = len(evts)
    res["nb_moments"] = {
        "limite": sum(1 for x in evts if x["niveau"] == "limite"),
        "brusque": sum(1 for x in evts if x["niveau"] in ("brusque", "tres")),
        "tres": sum(1 for x in evts if x["niveau"] == "tres"),
    }
    res["brusques_10km"] = round(res["nb_moments"]["brusque"] / res["distance_km"] * 10, 1)
    json.dump(res, open(d / "resume.json", "w"), ensure_ascii=False, indent=2)
    json.dump(evts, open(d / "evenements_notes.json", "w"), ensure_ascii=False, indent=1)
    print(pr, "score", res["score"], sous, res["nb_moments"])
