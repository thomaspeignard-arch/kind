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
  const L = h1.map((x, i) => Math.cos(th) * x + Math.sin(th) * h2[i]);
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
