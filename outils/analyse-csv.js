// Analyse d'un export CSV de la page Kind (5 Hz) : axes recalés sur le GPS, événements, notes par profil.
// Portage fidèle en JavaScript du script de référence outils/analyse_kind.py
// (mêmes filtres, mêmes seuils, mêmes arrondis), pour l'utiliser dans le navigateur sans Python.
// Usage : const { analyseCsv } = await import('./outils/analyse-csv.js');
//         const r = analyseCsv(texteCsv);   // r.profils.bus.score, r.profils.voiture.sous, …

export const FS = 5;
export const PROF = {
  bus: [[1.0, 1.5, 2.5], [1.5, 3, 5]],
  car: [[1.5, 2.5, 3.5], [2.5, 5, 8]],
  voiture: [[2.0, 3.0, 4.0], [3, 6, 10]],
};
const NOTE = [100, 70, 30, 0];
export const NIV = ['doux', 'limite', 'brusque', 'très brusque'];

// ---------- outils numériques équivalents à numpy / scipy ----------
// Butterworth d'ordre 2 (comme scipy.signal.butter(2, f / (FS / 2)))
function butter2(f) {
  const K = Math.tan(Math.PI * f / FS), n = 1 / (1 + Math.SQRT2 * K + K * K), b0 = K * K * n;
  return { b: [b0, 2 * b0, b0], a: [1, 2 * (K * K - 1) * n, (1 - Math.SQRT2 * K + K * K) * n] };
}
// filtre avec état initial en régime permanent sur la première valeur (lfilter_zi × x[0])
function lfilter({ b, a }, x) {
  // état de la forme directe transposée II, en régime permanent pour une entrée constante
  const g = (b[0] + b[1] + b[2]) / (1 + a[1] + a[2]);
  let z1 = (g - b[0]) * x[0], z2 = (b[2] - a[2] * g) * x[0];
  const y = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const yi = b[0] * x[i] + z1;
    z1 = b[1] * x[i] - a[1] * yi + z2;
    z2 = b[2] * x[i] - a[2] * yi;
    y[i] = yi;
  }
  return y;
}
// scipy.signal.filtfilt : extension impaire de 9 points aux deux bouts, filtre aller puis retour
function filtfilt(f, x) {
  const n = x.length, pad = 9, ext = [];
  for (let i = pad; i > 0; i--) ext.push(2 * x[0] - x[i]);
  ext.push(...x);
  for (let i = 1; i <= pad; i++) ext.push(2 * x[n - 1] - x[n - 1 - i]);
  const y = lfilter(f, lfilter(f, ext).reverse()).reverse();
  return y.slice(pad, pad + n);
}
const lp = (x, f) => filtfilt(butter2(f), x);
const gradient = (x, dt = 1) => x.map((_, i) => i === 0 ? (x[1] - x[0]) / dt : i === x.length - 1 ? (x[i] - x[i - 1]) / dt : (x[i + 1] - x[i - 1]) / (2 * dt));
function unwrap(p) {
  const out = [p[0]];
  for (let i = 1; i < p.length; i++) { let d = p[i] - p[i - 1]; d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; if (d === -Math.PI && p[i] - p[i - 1] > 0) d = Math.PI; out.push(out[i - 1] + d); }
  return out;
}
function corrcoef(x, y, m) {
  let n = 0, sx = 0, sy = 0;
  for (let i = 0; i < x.length; i++) if (m[i]) { n++; sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n; let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < x.length; i++) if (m[i]) { const dx = x[i] - mx, dy = y[i] - my; cxy += dx * dy; cxx += dx * dx; cyy += dy * dy; }
  return cxy / Math.sqrt(cxx * cyy);
}
// pandas : interpolate() linéaire par position, puis bfill() et ffill()
function remplir(col) {
  const x = col.slice(), idx = x.map((v, i) => isNaN(v) ? -1 : i).filter(i => i >= 0);
  if (!idx.length) return x.map(() => 0);
  for (let k = 0; k + 1 < idx.length; k++) for (let i = idx[k] + 1; i < idx[k + 1]; i++) x[i] = x[idx[k]] + (x[idx[k + 1]] - x[idx[k]]) * (i - idx[k]) / (idx[k + 1] - idx[k]);
  for (let i = 0; i < idx[0]; i++) x[i] = x[idx[0]];
  for (let i = idx[idx.length - 1] + 1; i < x.length; i++) x[i] = x[idx[idx.length - 1]];
  return x;
}
// round() de Python : arrondi au pair le plus proche pour les demis
function pyRound(v, d = 0) {
  const f = 10 ** d, x = v * f, r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r) / f;
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

