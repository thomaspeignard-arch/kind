// Mesure en temps réel avec les capteurs du téléphone (accéléromètre + GPS).
// Même traitement que la page de test (index.html) : accélération totale projetée dans le plan
// horizontal, filtre 1,5 Hz, axe avant appris par le GPS, signe du latéral par le cap calculé
// depuis les positions, à-coup sur le signal filtré à 1 Hz rééchantillonné à 5 Hz.

export const LOG_HEAD = 't_s,latitude,longitude,vitesse_kmh,h1,h2,longitudinal,lateral,jerk,niveau';

const norm = v => { const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export function distM(a, b) {
  const x = (b.lon - a.lon) * Math.PI / 180 * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180), y = (b.lat - a.lat) * Math.PI / 180;
  return 6371000 * Math.hypot(x, y);
}
const bearingDeg = (a, b) => (Math.atan2((b.lon - a.lon) * Math.cos((a.lat + b.lat) / 2 * Math.PI / 180), b.lat - a.lat) * 180 / Math.PI + 360) % 360;
const JSTEP = 0.2;

// onEchantillon({t, lon, lat, mag, jerk, known, speed, gps}) est appelé à chaque mesure ;
// niveau() renvoie le niveau affiché, enregistré dans le journal à 5 Hz.
export function creerMesure({ onEchantillon, onStatut, niveau }) {
  const S = {};
  const log = [];
  let t0 = 0, watch = null, wake = null, actif = false;

  function setUp(g) { S.up = norm(g); const ref = Math.abs(S.up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; S.e1 = norm(cross(S.up, ref)); S.e2 = cross(S.up, S.e1); }

  function onMotion(ev) {
    const a = ev.accelerationIncludingGravity; if (!a || a.x == null) return;
    const now = performance.now() / 1000, g = [a.x, a.y, a.z];
    if (!S.last) { S.last = now; return; }
    const dt = Math.min(0.1, Math.max(0.001, now - S.last)); S.last = now;
    if (now < S.calibUntil) { S.calib.push(g); onStatut('Calibrage… restez immobile'); return; }
    if (!S.up) { const m = [0, 1, 2].map(i => S.calib.reduce((s, v) => s + v[i], 0) / Math.max(1, S.calib.length)); setUp(m); onStatut('Calibré. Bonne route !'); }
    if (S.gps && S.gps.speed != null && S.gps.speed < 0.3) setUp(S.up.map((u, i) => u * 0.995 + g[i] / 9.81 * 0.005));
    const h = [dot(g, S.e1), dot(g, S.e2)];
    const k = dt / (0.106 + dt); S.lp = S.lp.map((v, i) => v + k * (h[i] - v));
    const k1 = dt / (0.159 + dt), lp1Prev = S.lp1.slice(); S.lp1 = S.lp1.map((v, i) => v + k1 * (h[i] - v));
    const kb = dt / 15; S.bias = S.bias.map((b, i) => b + kb * (S.lp[i] - b));
    const a1 = S.lp[0] - S.bias[0], a2 = S.lp[1] - S.bias[1], mag = Math.hypot(a1, a2);
    // à-coup sur le signal filtré à 1 Hz, rééchantillonné à pas fixe 0,2 s
    const J = S.jk, tPrev = now - dt;
    if (J.t == null || now - J.t > 1) { J.t = now; J.prev = S.lp1.slice(); J.val = 0; }
    else while (now >= J.t + JSTEP) {
      const tt = J.t + JSTEP, f = Math.min(1, Math.max(0, (tt - tPrev) / dt));
      const cur = [0, 1].map(i => lp1Prev[i] + f * (S.lp1[i] - lp1Prev[i]));
      J.val = Math.hypot(cur[0] - J.prev[0], cur[1] - J.prev[1]) / JSTEP; J.prev = cur; J.t = tt;
    }
    S.sumIdx.m1 += a1; S.sumIdx.m2 += a2; S.sumIdx.n++;
    let lon = 0, lat = 0, known = false;
    if (S.fwd) { lon = S.fwd[0] * a1 + S.fwd[1] * a2; lat = (S.latSign.s >= 0 ? 1 : -1) * (-S.fwd[1] * a1 + S.fwd[0] * a2); known = true; }
    const speed = S.gps ? S.gps.speed : null;
    onEchantillon({ t: now - t0, lon, lat, mag, jerk: J.val, known, speed, gps: S.gps });
    if (!S.lastLog || now - S.lastLog >= 0.2) {
      S.lastLog = now;
      log.push([(now - t0).toFixed(1), S.gps ? S.gps.lat.toFixed(6) : '', S.gps ? S.gps.lon.toFixed(6) : '', speed == null ? '' : (speed * 3.6).toFixed(1),
        a1.toFixed(2), a2.toFixed(2), known ? lon.toFixed(2) : '', known ? lat.toFixed(2) : '', J.val.toFixed(2), niveau()]);
    }
  }

  function onGps(p) {
    const c = p.coords, t = p.timestamp / 1000;
    const cur = { t, lat: c.latitude, lon: c.longitude, speed: (c.speed != null && !isNaN(c.speed)) ? c.speed : null };
    const prev = S.gps; S.gps = cur;
    const n = S.sumIdx.n, m1 = n ? S.sumIdx.m1 / n : 0, m2 = n ? S.sumIdx.m2 / n : 0;
    S.sumIdx = { m1: 0, m2: 0, n: 0 };
    if (n) { S.hist.push({ t, m1, m2 }); if (S.hist.length > 30) S.hist.shift(); }
    learnLatSign(cur);
    if (!prev || cur.speed == null || prev.speed == null || !n) return;
    const dt = t - prev.t; if (dt < 0.5 || dt > 3) return;
    const aGps = (cur.speed - prev.speed) / dt;
    if (cur.speed > 2 && Math.abs(aGps) > 0.25) {
      const R = S.reg; R.a += m1 * m1; R.b += m1 * m2; R.c += m2 * m2; R.d += m1 * aGps; R.e += m2 * aGps; R.n++;
      const det = R.a * R.c - R.b * R.b;
      if (R.n >= 12 && Math.abs(det) > 1e-6) { const cc = (R.c * R.d - R.b * R.e) / det, ss = (R.a * R.e - R.b * R.d) / det, nn = Math.hypot(cc, ss); if (nn > 0.3) S.fwd = [cc / nn, ss / nn]; }
    }
  }

  function learnLatSign(cur) {
    if (!S.anchor || cur.t - S.anchor.t > 6) { S.anchor = cur; S.seg = null; return; }
    if (distM(S.anchor, cur) < 5) return;
    const seg = { h: bearingDeg(S.anchor, cur), t: (S.anchor.t + cur.t) / 2 };
    const prevSeg = S.seg; S.seg = seg; S.anchor = cur;
    if (!prevSeg || !S.fwd || cur.speed == null || cur.speed <= 3) return;
    const span = seg.t - prevSeg.t; if (span < 0.5 || span > 6) return;
    let dh = seg.h - prevSeg.h; if (dh > 180) dh -= 360; if (dh < -180) dh += 360;
    const pts = S.hist.filter(p => p.t > prevSeg.t && p.t <= cur.t); if (!pts.length) return;
    const m1 = pts.reduce((s, p) => s + p.m1, 0) / pts.length, m2 = pts.reduce((s, p) => s + p.m2, 0) / pts.length;
    const cent = cur.speed * dh * Math.PI / 180 / span, latRaw = -S.fwd[1] * m1 + S.fwd[0] * m2;
    if (Math.abs(cent) > 0.8) { S.latSign.s += Math.sign(cent * latRaw); S.latSign.n++; }
  }

  async function garderEcranAllume() { try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* refusé : rien à faire */ } }
  const surVisibilite = () => { if (actif && document.visibilityState === 'visible') garderEcranAllume(); };

  return {
    log,
    // à appeler depuis un appui de l'utilisateur (autorisation des capteurs sur iPhone)
    async demarrer() {
      if (typeof DeviceMotionEvent === 'undefined') throw new Error('Ce navigateur ne donne pas accès aux capteurs de mouvement.');
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') throw new Error('Accès aux capteurs refusé : autorisez-le dans les réglages du navigateur.');
      }
      t0 = performance.now() / 1000;
      Object.assign(S, { up: null, calib: [], calibUntil: t0 + 3, last: null, lp: [0, 0], lp1: [0, 0], bias: [0, 0], fwd: null,
        sumIdx: { m1: 0, m2: 0, n: 0 }, reg: { a: 0, b: 0, c: 0, d: 0, e: 0, n: 0 }, latSign: { s: 0, n: 0 },
        jk: { t: null, prev: null, val: 0 }, anchor: null, seg: null, hist: [], gps: null, lastLog: 0 });
      log.length = 0; actif = true;
      window.addEventListener('devicemotion', onMotion);
      if ('geolocation' in navigator) watch = navigator.geolocation.watchPosition(onGps, () => onStatut('GPS indisponible : les courses ne seront pas reconnues automatiquement.'), { enableHighAccuracy: true, maximumAge: 0 });
      document.addEventListener('visibilitychange', surVisibilite);
      garderEcranAllume();
      setTimeout(() => { if (actif && !S.last) onStatut('Aucune donnée des capteurs : vérifiez que la page est ouverte en https.'); }, 2500);
    },
    arreter() {
      actif = false;
      window.removeEventListener('devicemotion', onMotion);
      document.removeEventListener('visibilitychange', surVisibilite);
      if (watch != null) navigator.geolocation.clearWatch(watch);
      if (wake) { wake.release().catch(() => {}); wake = null; }
    },
  };
}
