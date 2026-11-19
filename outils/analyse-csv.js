// Analyse d'un export CSV de kind-live (colonnes t_s, latitude, longitude, vitesse_kmh, h1, h2, …)
// avec la méthode de la référence Python (reference/analyse/analyse.py + evenements.py) :
// axe avant appris par le GPS, signe du latéral par le cap calculé depuis les positions,
// à-coup = dérivée de l'accélération longitudinale filtrée à 1 Hz sur une grille fixe à 5 Hz,
// événements ignorés sous 3 km/h, note par événement puis moyenne.
// Usage (navigateur) : const { analyseCsv } = await import('./outils/analyse-csv.js');
//                      analyseCsv(texteCsv, 'bus')

export const FS = 5;
export const VMIN_KMH = 3;
export const PROFILS = {
  bus: { nom: 'Bus urbain, passagers debout', acc: [1.0, 1.5, 2.5], jerk: [1.5, 3.0, 5.0] },
  car: { nom: 'Autocar, passagers assis et attachés', acc: [1.5, 2.5, 3.5], jerk: [2.5, 5.0, 8.0] },
  voiture: { nom: 'Voiture', acc: [2.0, 3.0, 4.0], jerk: [3.0, 6.0, 10.0] },
};
const NOTE = [100, 70, 30, 0];
const NIVEAU = ['douce', 'limite', 'brusque', 'tres'];

// ---------- filtres de Butterworth appliqués aller-retour (comme scipy filtfilt) ----------
function butter(order, fc, fs) {
  const K = Math.tan(Math.PI * fc / fs);
  if (order === 1) { const n = 1 / (1 + K); return { b: [K * n, K * n, 0], a: [1, (K - 1) * n, 0] }; }
  const n = 1 / (1 + Math.SQRT2 * K + K * K), b0 = K * K * n;
  return { b: [b0, 2 * b0, b0], a: [1, 2 * (K * K - 1) * n, (1 - Math.SQRT2 * K + K * K) * n] };
}
function lfilter({ b, a }, x) {
  // état initial en régime permanent sur la première valeur (équivalent de lfilter_zi)
  const y = new Array(x.length); let x1 = x[0], x2 = x[0];
  const g = (b[0] + b[1] + b[2]) / (1 + a[1] + a[2]); let y1 = g * x[0], y2 = g * x[0];
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
export function filtfilt(f, x) {
  const pad = Math.min(x.length - 1, 9);   // extension impaire aux deux bouts, comme scipy
  const ext = [];
  for (let i = pad; i > 0; i--) ext.push(2 * x[0] - x[i]);
  ext.push(...x);
  for (let i = 1; i <= pad; i++) ext.push(2 * x[x.length - 1] - x[x.length - 1 - i]);
  const y = lfilter(f, lfilter(f, ext).reverse()).reverse();
  return y.slice(pad, pad + x.length);
}
const gradient = (x, dt) => x.map((_, i) => i === 0 ? (x[1] - x[0]) / dt : i === x.length - 1 ? (x[i] - x[i - 1]) / dt : (x[i + 1] - x[i - 1]) / (2 * dt));
function corr(x, y, m) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) if (m[i]) { n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; sxy += x[i] * y[i]; }
  const cx = sxx - sx * sx / n, cy = syy - sy * sy / n;
  return (sxy - sx * sy / n) / Math.sqrt(cx * cy);
}
function interp(t, ts, ys) {   // interpolation linéaire, ts croissant ; NaN hors données
  const out = new Array(t.length); let j = 0;
  for (let i = 0; i < t.length; i++) {
    while (j < ts.length - 2 && ts[j + 1] < t[i]) j++;
    if (t[i] < ts[0] || t[i] > ts[ts.length - 1]) { out[i] = NaN; continue; }
    const f = ts[j + 1] === ts[j] ? 0 : (t[i] - ts[j]) / (ts[j + 1] - ts[j]);
    out[i] = ys[j] + f * (ys[j + 1] - ys[j]);
  }
  return out;
}
const distM = (la1, lo1, la2, lo2) => 6371000 * Math.hypot((lo2 - lo1) * Math.PI / 180 * Math.cos((la1 + la2) / 2 * Math.PI / 180), (la2 - la1) * Math.PI / 180);
const bearing = (la1, lo1, la2, lo2) => Math.atan2((lo2 - lo1) * Math.cos((la1 + la2) / 2 * Math.PI / 180), la2 - la1);