export function lireCsv(texte) {
  const [tete, ...lignes] = texte.trim().split(/\r?\n/);
  const cols = tete.split(','), d = {};
  cols.forEach(c => d[c] = []);
  for (const l of lignes) { const v = l.split(','); cols.forEach((c, i) => d[c].push(v[i] === '' || v[i] == null ? NaN : +v[i])); }
  return d;
}

export function analyseCsv(texte) {
  const brut = lireCsv(texte);
  // les 5 premières secondes sont ignorées (calibrage)
  const garde = brut.t_s.map(t => t >= 5), d = {};
  for (const c in brut) d[c] = brut[c].filter((_, i) => garde[i]);
  const n = d.t_s.length;

  const v = remplir(d.vitesse_kmh).map(x => x / 3.6);
  const vs = lp(v, 0.15), agps = gradient(vs, 1 / FS), mv = vs.map(x => x > 2);
  const h1 = d.h1, h2 = d.h2;
  // axe avant : l'angle qui colle le mieux à l'accélération GPS
  let corr = -Infinity, ang = 0;
  for (let a = 0; a < 360; a++) {
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
    const r = corrcoef(lp(h1.map((x, i) => c * x + s * h2[i]), 0.15), agps, mv);
    if (r >= corr) { corr = r; ang = a; }
  }
  const th = ang * Math.PI / 180;
  let L = h1.map((x, i) => Math.cos(th) * x + Math.sin(th) * h2[i]);
  let Lt = h1.map((x, i) => -Math.sin(th) * x + Math.cos(th) * h2[i]);
  // cap calculé depuis les positions GPS lissées (pas de coords.heading)
  const lat = remplir(d.latitude), lon = remplir(d.longitude), latMoy = mean(lat);
  const x = lp(lon.map(o => o * Math.PI / 180 * Math.cos(latMoy * Math.PI / 180) * 6371000), 0.2);
  const y = lp(lat.map(a => a * Math.PI / 180 * 6371000), 0.2);
  const gx = gradient(x), gy = gradient(y);
  const head = unwrap(gx.map((_, i) => Math.atan2(gx[i], gy[i])));
  const cent = gradient(head, 1 / FS).map((w, i) => vs[i] * w);
  const m3 = vs.map(s => s > 3);
  const rl = corrcoef(lp(Lt, 0.3), cent, m3);
  if (rl < 0) Lt = Lt.map(z => -z);   // positif = virage à droite
  // biais lents (pente, dévers, inclinaison résiduelle du support) : ce que le GPS ne voit pas
  const bL = lp(L.map((z, i) => z - agps[i]), 0.05), bT = lp(Lt.map((z, i) => z - cent[i]), 0.05);
  L = L.map((z, i) => z - bL[i]); Lt = Lt.map((z, i) => z - bT[i]);
  // à-coup : valeur absolue de la dérivée du signal avant-arrière filtré à 1 Hz
  const J = gradient(lp(L, 1.0), 1 / FS).map(Math.abs);

  function episodes(s, seuil = 0.6, mind = 1.0, gap = 1.0) {
    const on = s.map(z => Math.abs(z) >= seuil), g = Math.trunc(gap * FS), ev = [];
    let i = 0;
    while (i < n) {
      if (on[i]) {
        let j = i;
        while (j < n && (on[j] || on.slice(j, j + g).some(Boolean))) j++;
        if ((j - i) / FS >= mind && Math.max(...vs.slice(i, j)) * 3.6 >= 3) ev.push([i, j]);  // pas d'événement à l'arrêt
        i = j;
      } else i++;
    }
    return ev;
  }
  const niv = (a, s) => { a = Math.abs(a); return a < s[0] ? 0 : a < s[1] ? 1 : a < s[2] ? 2 : 3; };

  const dt = d.t_s.slice(1).map((t, i) => t - d.t_s[i]);
  const res = {
    duree_min: pyRound((d.t_s[n - 1] - d.t_s[0]) / 60, 1),
    km: pyRound(vs.slice(1).reduce((s, z, i) => s + (z + vs[i]) / 2, 0) / FS / 1000, 2),
    vmax: pyRound(Math.max(...vs) * 3.6), corr_avant: pyRound(corr, 2), corr_lateral: pyRound(Math.abs(rl), 2),
    trous: dt.filter(z => z > 1).length, jerk_direct: pyRound(mean(d.jerk), 2), jerk_recalcule: pyRound(mean(J), 2),
    brusque_affiche: pyRound(d.niveau.filter(z => z >= 2).length / n * 100), profils: {},
  };
  for (const [pr, [ta, tj]] of Object.entries(PROF)) {
    const ev = [];
    for (const [nom, serie] of [['freinage', L.map(z => Math.min(z, 0))], ['accélération', L.map(z => Math.max(z, 0))], ['virage', Lt]]) {
      for (const [i, j] of episodes(serie)) {
        let k = i; for (let q = i; q < j; q++) if (Math.abs(serie[q]) > Math.abs(serie[k])) k = q;
        // freinages et accélérations : à-coup maximal sur l'événement élargi d'1 s avant et après
        const jm = nom !== 'virage' ? Math.max(...J.slice(Math.max(0, i - FS), j + FS)) : 0;
        const lv = Math.max(niv(serie[k], ta), niv(jm, tj));
        ev.push({ type: nom !== 'virage' ? nom : (serie[k] > 0 ? 'virage à droite' : 'virage à gauche'), crit: nom, niveau: lv,
          t: d.t_s[k], pic: pyRound(serie[k], 2), kmh: pyRound(vs[k] * 3.6), lat: lat[k], lon: lon[k] });
      }
    }
    const sous = {};
    for (const c of ['freinage', 'accélération', 'virage']) {
      const e = ev.filter(z => z.crit === c);
      sous[c] = { nb: e.length, brusques: e.filter(z => z.niveau >= 2).length, note: e.length ? pyRound(mean(e.map(z => NOTE[z.niveau]))) : null };
    }
    res.profils[pr] = { score: pyRound(mean(ev.map(z => NOTE[z.niveau]))), sous, evenements: ev };
  }
  return res;
}

