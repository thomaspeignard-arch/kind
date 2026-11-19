"""Analyse d'un export CSV de la page Kind (5 Hz) : axes recalés sur le GPS, événements, notes par profil."""
import json
import sys

import numpy as np
import pandas as pd
from scipy.signal import butter, filtfilt

FS = 5
PROF = {"bus": ((1.0, 1.5, 2.5), (1.5, 3, 5)), "car": ((1.5, 2.5, 3.5), (2.5, 5, 8)), "voiture": ((2.0, 3.0, 4.0), (3, 6, 10))}
NOTE = [100, 70, 30, 0]
NIV = ["doux", "limite", "brusque", "très brusque"]


def lp(x, f):
    b, a = butter(2, f / (FS / 2))
    return filtfilt(b, a, x)


def analyse(path):
    d = pd.read_csv(path)
    d = d[d.t_s >= 5].reset_index(drop=True)
    v = d.vitesse_kmh.interpolate().bfill().ffill().to_numpy() / 3.6
    vs = lp(v, 0.15)
    agps = np.gradient(vs, 1 / FS)
    mv = vs > 2
    h1, h2 = d.h1.to_numpy(), d.h2.to_numpy()
    corr, ang = max((np.corrcoef(lp(np.cos(np.radians(a)) * h1 + np.sin(np.radians(a)) * h2, 0.15)[mv], agps[mv])[0, 1], a) for a in range(360))
    th = np.radians(ang)
    L = np.cos(th) * h1 + np.sin(th) * h2
    Lt = -np.sin(th) * h1 + np.cos(th) * h2
    lat = d.latitude.interpolate().bfill().ffill().to_numpy()
    lon = d.longitude.interpolate().bfill().ffill().to_numpy()
    x = lp(np.radians(lon) * np.cos(np.radians(lat.mean())) * 6371000, 0.2)
    y = lp(np.radians(lat) * 6371000, 0.2)
    head = np.unwrap(np.arctan2(np.gradient(x), np.gradient(y)))
    cent = vs * np.gradient(head, 1 / FS)
    m3 = vs > 3
    rl = np.corrcoef(lp(Lt, 0.3)[m3], cent[m3])[0, 1]
    if rl < 0:
        Lt = -Lt  # positif = virage à droite
    # Biais lents (pente, dévers, inclinaison résiduelle du support) : ce que le GPS ne voit pas
    L = L - lp(L - agps, 0.05)
    Lt = Lt - lp(Lt - cent, 0.05)
    J = np.abs(np.gradient(lp(L, 1.0), 1 / FS))

    def episodes(s, seuil=0.6, mind=1.0, gap=1.0):
        on = np.abs(s) >= seuil
        g = int(gap * FS)
        ev, i, n = [], 0, len(s)
        while i < n:
            if on[i]:
                j = i
                while j < n and (on[j] or on[j:j + g].any()):
                    j += 1
                if (j - i) / FS >= mind and vs[i:j].max() * 3.6 >= 3:  # pas d'événement à l'arrêt
                    ev.append((i, j))
                i = j
            else:
                i += 1
        return ev

    def niv(a, s):
        a = abs(a)
        return 0 if a < s[0] else 1 if a < s[1] else 2 if a < s[2] else 3

    res = {"duree_min": round((d.t_s.iloc[-1] - d.t_s.iloc[0]) / 60, 1), "km": round(float(np.trapezoid(vs, dx=1 / FS) / 1000), 2),
           "vmax": round(float(vs.max() * 3.6)), "corr_avant": round(float(corr), 2), "corr_lateral": round(float(abs(rl)), 2),
           "trous": int((np.diff(d.t_s) > 1).sum()), "jerk_direct": round(float(d.jerk.mean()), 2), "jerk_recalcule": round(float(J.mean()), 2),
           "brusque_affiche": round(float((d.niveau >= 2).mean() * 100)), "profils": {}}
    for pr, (ta, tj) in PROF.items():
        ev = []
        for nom, serie in [("freinage", np.minimum(L, 0)), ("accélération", np.maximum(L, 0)), ("virage", Lt)]:
            for i, j in episodes(serie):
                k = i + int(np.argmax(np.abs(serie[i:j])))
                jm = J[max(0, i - FS):j + FS].max() if nom != "virage" else 0
                lv = max(niv(serie[k], ta), niv(jm, tj))
                ev.append({"type": nom if nom != "virage" else ("virage à droite" if serie[k] > 0 else "virage à gauche"), "crit": nom, "niveau": lv,
                           "t": float(d.t_s[k]), "pic": round(float(serie[k]), 2), "kmh": round(float(vs[k] * 3.6)),
                           "lat": float(lat[k]), "lon": float(lon[k])})
        sous = {}
        for n in ["freinage", "accélération", "virage"]:
            e = [x for x in ev if x["crit"] == n]
            sous[n] = {"nb": len(e), "brusques": sum(1 for x in e if x["niveau"] >= 2), "note": round(np.mean([NOTE[x["niveau"]] for x in e])) if e else None}
        res["profils"][pr] = {"score": round(np.mean([NOTE[x["niveau"]] for x in ev])), "sous": sous, "evenements": ev}
    return res


if __name__ == "__main__":
    r = analyse(sys.argv[1])
    out = {k: v for k, v in r.items() if k != "profils"}
    print(json.dumps(out, ensure_ascii=False))
    for pr, p in r["profils"].items():
        print(pr, p["score"], {k: (v["nb"], v["brusques"], v["note"]) for k, v in p["sous"].items()})
    for e in sorted(r["profils"]["bus"]["evenements"], key=lambda e: -abs(e["pic"]))[:6]:
        print("  ", e["type"], NIV[e["niveau"]], f"t={e['t']:.0f}s", e["pic"], f"{e['kmh']} km/h")
    json.dump(r, open(sys.argv[2], "w"), ensure_ascii=False)