export function lireCsv(texte) {
  const [tete, ...lignes] = texte.trim().split(/\r?\n/);
  const cols = tete.split(',');
  return lignes.map(l => { const v = l.split(','); const o = {}; cols.forEach((c, i) => o[c] = v[i] === '' || v[i] == null ? NaN : +v[i]); return o; });
}

export function analyseCsv(texte, profil = 'bus', opts = {}) {
  const P = PROFILS[profil], rows = lireCsv(texte).sort((a, b) => a.t_s - b.t_s);
  const ts = rows.map(r => r.t_s);
  // grille fixe à 5 Hz ; les trous de plus de 0,5 s dans l'export sont marqués non valides
  const t = []; for (let x = ts[0]; x <= ts[ts.length - 1]; x += 1 / FS) t.push(+x.toFixed(3));
  const valid = t.map(() => true);
  for (let i = 1; i < ts.length; i++) if (ts[i] - ts[i - 1] > 0.5) t.forEach((x, k) => { if (x > ts[i - 1] && x < ts[i]) valid[k] = false; });
  const h1 = interp(t, ts, rows.map(r => r.h1)), h2 = interp(t, ts, rows.map(r => r.h2));
  const g = rows.filter(r => !isNaN(r.latitude) && !isNaN(r.vitesse_kmh));
  const tg = g.map(r => r.t_s);
  let v = interp(t, tg, g.map(r => Math.max(0, r.vitesse_kmh / 3.6)));
  const la = interp(t, tg, g.map(r => r.latitude)), lo = interp(t, tg, g.map(r => r.longitude));
  t.forEach((_, i) => { if (isNaN(v[i])) { v[i] = 0; valid[i] = false; } });

  // références GPS : accélération (vitesse lissée) et virage (cap calculé depuis les positions)
  const fv = butter(2, 0.15, FS), vs = filtfilt(fv, v), aGps = gradient(vs, 1 / FS);
  const cap = new Array(t.length).fill(NaN), W = FS;   // cap entre t-1 s et t+1 s
  for (let i = W; i < t.length - W; i++) {
    const [a1, o1, a2, o2] = [la[i - W], lo[i - W], la[i + W], lo[i + W]];
    if (![a1, o1, a2, o2].some(isNaN) && distM(a1, o1, a2, o2) >= 3) cap[i] = bearing(a1, o1, a2, o2);
  }
  for (let i = 1; i < cap.length; i++) if (isNaN(cap[i])) cap[i] = cap[i - 1];
  for (let i = cap.length - 2; i >= 0; i--) if (isNaN(cap[i])) cap[i] = cap[i + 1];
  for (let i = 1; i < cap.length; i++) { let d = cap[i] - cap[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; cap[i] = cap[i - 1] + d; }
  const cent = gradient(cap.map(c => isNaN(c) ? 0 : c), 1 / FS).map((w, i) => v[i] * w);

  // axe avant : l'angle qui colle le mieux à l'accélération GPS
  const moving = vs.map((x, i) => x > 2 && valid[i]);
  let best = 0, bestC = -Infinity;
  for (let deg = 0; deg < 360; deg++) {
    const th = deg * Math.PI / 180, c = corr(filtfilt(fv, h1.map((x, i) => Math.cos(th) * x + Math.sin(th) * h2[i])), aGps, moving);
    if (c > bestC) { bestC = c; best = th; }
  }
  let lon = h1.map((x, i) => Math.cos(best) * x + Math.sin(best) * h2[i]);
  let lat = h1.map((x, i) => -Math.sin(best) * x + Math.cos(best) * h2[i]);
  const fs3 = butter(2, 0.3, FS);
  const cLat0 = corr(filtfilt(fs3, lat), cent, moving);
  if (cLat0 < 0) lat = lat.map(x => -x);   // positif = virage à droite
  // biais lents (pente, dévers) retirés par comparaison au GPS
  const fb = butter(1, 0.05, FS);
  const bl = filtfilt(fb, lon.map((x, i) => x - aGps[i])), bt = filtfilt(fb, lat.map((x, i) => x - cent[i]));
  lon = lon.map((x, i) => x - bl[i]); lat = lat.map((x, i) => x - bt[i]);
  // à-coup : dérivée de l'accélération filtrée à 1 Hz, sur la grille fixe à 5 Hz.
  // 'combine' (comme la page en direct) : norme des deux axes ; 'longitudinal' : comme la référence Python.
  const f1 = butter(2, 1.0, FS), jl = gradient(filtfilt(f1, lon), 1 / FS);
  const jt = gradient(filtfilt(f1, lat), 1 / FS);
  const jerk = opts.jerk === 'longitudinal' ? jl.map(Math.abs) : jl.map((x, i) => Math.hypot(x, jt[i]));

  // série « valide » ; sous 3 km/h on ignore tout (manipulation du téléphone à l'arrêt)
  const keep = t.map((_, i) => valid[i]);
  const S = { t: [], lon: [], lat: [], jerk: [], v: [] };
  keep.forEach((k, i) => { if (!k) return; const arret = vs[i] * 3.6 < VMIN_KMH;
    S.t.push(t[i]); S.v.push(vs[i] * 3.6); S.lon.push(arret ? 0 : lon[i]); S.lat.push(arret ? 0 : lat[i]); S.jerk.push(arret ? 0 : jerk[i]); });

  const niveau = (x, s) => { const a = Math.abs(x); return a < s[0] ? 0 : a < s[1] ? 1 : a < s[2] ? 2 : 3; };
  const evts = [];
  for (const [nom, serie] of [['freinage', S.lon.map(x => Math.min(x, 0))], ['accélération', S.lon.map(x => Math.max(x, 0))], ['virage', S.lat]]) {
    for (const [i, j] of episodes(serie)) {
      let k = i; for (let q = i; q < j; q++) if (Math.abs(serie[q]) > Math.abs(serie[k])) k = q;
      const pic = serie[k];
      const jm = nom === 'virage' ? 0 : Math.max(...S.jerk.slice(Math.max(0, i - FS), j + FS));
      const nv = Math.max(niveau(pic, P.acc), niveau(jm, P.jerk));
      evts.push({ critere: nom, t: S.t[k], niveau: NIVEAU[nv], note: NOTE[nv], pic: +pic.toFixed(2), jerk_max: +jm.toFixed(2), vitesse_kmh: Math.round(S.v[k]) });
    }
  }
  evts.sort((a, b) => a.t - b.t);
  const moy = e => e.length ? Math.round(e.reduce((s, x) => s + x.note, 0) / e.length) : 100;
  const sous = {};
  for (const nom of ['freinage', 'accélération', 'virage']) { const e = evts.filter(x => x.critere === nom); sous[nom] = { nombre: e.length, brusques: e.filter(x => x.niveau === 'brusque' || x.niveau === 'tres').length, note: moy(e) }; }
  const roule = jerk.filter((_, i) => valid[i] && vs[i] * 3.6 >= VMIN_KMH);
  return {
    profil, score: moy(evts), sous_notes: sous, nb_evenements: evts.length,
    jerk_moyen: +(roule.reduce((s, x) => s + x, 0) / roule.length).toFixed(2),
    recalage: { axe_avant_deg: Math.round(best * 180 / Math.PI), corr_longitudinale_gps: +bestC.toFixed(2), corr_laterale_gps: +Math.abs(cLat0).toFixed(2) },
    evenements: evts,
  };
}

// épisodes où |x| ≥ 0,6 m/s² pendant au moins 1 s (trous de moins de 1 s tolérés)
function episodes(x, seuil = 0.6, dureeMin = 1.0, trou = 1.0) {
  const on = x.map(v => Math.abs(v) >= seuil), g = Math.round(trou * FS), ev = [], n = x.length;
  let i = 0;
  while (i < n) {
    if (on[i]) { let j = i; while (j < n && (on[j] || on.slice(j, j + g).some(Boolean))) j++; if ((j - i) / FS >= dureeMin) ev.push([i, j]); i = j; }
    else i++;
  }
  return ev;
}