// ---------- indicateurs de vitesse (docs/INDICATEURS.md, point 1) ----------
// Vitesse commerciale = distance / durée totale (arrêts compris) ;
// vitesse de roulage = distance / temps où la vitesse lissée dépasse 3 km/h ;
// temps à l'arrêt, séparé entre les points d'arrêt GTFS (≤ 30 m) et ailleurs (feux, congestion).
// Mêmes bases que analyseCsv : 5 premières secondes ignorées, vitesse GPS lissée à 0,15 Hz,
// distance = intégrale de cette vitesse, une ligne du CSV = 1/5 s.
// arrets : [{lat, lon, nom}] ; intervalles : [[t_debut, t_fin], …] en secondes du CSV
// (par exemple les courses notées), ou null pour tout le trajet.
// options.vitesse_pics : 'off' (défaut) | 'conducteur' | 'troncons' | 'nominatif'.
// Avec 'off', la vitesse max n'est ni calculée ni renvoyée.
export const VITESSE_PICS = ['off', 'conducteur', 'troncons', 'nominatif'];
const RAYON_ARRET_M = 30, V_ARRET_KMH = 3;
const dist2 = (a, b) => 6371000 * Math.hypot((b.lon - a.lon) * Math.PI / 180 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180), (b.lat - a.lat) * Math.PI / 180);

export function indicateursVitesse(texte, { arrets = [], intervalles = null, options = {} } = {}) {
  const pics = VITESSE_PICS.includes(options.vitesse_pics) ? options.vitesse_pics : 'off';
  const brut = lireCsv(texte);
  const garde = brut.t_s.map(t => t >= 5), d = {};
  for (const c in brut) d[c] = brut[c].filter((_, i) => garde[i]);
  const vs = lp(remplir(d.vitesse_kmh).map(x => x / 3.6), 0.15);
  const lat = remplir(d.latitude), lon = remplir(d.longitude), t = d.t_s;
  const dedans = i => !intervalles || intervalles.some(([a, b]) => t[i] >= a && t[i] <= b);
  const idx = t.map((_, i) => i).filter(dedans);
  if (idx.length < 2) return null;

  // distance : trapèzes sur la vitesse lissée, comme analyse_kind.py (np.trapezoid, pas de 1/5 s)
  let m = 0;
  for (let k = 1; k < idx.length; k++) if (idx[k] === idx[k - 1] + 1) m += (vs[idx[k]] + vs[idx[k - 1]]) / 2 / FS;
  // durée totale : de la première à la dernière mesure de chaque intervalle (arrêts compris)
  let duree = 0, debut = idx[0];
  for (let k = 1; k <= idx.length; k++) if (k === idx.length || idx[k] !== idx[k - 1] + 1) { duree += t[idx[k - 1]] - t[debut]; debut = idx[k]; }

  // temps en roulage et à l'arrêt : une ligne = 1/5 s ; à l'arrêt, au point d'arrêt GTFS ou ailleurs
  let roule = 0, auxArrets = 0, ailleurs = 0, nbAuxArrets = 0, nbAilleurs = 0, prec = null;
  for (const i of idx) {
    if (vs[i] * 3.6 > V_ARRET_KMH) { roule += 1 / FS; prec = null; continue; }
    const p = { lat: lat[i], lon: lon[i] };
    const ici = arrets.some(a => dist2(p, a) <= RAYON_ARRET_M) ? 'arret' : 'ailleurs';
    if (ici === 'arret') auxArrets += 1 / FS; else ailleurs += 1 / FS;
    if (ici !== prec) { if (ici === 'arret') nbAuxArrets++; else nbAilleurs++; }
    prec = ici;
  }
  const mesure = roule + auxArrets + ailleurs;
  // l'export n'est pas exactement à 5 Hz (environ 0,21 s par ligne) : les temps sont des parts de la durée réelle
  const part = x => (mesure ? x / mesure : 0) * duree;
  let coupures = 0;
  for (let k = 1; k < idx.length; k++) if (idx[k] === idx[k - 1] + 1) { const g = t[idx[k]] - t[idx[k - 1]]; if (g > 1) coupures += g; }
  const r = {
    km: pyRound(m / 1000, 2), duree_min: pyRound(duree / 60, 1), duree_s: Math.round(duree),
    vitesse_commerciale_kmh: duree > 0 ? pyRound(m / duree * 3.6, 1) : null,
    vitesse_roulage_kmh: roule > 0 ? pyRound(m / part(roule) * 3.6, 1) : null,
    temps_roulage_s: Math.round(part(roule)), temps_arret_s: Math.round(part(auxArrets + ailleurs)),
    temps_arret_aux_arrets_s: Math.round(part(auxArrets)), temps_arret_ailleurs_s: Math.round(part(ailleurs)),
    part_arret: mesure ? pyRound((auxArrets + ailleurs) / mesure, 3) : null,
    part_arret_aux_arrets: mesure ? pyRound(auxArrets / mesure, 3) : null,
    part_arret_ailleurs: mesure ? pyRound(ailleurs / mesure, 3) : null,
    nb_arrets_aux_arrets: nbAuxArrets, nb_arrets_ailleurs: nbAilleurs,
    temps_coupures_s: Math.round(coupures),   // trous de plus d'une seconde dans l'enregistrement
    vitesse_pics: pics,
  };
  // vitesse max : seulement si l'exploitant a activé l'option (CNIL : off par défaut)
  if (pics !== 'off') r.vitesse_max_kmh = pyRound(Math.max(...idx.map(i => vs[i])) * 3.6);
  return r;
}

// ---------- accostage et départ d'arrêt (docs/INDICATEURS.md, point 3) ----------
// Arrêts desservis : le bus s'arrête (vitesse lissée ≤ 3 km/h) à 30 m au plus d'un arrêt GTFS.
// Les événements notés à 150 m au plus d'un arrêt desservi, dans la minute qui précède l'arrivée,
// forment l'accostage ; dans la minute qui suit le départ, le départ d'arrêt.
// C'est là que les voyageurs sont debout (montée, descente, recherche d'une place).
const RAYON_ACCOSTAGE_M = 150, FENETRE_ACCOSTAGE_S = 60, NOTES = [100, 70, 30, 0];

export function arretsDesservis(texte, arrets) {
  const brut = lireCsv(texte), garde = brut.t_s.map(t => t >= 5), d = {};
  for (const c in brut) d[c] = brut[c].filter((_, i) => garde[i]);
  const vs = lp(remplir(d.vitesse_kmh).map(x => x / 3.6), 0.15), lat = remplir(d.latitude), lon = remplir(d.longitude);
  const res = [];
  let cur = null;
  for (let i = 0; i < vs.length; i++) {
    let ici = null;
    if (vs[i] * 3.6 <= V_ARRET_KMH) {
      const p = { lat: lat[i], lon: lon[i] };
      let best = null; for (const a of arrets) { const dd = dist2(p, a); if (dd <= RAYON_ARRET_M && (!best || dd < best.d)) best = { d: dd, a }; }
      ici = best && best.a;
    }
    if (ici && cur && (cur.arret === ici || cur.arret.nom === ici.nom)) { cur.t_depart = d.t_s[i]; continue; }
    if (cur) { res.push(cur); cur = null; }
    if (ici) cur = { arret: ici, t_arrivee: d.t_s[i], t_depart: d.t_s[i] };
  }
  if (cur) res.push(cur);
  return res;
}

export function accostage(texte, evenements, arrets) {
  const desservis = arretsDesservis(texte, arrets), acc = [], dep = [];
  for (const e of evenements) {
    for (const s of desservis) {
      if (dist2(e, s.arret) > RAYON_ACCOSTAGE_M) continue;
      if (e.t <= s.t_arrivee && e.t >= s.t_arrivee - FENETRE_ACCOSTAGE_S) { acc.push(e); break; }
      if (e.t >= s.t_depart && e.t <= s.t_depart + FENETRE_ACCOSTAGE_S) { dep.push(e); break; }
    }
  }
  const resume = l => ({ nb: l.length, brusques: l.filter(e => e.niveau >= 2).length, note: l.length ? pyRound(mean(l.map(e => NOTES[e.niveau]))) : null });
  return { arrets_desservis: desservis.length, accostage: resume(acc), depart: resume(dep) };
}

// ---------- qualité de la mesure (docs/INDICATEURS.md, point 3) ----------
// Mesure douteuse si la corrélation avant-arrière avec le GPS est sous 0,6
// ou si les trous de plus d'une seconde dépassent 5 % du temps.
export function qualiteMesure(texte, analyse) {
  const t = lireCsv(texte).t_s.filter(x => x >= 5);
  let trous = 0, nb = 0;
  for (let i = 1; i < t.length; i++) { const g = t[i] - t[i - 1]; if (g > 1) { trous += g; nb++; } }
  const duree = t.length > 1 ? t[t.length - 1] - t[0] : 0, part = duree ? trous / duree : 0;
  const raisons = [];
  if (!(analyse.corr_avant >= 0.6)) raisons.push(`axe avant mal recalé sur le GPS (corrélation ${String(analyse.corr_avant).replace('.', ',')} < 0,6)`);
  if (part > 0.05) raisons.push(`enregistrement coupé ${Math.round(part * 100)} % du temps (> 5 %)`);
  return { corr_avant: analyse.corr_avant, corr_lateral: analyse.corr_lateral, nb_trous: nb, temps_trous_s: Math.round(trous),
    part_trous: pyRound(part, 3), douteuse: raisons.length > 0, raisons };
}

// ---------- rattachement à la course GTFS, ponctualité, inter-arrêts (docs/INDICATEURS.md, point 4) ----------
// horaires : conducteur/horaires-imagine.json (services, arrets, motifs, courses).
// debut : date et heure réelles de t_s = 0. intervalle : [t_debut, t_fin] de la course enregistrée.
// route, direction : ligne et sens connus (mode ligne), ou null pour chercher dans tout le réseau.
// Passage à un arrêt = à 30 m au plus ; s'il s'y arrête, l'heure retenue est celle du départ.
// La course retenue a au moins 3 arrêts passés dans l'ordre (4, dont un vrai arrêt, si la ligne n'est
// pas déclarée), au moins la moitié des arrêts prévus
// pendant l'enregistrement, et un écart médian à l'horaire de 10 min au plus. Sinon : hors service.
export const PONCTUALITE = { avance_s: 60, retard_s: 180 };   // en avance > 1 min, en retard > 3 min
const RAYON_PASSAGE_M = 30, ECART_MAX_S = 600;

const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
export function servicesDuJour(horaires, date) {
  const j = ymd(date), jour = (date.getDay() + 6) % 7, actifs = new Set();   // lundi = 0
  for (const [id, s] of Object.entries(horaires.services)) {
    let ok = s.jours[jour] === '1' && j >= s.debut && j <= s.fin;
    if (s.plus.includes(j)) ok = true;
    if (s.moins.includes(j)) ok = false;
    if (ok) actifs.add(id);
  }
  return actifs;
}
const mediane = l => { const s = [...l].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function rattacherCourse(texte, horaires, { debut, intervalle = null, route = null, direction = null, options = {} } = {}) {
  const P = { ...PONCTUALITE, ...(options.ponctualite || {}) };
  const brut = lireCsv(texte), garde = brut.t_s.map(t => t >= 5), d = {};
  for (const c in brut) d[c] = brut[c].filter((_, i) => garde[i]);
  const t = d.t_s, vs = lp(remplir(d.vitesse_kmh).map(x => x / 3.6), 0.15), lat = remplir(d.latitude), lon = remplir(d.longitude);
  const idx = t.map((_, i) => i).filter(i => !intervalle || (t[i] >= intervalle[0] && t[i] <= intervalle[1]));
  if (idx.length < 10) return { hors_service: true, raison: 'trajet trop court' };
  const d0 = new Date(debut), minuit = new Date(d0); minuit.setHours(0, 0, 0, 0);
  const base = (d0 - minuit) / 1000;   // secondes depuis minuit à t_s = 0
  const tMin = (base + t[idx[0]]) / 60, tMax = (base + t[idx[idx.length - 1]]) / 60;

  // passages du véhicule à un arrêt (mis en cache)
  const cache = new Map();
  const passages = id => {
    if (cache.has(id)) return cache.get(id);
    const [la, lo] = horaires.arrets[id], a = { lat: la, lon: lo }, res = [];
    let run = null;
    const clore = () => { if (!run) return; res.push({ t: run.dernierArret ?? run.tMin, arret: run.dernierArret != null }); run = null; };
    for (const i of idx) {
      const dd = dist2({ lat: lat[i], lon: lon[i] }, a);
      if (dd > RAYON_PASSAGE_M) { clore(); continue; }
      if (!run) run = { dMin: Infinity, tMin: t[i], dernierArret: null };
      if (dd < run.dMin) { run.dMin = dd; run.tMin = t[i]; }
      if (vs[i] * 3.6 <= V_ARRET_KMH) run.dernierArret = t[i];
    }
    clore(); cache.set(id, res); return res;
  };

  const actifs = servicesDuJour(horaires, d0);
  let best = null, nbCandidats = 0;
  for (const c of horaires.courses) {
    const [trip, rid, dir, sid, im, dest, h] = c;
    if (!actifs.has(sid) || (route && rid !== route) || (direction != null && dir !== direction)) continue;
    if (h[h.length - 1] < tMin - 5 || h[0] > tMax + 5) continue;
    nbCandidats++;
    const motif = horaires.motifs[im];
    let dernier = -Infinity; const vus = [];
    for (let k = 0; k < motif.length; k++) {
      const p = passages(motif[k]).find(v => v.t > dernier);
      if (p) { vus.push({ k, t: p.t, arret: p.arret }); dernier = p.t; }
    }
    const attendus = h.filter(m => m >= tMin - 2 && m <= tMax + 2).length;
    // sans ligne déclarée, plus exigeant : 4 arrêts au moins, dont un où le véhicule s'est vraiment arrêté
    if (vus.length < (route ? 3 : 4) || vus.length < 0.5 * attendus || (!route && !vus.some(v => v.arret))) continue;
    const ecarts = vus.map(v => base + v.t - h[v.k] * 60), cout = mediane(ecarts.map(Math.abs));
    if (cout > ECART_MAX_S) continue;
    if (!best || cout < best.cout - 30 || (Math.abs(cout - best.cout) <= 30 && vus.length > best.vus.length)) best = { c, vus, ecarts, cout };
  }
  if (!best) return { hors_service: true, raison: nbCandidats ? 'aucune course ne colle aux arrêts et à l’horaire' : 'aucune course prévue à cette heure', candidats: nbCandidats };

  const [trip, rid, dir, sid, im, dest, h] = best.c, motif = horaires.motifs[im];
  const statut = e => e < -P.avance_s ? 'avance' : e > P.retard_s ? 'retard' : 'heure';
  const arrets = best.vus.map((v, n) => ({ id: motif[v.k], nom: horaires.arrets[motif[v.k]][2], rang: v.k + 1,
    prevu_min: h[v.k], reel_s: Math.round(base + v.t), ecart_s: Math.round(best.ecarts[n]), statut: statut(best.ecarts[n]), arret_marque: v.arret }));
  const inter = [];
  for (let n = 1; n < best.vus.length; n++) {
    const a = best.vus[n - 1], b = best.vus[n];
    if (b.k !== a.k + 1) continue;   // inter-arrêt seulement entre deux arrêts consécutifs passés
    inter.push({ de: horaires.arrets[motif[a.k]][2], a: horaires.arrets[motif[b.k]][2], reel_s: Math.round(b.t - a.t), prevu_s: Math.round((h[b.k] - h[a.k]) * 60) });
  }
  const compte = s => arrets.filter(a => a.statut === s).length;
  return {
    hors_service: false,
    course: { trip_id: trip, route_id: rid, direction: dir, service_id: sid, destination: dest, depart_prevu_min: h[0], arrivee_prevue_min: h[h.length - 1], nb_arrets: motif.length },
    ponctualite: { nb: arrets.length, a_l_heure: compte('heure'), avance: compte('avance'), retard: compte('retard'),
      ecart_median_s: Math.round(mediane(best.ecarts)), seuils: P },
    arrets, inter_arrets: inter,
  };
}

// ---------- ralentissements hors arrêt, par trajet (docs/INDICATEURS.md, point 5, première étape) ----------
// Épisode où la vitesse lissée reste sous 10 km/h pendant plus de 20 s, en dehors des abords
// immédiats des arrêts (30 m) : feux, congestion, aménagements. Le cumul sur tous les trajets
// (même endroit, combien de trajets, temps perdu moyen) viendra avec le serveur.
const V_RALENTI_KMH = 10, DUREE_RALENTI_S = 20, REPERE_MAX_M = 300;

export function ralentissements(texte, arrets, { intervalles = null } = {}) {
  const brut = lireCsv(texte), garde = brut.t_s.map(t => t >= 5), d = {};
  for (const c in brut) d[c] = brut[c].filter((_, i) => garde[i]);
  const t = d.t_s, vs = lp(remplir(d.vitesse_kmh).map(x => x / 3.6), 0.15), lat = remplir(d.latitude), lon = remplir(d.longitude);
  const dedans = i => !intervalles || intervalles.some(([a, b]) => t[i] >= a && t[i] <= b);
  const procheArret = i => arrets.some(a => dist2({ lat: lat[i], lon: lon[i] }, a) <= RAYON_ARRET_M);
  // l'attente avant le départ et le stationnement à l'arrivée ne sont pas des ralentissements :
  // on ne regarde qu'entre le premier et le dernier passage au-dessus de 10 km/h
  // (5 s de suite, pour ne pas se laisser tromper par un sursaut du GPS à l'arrêt)
  const vite = t.map((_, i) => dedans(i) && vs[i] * 3.6 >= V_RALENTI_KMH), N = 5 * FS;
  const soutenu = i => { for (let q = i; q < i + N; q++) if (!vite[q]) return false; return true; };
  const rapides = t.map((_, i) => i).filter(i => i + N <= t.length && soutenu(i));
  if (!rapides.length) return { nb: 0, duree_totale_s: 0, episodes: [] };
  const [i0, i1] = [rapides[0], rapides[rapides.length - 1] + N - 1];
  const lent = t.map((_, i) => i > i0 && i < i1 && dedans(i) && vs[i] * 3.6 < V_RALENTI_KMH && !procheArret(i));
  const res = [];
  for (let i = 0; i < t.length;) {
    if (!lent[i]) { i++; continue; }
    let j = i; while (j + 1 < t.length && lent[j + 1] && t[j + 1] - t[j] <= 2) j++;
    const duree = t[j] - t[i];
    if (duree >= DUREE_RALENTI_S) {
      let k = i; for (let q = i; q <= j; q++) if (vs[q] < vs[k]) k = q;   // le point le plus lent situe le ralentissement
      let m = 0; for (let q = i + 1; q <= j; q++) m += (vs[q] + vs[q - 1]) / 2 * (t[q] - t[q - 1]);
      const p = { lat: lat[k], lon: lon[k] };
      let repere = null; for (const a of arrets) { const dd = dist2(p, a); if (dd <= REPERE_MAX_M && (!repere || dd < repere.d)) repere = { d: dd, nom: a.nom }; }
      res.push({ t_debut: t[i], t_fin: t[j], duree_s: Math.round(duree), distance_m: Math.round(m),
        vitesse_moy_kmh: pyRound(m / duree * 3.6, 1), arret_complet: vs[k] * 3.6 <= V_ARRET_KMH,
        lat: pyRound(p.lat, 6), lon: pyRound(p.lon, 6), repere: repere ? { nom: repere.nom, distance_m: Math.round(repere.d) } : null });
    }
    i = j + 1;
  }
  return { nb: res.length, duree_totale_s: res.reduce((s, r) => s + r.duree_s, 0), episodes: res };
}
