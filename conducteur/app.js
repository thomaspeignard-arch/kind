// Kind — prototype de l'appli conducteur.
// Parcours : identification → choix du trajet (ligne et sens, trajet libre ou trajet de test) →
// conduite (verre d'eau seul) → fin de service : ressenti avant le score → bilan.
// Tout reste dans le téléphone (IndexedDB) ; Supabase viendra plus tard.
import { creerMesure, distM, LOG_HEAD } from './mesure.js';
import { analyseCsv, indicateursVitesse, accostage, qualiteMesure, rattacherCourse, servicesDuJour, PROF } from '../outils/analyse-csv.js';
import { lireOptions } from './options.js';
const OPTIONS = lireOptions();

const $ = id => document.getElementById(id);
const VMIN = 3 / 3.6;            // sous 3 km/h : rien n'est compté (manipulation à l'arrêt)
const RAYON_ARRET = 30;          // géorepérage des arrêts (m)
const NOMS_PROFIL = { bus: 'Bus urbain, passagers debout', car: 'Autocar, passagers assis', voiture: 'Voiture' };
const NOMS_MODE = { ligne: 'Ligne', libre: 'Trajet libre', test: 'Trajet de test', passager: 'Trajet passager' };
const passager = () => E.role === 'passager';
const COUL = ['#5FA8D3', '#F2B04A', '#FF8A50'], BANDE = [4, 12, 24];
const NOTE_COUL = ['#3B82C4', '#D4A017', '#E07B39', '#C0392B'], NIVEAUX = ['doux', 'limite', 'brusque', 'très brusque'];
const ICO = {
  freinage: '<path d="M3 12h11M10 7l5 5-5 5M20 5v14"/>',
  accélération: '<path d="M4 7l5 5-5 5M11 7l5 5-5 5M18 7v10"/>',
  vd: '<path d="M6 20v-6a6 6 0 0 1 6-6h7M15 4l4 4-4 4"/>',
  vg: '<path d="M18 20v-6a6 6 0 0 0-6-6H5M9 4L5 8l4 4"/>',
};
const icone = (k, c = 'currentColor') => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dix = x => x.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });   // 7.5 → « 7,5 »
const heure = d => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

let reseau = null, horaires = null;   // horaires GTFS : chargés en arrière-plan, pour la ponctualité
const heureMin = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
const E = { // état du service en cours
  role: 'conducteur', campagne: '', conducteur: '', vehicule: '', profil: 'bus', mode: 'ligne', ligne: null, sensIdx: 0,
  id: 0, debut: null, log: [], courses: [], enCourse: null, tDernier: 0, gps: null,
  lvl: 0, lvlJusqua: 0, mesure: null, demo: null, ressenti: null, termine: false,
};

// ---------- écrans ----------
function montrer(id) {
  for (const s of document.querySelectorAll('.ecran')) s.classList.toggle('hidden', s.id !== id);
  document.body.classList.toggle('nuit', id === 'ecranConduite');
  const titre = document.querySelector(`#${id} h1, #${id} h2`); if (titre) { titre.setAttribute('tabindex', '-1'); titre.focus(); }
}

// ---------- identification ----------
function initIdentification() {
  try { $('code').value = localStorage.getItem('kind.conducteur') || ''; } catch (e) { /* stockage indisponible */ }
  $('formId').addEventListener('submit', ev => {
    ev.preventDefault();
    const code = $('code').value.trim(), pin = $('pin').value.trim();
    if (!code) return erreur('erreurId', 'Saisissez votre code conducteur.');
    if (!/^\d{4}$/.test(pin)) return erreur('erreurId', 'Le code PIN compte 4 chiffres.');
    erreur('erreurId', '');
    E.conducteur = code; try { localStorage.setItem('kind.conducteur', code); } catch (e) { /* rien */ }
    $('pin').value = '';
    E.role = 'conducteur'; configurerRole();
    montrer('ecranService');
  });
  $('passagerBtn').addEventListener('click', () => { E.role = 'passager'; configurerRole(); montrer('ecranService'); });
}
// le passager monte en cours de ligne : pas de type de trajet, de véhicule ni de profil, un code de campagne
function configurerRole() {
  const p = passager();
  $('optTest').classList.toggle('hidden', p); if (p && document.querySelector('input[name=mode]:checked').value === 'test') document.querySelector('input[name=mode][value=ligne]').checked = true; $('blocVehicule').classList.toggle('hidden', p);
  $('blocCampagne').classList.toggle('hidden', !p);
  $('titreService').textContent = p ? 'Mon trajet' : 'Nouveau service';
  $('bonjour').textContent = p ? 'Choisissez la ligne et le sens du bus dans lequel vous montez.' : `Conducteur ${E.conducteur}`;
  $('conseil').textContent = p ? 'Posez le téléphone à plat (sur vos genoux ou un siège) et ne le bougez plus pendant le trajet. Au départ, restez immobile 3 secondes.'
    : 'Fixez le téléphone sur son support et ne le bougez plus. Au départ, restez immobile 3 secondes.';
  $('demarrer').textContent = p ? 'Démarrer la mesure' : 'Démarrer le service';
  $('finService').textContent = p ? 'Je descends' : 'Arrêter';
  $('titreRessenti').textContent = 'Avant de voir le score';
  $('questionRessenti').textContent = p ? 'Selon vous, quel score mérite le confort de ce trajet ?' : 'Selon vous, quel score mérite votre conduite de ce service ?';
  majMode();
}
function erreur(id, txt) { $(id).textContent = txt; }

// ---------- choix du trajet ----------
function initService() {
  const sel = $('ligne');
  const urbaines = reseau.lignes.filter(l => /^\d+$/.test(l.nom_court)), autres = reseau.lignes.filter(l => !/^\d+$/.test(l.nom_court));
  for (const [lab, ls] of [['Lignes urbaines', urbaines], ['Lignes scolaires et interurbaines', autres]]) {
    const og = document.createElement('optgroup'); og.label = lab;
    for (const l of ls) { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.nom_court} · ${l.nom}`; og.append(o); }
    sel.append(og);
  }
  sel.addEventListener('change', afficherSens);
  for (const r of document.querySelectorAll('input[name=mode]')) r.addEventListener('change', majMode);
  afficherSens(); majMode();
  $('formService').addEventListener('submit', ev => { ev.preventDefault(); demarrerService(false); });
  $('demoBtn').addEventListener('click', () => demarrerService(true));
  $('changer').addEventListener('click', () => montrer('ecranId'));
}
function majMode() {
  const m = document.querySelector('input[name=mode]:checked').value;
  $('blocLigne').classList.toggle('hidden', m !== 'ligne');
  $('noteMode').textContent = passager()
    ? (m === 'ligne' ? 'La mesure commence tout de suite, même en cours de ligne, et s’arrête quand vous descendez.' : 'Sans ligne : la mesure commence tout de suite et s’arrête quand vous descendez.')
    : m === 'ligne' ? 'Le trajet jusqu’au premier arrêt n’est pas noté. Chaque course commence au premier arrêt de la ligne.'
    : m === 'libre' ? 'Tout le trajet est noté, du départ jusqu’à la fin du service.'
    : 'Trajet noté mais non comptabilisé, pour tester Kind. Pensez à partager les données à la fin.';
}
function afficherSens() {
  const l = reseau.lignes.find(x => x.id === $('ligne').value), box = $('sens'); box.textContent = '';
  l.sens.forEach((s, i) => {
    const lab = document.createElement('label'); lab.className = 'choix';
    lab.innerHTML = `<input type="radio" name="sens" value="${i}" ${i === 0 ? 'checked' : ''}><span><b>→ ${esc(s.destination || s.arrets[s.arrets.length - 1].nom)}</b><small>Départ : ${esc(s.arrets[0].nom)} · ${s.arrets.length} arrêts</small></span>`;
    box.append(lab);
  });
}

// ---------- conduite ----------
async function demarrerService(demo) {
  E.mode = document.querySelector('input[name=mode]:checked').value;
  E.profil = passager() ? 'bus' : document.querySelector('input[name=profil]:checked').value;
  E.vehicule = passager() ? '' : $('vehicule').value.trim();
  E.campagne = passager() ? $('campagne').value.trim() : '';
  E.ligne = E.mode === 'ligne' ? reseau.lignes.find(x => x.id === $('ligne').value) : null;
  E.sensIdx = E.ligne ? +document.querySelector('input[name=sens]:checked').value : 0;
  Object.assign(E, { debut: new Date(), courses: [], enCourse: null, tDernier: 0, gps: null, lvl: 0, lvlJusqua: 0, ressenti: null, termine: false, demo: null, simulation: false, bilan: null });
  E.id = E.debut.getTime(); E.estDemo = demo;
  montrer('ecranConduite'); dessiner(0, 0, 0, false); majPuce();
  if (demo) { E.log = []; lancerDemo(); }
  else {
    E.mesure = creerMesure({ onEchantillon: surEchantillon, onStatut: t => { $('statut').textContent = t; }, niveau: () => E.lvl });
    E.log = E.mesure.log;
    try { await E.mesure.demarrer(); } catch (e) { $('statut').textContent = e.message; return; }
    $('statut').textContent = 'Calibrage… restez immobile';
  }
  if (E.mode !== 'ligne' || passager()) debutCourse(0, false);
  E.sauvegarde = setInterval(() => sauver().catch(() => {}), 20000);
}

function niveauDe(lon, lat, mag, jerk, known) {
  const [ta, tj] = PROF[E.profil];
  const a = known ? Math.max(Math.abs(lon), Math.abs(lat)) : mag;
  return Math.max(a >= ta[1] ? 2 : a >= ta[0] ? 1 : 0, jerk >= tj[1] ? 2 : jerk >= tj[0] ? 1 : 0);
}
function surEchantillon({ t, lon, lat, mag, jerk, known, speed, gps }) {
  E.tDernier = t;
  const roule = speed == null || speed >= VMIN;
  const lvl = roule ? niveauDe(lon, lat, mag, jerk, known) : 0;
  if (lvl >= E.lvl || t > E.lvlJusqua) { if (lvl !== E.lvl || lvl > 0) E.lvlJusqua = t + 0.6; E.lvl = lvl; }
  dessiner(lon, lat, mag, known);
  if (gps && gps !== E.gps) { E.gps = gps; suivreCourse(t, gps); }
}
function dessiner(lon, lat, mag, known) {
  const dir = known ? (Math.abs(lon) >= Math.abs(lat) ? -Math.sign(lon) : Math.sign(lat)) : 1;
  const ang = Math.atan(mag / 9.81) * 180 / Math.PI * 1.6 * (dir || 1);
  $('liquide').setAttribute('transform', `rotate(${ang.toFixed(1)} 110 110)`);
  $('liq').setAttribute('fill', COUL[E.lvl]);
  $('gouttes').setAttribute('opacity', E.lvl === 2 ? 1 : 0);
  $('scene').style.boxShadow = `inset 0 0 0 ${BANDE[E.lvl]}px ${COUL[E.lvl]}`;
}

// courses reconnues par le GTFS : début au premier arrêt du sens, fin au terminus
function suivreCourse(t, gps) {
  if (E.mode !== 'ligne' || passager()) return;   // le passager monte en cours de ligne : mesure dès le départ
  const sens = E.ligne.sens[E.sensIdx], arr = sens.arrets;
  if (!E.enCourse) { if (distM(gps, arr[0]) <= RAYON_ARRET) debutCourse(t, true); return; }
  const c = E.enCourse;
  if (distM(gps, arr[0]) > 150) c.eloigne = true;   // évite de finir tout de suite sur une ligne en boucle
  if (c.eloigne && t - c.t_debut > 60 && distM(gps, arr[arr.length - 1]) <= RAYON_ARRET) finCourse(t, true);
}
function debutCourse(t, auto) {
  const sens = E.ligne ? E.ligne.sens[E.sensIdx] : null;
  E.enCourse = { n: E.courses.length + 1, t_debut: t, t_fin: null, auto, direction: sens ? sens.direction : null,
    destination: sens ? (sens.destination || sens.arrets[sens.arrets.length - 1].nom) : null, eloigne: false };
  majPuce();
}
function finCourse(t, auto) {
  if (!E.enCourse) return;
  E.enCourse.t_fin = t; E.enCourse.fin_auto = auto; E.courses.push(E.enCourse); E.enCourse = null;
  // la course suivante part dans l'autre sens
  if (E.ligne && E.ligne.sens.length > 1) E.sensIdx = (E.sensIdx + 1) % E.ligne.sens.length;
  majPuce();
}
function majPuce() {
  const p = $('puce'), b = $('courseBtn');
  if (passager()) { p.textContent = E.ligne ? `Passager · ligne ${E.ligne.nom_court} → ${E.ligne.sens[E.sensIdx].destination}` : 'Passager · trajet libre'; b.classList.add('hidden'); return; }
  if (E.mode !== 'ligne') { p.textContent = E.mode === 'test' ? 'Trajet de test' : 'Trajet libre'; b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  const s = E.ligne.sens[E.sensIdx];
  if (E.enCourse) { p.textContent = `Course ${E.enCourse.n} · ${E.ligne.nom_court} → ${E.enCourse.destination}`; p.classList.add('active'); b.textContent = 'Fin de course'; }
  else { p.textContent = `Non noté · vers ${s.arrets[0].nom}`; p.classList.remove('active'); b.textContent = 'Début de course'; }
}

function arreterCapteurs() {
  clearInterval(E.sauvegarde);
  if (E.mesure) { E.mesure.arreter(); E.mesure = null; }
  if (E.demo) { clearInterval(E.demo); E.demo = null; }
}
function finService() {
  arreterCapteurs();
  if (E.enCourse) finCourse(E.tDernier, false);
  E.termine = true; sauver().catch(() => {});
  $('ressenti').value = 5; $('ressentiVal').innerHTML = '–<small>/10</small>'; $('ressenti').dataset.touche = '';
  $('voirBilan').disabled = true;
  montrer('ecranRessenti');
}

// recommencer : efface l'enregistrement en cours et repart avec les mêmes réglages (nouveau calibrage)
async function recommencer() {
  if (!confirm('Effacer cet enregistrement et recommencer depuis le début ?')) return;
  const id = E.id, demo = E.estDemo;
  arreterCapteurs(); E.enCourse = null; E.id = 0;
  try { const d = await db(); await new Promise((res, rej) => { const tx = d.transaction('services', 'readwrite'); tx.objectStore('services').delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
  catch (e) { /* rien n'était encore sauvegardé */ }
  $('statut').textContent = '';
  demarrerService(demo);
}

// ---------- ressenti puis bilan ----------
function initRessenti() {
  const r = $('ressenti');
  // ressenti sur 10, au dixième près
  const maj = () => { r.dataset.touche = '1'; $('ressentiVal').innerHTML = `${dix(+r.value)}<small>/10</small>`; $('voirBilan').disabled = false; };
  r.addEventListener('input', maj);
  const pas = d => { r.value = Math.min(10, Math.max(0, Math.round((+r.value + d) * 10) / 10)); maj(); };
  $('moins').addEventListener('click', () => pas(-0.1)); $('plus').addEventListener('click', () => pas(0.1));
  $('voirBilan').addEventListener('click', () => { E.ressenti = +r.value; afficherBilan(); });
  $('passer').addEventListener('click', () => { E.ressenti = null; afficherBilan(); });
}

function csvService() { return LOG_HEAD + '\n' + E.log.map(r => r.join(',')).join('\n'); }

function calculerBilan() {
  if (!E.courses.length) return { erreur: 'Aucune course n’a été enregistrée : rien à noter.' };
  let res, complet;
  try { complet = analyseCsv(csvService()); res = complet.profils[E.profil]; } catch (e) { return { erreur: 'Trajet trop court pour être noté.' }; }
  const dans = ev => E.courses.findIndex(c => ev.t >= c.t_debut && ev.t <= c.t_fin);
  const evts = res.evenements.map(ev => ({ ...ev, course: dans(ev) })).filter(ev => ev.course >= 0);
  const NOTE = [100, 70, 30, 0], moy = l => l.length ? Math.round(l.reduce((s, e) => s + NOTE[e.niveau], 0) / l.length) : null;
  const sous = {};
  for (const c of ['freinage', 'accélération', 'virage']) { const l = evts.filter(e => e.crit === c); sous[c] = { nb: l.length, brusques: l.filter(e => e.niveau >= 2).length, note: moy(l) }; }
  const courses = E.courses.map((c, i) => { const l = evts.filter(e => e.course === i); return { ...c, score: moy(l), nb: l.length, brusques: l.filter(e => e.niveau >= 2).length }; });
  // indicateurs de vitesse sur les parties notées (les courses), arrêts de la ligne ou de tout le réseau
  let vitesse = null, aux = null, qualite = null;
  const arrets = (E.ligne ? [E.ligne] : reseau.lignes).flatMap(l => l.sens.flatMap(s => s.arrets));
  try { vitesse = indicateursVitesse(csvService(), { arrets, intervalles: E.courses.map(c => [c.t_debut, c.t_fin]), options: OPTIONS }); }
  catch (e) { /* pas assez de données de vitesse */ }
  // accostage et départ d'arrêt : événements notés à 150 m d'un arrêt desservi
  try { aux = accostage(csvService(), evts, arrets); } catch (e) { /* pas de positions */ }
  // qualité de la mesure, toujours affichée à côté du score
  try { qualite = qualiteMesure(csvService(), complet); } catch (e) { /* rien */ }
  // rattachement de chaque course à une course GTFS : ponctualité et inter-arrêts
  let ponct = null;
  if (horaires) ponct = E.courses.map(c => {
    try {
      return rattacherCourse(csvService(), horaires, { debut: E.debut, intervalle: [c.t_debut, c.t_fin],
        route: E.ligne ? E.ligne.id : null, direction: E.ligne ? c.direction : null, options: OPTIONS });
    } catch (e) { return { hors_service: true, raison: 'calcul impossible' }; }
  });
  return { score: moy(evts), sous, courses, evts, vitesse, aux, qualite, ponct };
}

function arretProche(ev) {
  const lignes = E.ligne ? [E.ligne] : reseau.lignes;
  let best = null;
  for (const l of lignes) for (const s of l.sens) for (const a of s.arrets) { const d = distM(ev, a); if (!best || d < best.d) best = { d, a }; }
  if (!best || best.d > 150) return '';
  // approche ou départ : la distance à l'arrêt 3 s plus tard
  const i = E.log.findIndex(r => +r[0] >= ev.t + 3), r = i >= 0 ? E.log[i] : null;
  if (best.d < 15) return `au niveau de ${best.a.nom}`;
  const plusTard = r && r[1] ? distM({ lat: +r[1], lon: +r[2] }, best.a) : best.d;
  return `${plusTard < best.d ? 'à l’approche de' : 'au départ de'} ${best.a.nom}`;
}

function afficherBilan() {
  const B = calculerBilan(), heureDe = t => heure(new Date(E.debut.getTime() + t * 1000));
  const fin = new Date(E.debut.getTime() + E.tDernier * 1000);
  $('bilanTitre').textContent = passager() ? (E.ligne ? `Ligne ${E.ligne.nom_court} · trajet passager` : 'Trajet libre · passager')
    : E.mode === 'ligne' ? `Ligne ${E.ligne.nom_court}` : NOMS_MODE[E.mode];
  $('bilanSous').textContent = `${E.debut.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}, ${heure(E.debut)}–${heure(fin)}` +
    `${E.vehicule ? ' · véhicule ' + E.vehicule : ''} · ${NOMS_PROFIL[E.profil]}`;
  $('bandeauTest').classList.toggle('hidden', E.mode !== 'test');
  const corps = $('bilanCorps');
  if (B.erreur) { corps.innerHTML = `<p class="carte">${esc(B.erreur)}</p>`; enregistrerBilan(B); montrer('ecranBilan'); return; }
  const sc = B.score ?? 100, coulSc = sc >= 85 ? '#3F8F6B' : sc >= 70 ? '#3B82C4' : sc >= 50 ? '#D4A017' : '#C0392B';
  const mot = sc >= 85 ? 'Conduite très douce' : sc >= 70 ? 'Conduite douce' : sc >= 50 ? 'À améliorer' : 'Conduite brusque';
  let h = `<section class="carte score"><div class="gros" style="color:${coulSc}">${sc}<small>/100</small></div><div><b>${mot}</b>`;
  if (E.ressenti != null) {
    // le ressenti est sur 10 : on ramène la mesure sur 10 pour comparer
    const d = Math.round((E.ressenti - sc / 10) * 10) / 10;
    h += `<p>Votre ressenti : <b>${dix(E.ressenti)}/10</b>, mesure : ${dix(sc / 10)}/10. ${Math.abs(d) <= 0.5 ? 'Très proche de la mesure.' : `${dix(Math.abs(d))} point${Math.abs(d) >= 2 ? 's' : ''} ${d > 0 ? 'au-dessus' : 'en dessous'} de la mesure.`}</p>`;
  }
  if (passager()) {
    h += `<p>${E.ligne ? 'Destination : ' + esc(E.ligne.sens[E.sensIdx].destination) : 'Trajet libre'}${E.campagne ? ' · campagne ' + esc(E.campagne) : ''}.</p>`;
  }
  h += `<p>${B.evts.length} freinages, accélérations et virages notés${B.score == null ? ' : aucun moment marquant' : ''}.</p>`;
  if (B.qualite) h += pastilleQualite(B.qualite);
  h += '</div></section>';
  h += '<section class="sous">';
  for (const [c, lab, ic] of [['freinage', 'Freinages', 'freinage'], ['accélération', 'Accélérations', 'accélération'], ['virage', 'Virages', 'vd']]) {
    const s = B.sous[c];
    h += `<div class="carte">${icone(ic, '#1F4E79')}<span class="lab">${lab}</span><b>${s.note ?? '–'}</b><small>${s.nb} notés · ${s.brusques} brusque${s.brusques > 1 ? 's' : ''}</small></div>`;
  }
  h += '</section>';
  if (B.aux) h += blocArrets(B.aux);
  if (B.ponct) h += blocPonctualite(B.ponct, B.courses);
  if (B.vitesse) h += blocVitesse(B.vitesse);
  if (E.mode === 'ligne' && !passager()) {
    h += '<h2>Courses</h2><ul class="liste">';
    for (const c of B.courses) h += `<li class="carte"><div><b>Course ${c.n} · ${esc(E.ligne.nom_court)} → ${esc(c.destination)}</b><small>${heureDe(c.t_debut)}–${heureDe(c.t_fin)}${c.auto ? '' : ' · démarrée à la main'}</small></div><b class="note">${c.score ?? '–'}</b></li>`;
    h += '</ul>';
  }
  const aRevoir = B.evts.filter(e => e.niveau >= 2).sort((a, b) => b.niveau - a.niveau || Math.abs(b.pic) - Math.abs(a.pic)).slice(0, 8).sort((a, b) => a.t - b.t);
  h += `<h2>${passager() ? 'Moments inconfortables' : 'Moments à revoir'}</h2>`;
  if (!aRevoir.length) h += '<p class="carte">Aucun moment brusque. Bravo !</p>';
  else {
    h += '<ul class="liste">';
    for (const e of aRevoir) {
      const ic = e.crit === 'virage' ? (e.pic > 0 ? 'vd' : 'vg') : e.crit, quoi = e.crit === 'virage' ? e.type : e.crit;
      const ou = arretProche(e);
      h += `<li class="carte">${icone(ic, NOTE_COUL[e.niveau])}<div><b>${quoi[0].toUpperCase() + quoi.slice(1)} ${NIVEAUX[e.niveau]}</b><small>${heureDe(e.t)}${ou ? ' · ' + esc(ou) : ''}</small></div><span class="mesure">${Math.abs(e.pic).toLocaleString('fr-FR')} m/s²<small>${e.kmh} km/h</small></span></li>`;
    }
    h += '</ul>';
  }
  h += '<details class="carte"><summary>Comment est calculé le score</summary><p>Chaque freinage, accélération et virage est noté : 100 s’il est doux, 70 limite, 30 brusque, 0 très brusque. Le score est la moyenne. Le trajet à vide et les moments à l’arrêt ne comptent pas.</p></details>';
  corps.innerHTML = h;
  enregistrerBilan(B);
  montrer('ecranBilan');
}
// qualité de la mesure, à côté du score (docs/INDICATEURS.md, point 3)
function pastilleQualite(q) {
  const v = x => x == null || isNaN(x) ? '–' : x.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const detail = `recalage GPS ${v(q.corr_avant)} · coupures ${q.nb_trous ? `${q.temps_trous_s} s (${Math.round(q.part_trous * 100)} %)` : 'aucune'}`;
  return `<p class="qualite ${q.douteuse ? 'douteuse' : 'fiable'}"><b>${q.douteuse ? 'Mesure douteuse' : 'Mesure fiable'}</b> · ${detail}` +
    (q.douteuse ? `<br>${q.raisons.map(esc).join(' ; ')}. Score à prendre avec prudence.` : '') + '</p>';
}
// ponctualité : écart à l'horaire GTFS à chaque arrêt passé, et inter-arrêts (docs/INDICATEURS.md, point 4)
const ecart = s => { const a = Math.abs(s), txt = a < 60 ? `${a} s` : `${Math.floor(a / 60)} min${a % 60 ? ' ' + String(a % 60).padStart(2, '0') : ''}`; return (s > 0 ? '+' : s < 0 ? '−' : '') + txt; };
const STATUTS = { heure: 'à l’heure', avance: 'en avance', retard: 'en retard' };
function blocPonctualite(liste, courses) {
  let h = '<section class="carte vitesse ponct"><h2>Ponctualité</h2>';
  liste.forEach((r, i) => {
    const titre = liste.length > 1 ? `Course ${courses[i].n} : ` : '';
    if (r.hors_service) { h += `<p class="note" style="margin:0 0 8px">${titre}hors service (${esc(r.raison)}). Pas de ponctualité pour ce trajet.</p>`; return; }
    const c = r.course, p = r.ponctualite, nomLigne = (reseau.lignes.find(l => l.id === c.route_id) || {}).nom_court || c.route_id;
    h += `<p style="margin:0 0 8px">${titre}rattaché à la course ${esc(nomLigne)} → ${esc(c.destination)} de ${heureMin(c.depart_prevu_min)}.</p>`;
    h += `<dl><div><dt>À l’heure</dt><dd>${p.a_l_heure} arrêt${p.a_l_heure > 1 ? 's' : ''}</dd></div>`;
    h += `<div><dt>En avance (> ${p.seuils.avance_s / 60} min)</dt><dd>${p.avance}</dd></div>`;
    h += `<div><dt>En retard (> ${p.seuils.retard_s / 60} min)</dt><dd>${p.retard}</dd></div>`;
    h += `<div><dt>Écart médian</dt><dd>${ecart(p.ecart_median_s)}</dd></div></dl>`;
    h += `<details><summary>Détail par arrêt</summary><table><thead><tr><th>Arrêt</th><th>Prévu</th><th>Réel</th><th>Écart</th></tr></thead><tbody>`;
    for (const a of r.arrets) h += `<tr class="${a.statut}"><td>${esc(a.nom)}</td><td>${heureMin(a.prevu_min)}</td><td>${heureMin(a.reel_s / 60)}</td><td title="${STATUTS[a.statut]}">${ecart(a.ecart_s)}</td></tr>`;
    h += '</tbody></table>';
    const lents = r.inter_arrets.filter(x => x.reel_s - x.prevu_s >= 30).sort((a, b) => (b.reel_s - b.prevu_s) - (a.reel_s - a.prevu_s)).slice(0, 3);
    if (lents.length) {
      h += '<p class="note">Inter-arrêts les plus lents par rapport à l’horaire :</p><ul class="lents">';
      for (const x of lents) h += `<li>${esc(x.de)} → ${esc(x.a)} : ${duree(x.reel_s)} au lieu de ${duree(x.prevu_s)}</li>`;
      h += '</ul>';
    }
    h += '</details>';
  });
  return h + '</section>';
}
// accostage et départ d'arrêt : là où les voyageurs sont debout
function blocArrets(a) {
  let h = '<section class="carte vitesse"><h2>Aux arrêts</h2>';
  if (!a.arrets_desservis) return h + '<p class="note" style="margin:0">Aucun arrêt desservi pendant ce trajet : pas de note d’accostage.</p></section>';
  const ligne = (lab, r) => `<div><dt>${lab}</dt><dd>${r.note ?? '–'}${r.note != null ? '<small>/100</small>' : ''}<span class="det">${r.nb} noté${r.nb > 1 ? 's' : ''}${r.brusques ? ` · ${r.brusques} brusque${r.brusques > 1 ? 's' : ''}` : ''}</span></dd></div>`;
  h += '<dl>' + ligne('Accostages', a.accostage) + ligne('Départs d’arrêt', a.depart) + '</dl>';
  return h + `<p class="note">${a.arrets_desservis} arrêt${a.arrets_desservis > 1 ? 's' : ''} desservi${a.arrets_desservis > 1 ? 's' : ''} · freinages, accélérations et virages à 150 m de l’arrêt.</p></section>`;
}
// vitesse commerciale, vitesse de roulage et temps à l'arrêt (docs/INDICATEURS.md, point 1)
const kmh = x => x == null ? '–' : `${x.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km/h`;
const duree = s => s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ' ' + String(s % 60).padStart(2, '0') + ' s' : ''}`;
const pct = x => `${Math.round(x * 100)} %`;
function blocVitesse(v) {
  let h = '<section class="carte vitesse"><h2>Vitesse et arrêts</h2><dl>';
  h += `<div><dt>Vitesse commerciale</dt><dd>${kmh(v.vitesse_commerciale_kmh)}</dd></div>`;
  h += `<div><dt>Vitesse de roulage</dt><dd>${kmh(v.vitesse_roulage_kmh)}</dd></div>`;
  h += `<div><dt>Distance · durée</dt><dd>${v.km.toLocaleString('fr-FR')} km · ${duree(v.duree_s)}</dd></div>`;
  h += `<div><dt>À l’arrêt</dt><dd>${duree(v.temps_arret_s)} (${pct(v.part_arret)})</dd></div>`;
  h += `<div class="detail"><dt>aux points d’arrêt</dt><dd>${duree(v.temps_arret_aux_arrets_s)} · ${v.nb_arrets_aux_arrets} arrêt${v.nb_arrets_aux_arrets > 1 ? 's' : ''}</dd></div>`;
  h += `<div class="detail"><dt>ailleurs (feux, congestion)</dt><dd>${duree(v.temps_arret_ailleurs_s)} · ${v.nb_arrets_ailleurs} arrêt${v.nb_arrets_ailleurs > 1 ? 's' : ''}</dd></div>`;
  // vitesse max : seulement si l'exploitant l'a activée (option vitesse_pics), et pour le conducteur lui-même
  if (v.vitesse_max_kmh != null && !passager()) h += `<div><dt>Vitesse max</dt><dd>${v.vitesse_max_kmh} km/h</dd></div>`;
  h += '</dl>';
  if (v.temps_coupures_s > 0) h += `<p class="note">Enregistrement interrompu ${duree(v.temps_coupures_s)} : distance un peu sous-estimée.</p>`;
  return h + '</section>';
}
function enregistrerBilan(B) {
  E.bilan = B.erreur ? { erreur: B.erreur } : { score: B.score, sous: B.sous, vitesse: B.vitesse || null, arrets: B.aux || null, qualite: B.qualite || null, ponctualite: B.ponct || null, courses: B.courses.map(({ n, t_debut, t_fin, score, destination }) => ({ n, t_debut, t_fin, score, destination })) };
  sauver().catch(() => {});
}

// ---------- sauvegarde dans le téléphone ----------
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return rej(new Error('indisponible'));
    const r = indexedDB.open('kind-conducteur', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('services', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }).catch(e => { dbP = null; throw e; });
  return dbP;
}
async function sauver() {
  if (!E.id || E.demo === undefined) return;
  const d = await db();
  const rec = { id: E.id, debut: E.debut.toISOString(), role: E.role, campagne: E.campagne || null,
    conducteur: passager() ? null : E.conducteur, sens: E.ligne ? E.ligne.sens[E.sensIdx].direction : null, vehicule: E.vehicule, profil: E.profil, mode: E.mode,
    ligne: E.ligne ? { id: E.ligne.id, nom_court: E.ligne.nom_court } : null, courses: E.courses, termine: E.termine,
    ressenti: E.ressenti, bilan: E.bilan || null, simulation: !!E.simulation, csv: csvService() };
  return new Promise((res, rej) => { const tx = d.transaction('services', 'readwrite'); tx.objectStore('services').put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && (E.mesure || E.demo)) sauver().catch(() => {}); });

async function partager() {
  const name = `kind-${passager() ? 'passager' : 'service'}-${E.debut.toISOString().slice(0, 16).replace(/[:T]/g, '-')}${E.mode === 'test' ? '-test' : ''}.csv`;
  const file = new File([csvService()], name, { type: 'text/csv' });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; } }
  catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(file), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- démo : un bus simulé parcourt la ligne choisie ----------
function genererDemo() {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const l = E.ligne || reseau.lignes.find(x => x.id === '01'), sens = l.sens[E.sensIdx];
  // conducteur : départ du dépôt, ~400 m avant le premier arrêt ; passager : monte au 4e arrêt
  const premier = passager() && E.ligne ? 3 : 0;
  const pts = sens.arrets.slice(premier, 12).map(a => ({ lat: a.lat, lon: a.lon }));
  // calée sur une vraie course du jour si possible : le bus attend l'heure prévue à chaque arrêt, avec un peu de retard
  const h = courseDuJourPourDemo(l, sens);
  let base = null, retard = 10;
  const p0 = pts[0], dep = passager() ? { ...p0 } : { lat: p0.lat - 0.0025, lon: p0.lon - 0.003 };
  const etapes = [dep, ...pts], rows = [], th = 30 * Math.PI / 180, FS = 5, dt = 1 / FS;
  let t = 0, v = 0, a = 0, pos = { ...dep };
  const pousser = (L, Lt, jerk) => {
    const h1 = Math.cos(th) * L - Math.sin(th) * Lt + (rnd() - 0.5) * 0.08, h2 = Math.sin(th) * L + Math.cos(th) * Lt + (rnd() - 0.5) * 0.08;
    rows.push({ t, lat: pos.lat, lon: pos.lon, v, h1, h2, L, Lt, jerk }); t += dt;
  };
  for (let k = 0; k < 15; k++) pousser(0, 0, 0);   // calibrage à l'arrêt
  for (let s = 1; s < etapes.length; s++) {
    const A = pos, B = etapes[s], d = distM(A, B);
    const accMax = 0.8 + rnd() * 1.6, frein = 0.8 + rnd() * 2.2, vmax = 9 + rnd() * 5, jmax = 1 + rnd() * 4;
    const virage = rnd() < 0.4 ? (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 2.2) : 0;
    let fait = 0;
    while (d >= 5 && fait < d - 0.5) {
      const reste = d - fait, cible = v * v / (2 * frein) >= reste - 2 ? -frein : v < vmax ? accMax : 0;
      const aPrec = a; a += Math.max(-jmax * dt, Math.min(jmax * dt, cible - a));
      v = Math.max(0, v + a * dt); if (v === 0 && a < 0) a = 0;
      if (v === 0 && reste < 3) break;   // arrivé à l'arrêt (évite de rester bloqué à quelques mètres)
      fait += v * dt; const f = Math.min(1, fait / d);
      pos = { lat: A.lat + (B.lat - A.lat) * f, lon: A.lon + (B.lon - A.lon) * f };
      const Lt = virage * Math.sin(Math.PI * f) * Math.min(1, v / 8);
      pousser(a, Lt, Math.abs(a - aPrec) / dt);
      if (rows.length > 20000) break;
    }
    v = 0; a = 0;
    let fin = t + 4;   // arrêt de 4 s au moins
    if (h) {
      const k = premier + s - 1;
      if (base == null) base = h[k] * 60 + retard - (t + 8);   // l'heure de la démo est calée sur le premier arrêt
      retard = Math.max(-40, retard + (rnd() - 0.35) * 50);   // le retard dérive un peu d'un arrêt à l'autre
      fin = Math.max(fin, h[k] * 60 + retard - base);
    }
    while (t < fin) pousser(0, 0, 0);
  }
  return { rows, base, depart: h ? h[premier] : null };
}
// course GTFS du jour, de cette ligne et de ce sens, avec le même parcours, la plus proche de l'heure actuelle
function courseDuJourPourDemo(l, sens) {
  if (!horaires) return null;
  const ids = sens.arrets.map(a => a.id).join('|'), actifs = servicesDuJour(horaires, new Date());
  const maintenant = new Date().getHours() * 60 + new Date().getMinutes();
  let best = null;
  for (const c of horaires.courses) {
    if (c[1] !== l.id || c[2] !== sens.direction || !actifs.has(c[3]) || horaires.motifs[c[4]].join('|') !== ids) continue;
    if (!best || Math.abs(c[6][0] - maintenant) < Math.abs(best[0] - maintenant)) best = c[6];
  }
  return best;
}
function lancerDemo() {
  E.simulation = true;
  const { rows, base, depart } = genererDemo(); let i = 0;
  if (base != null) { const d = new Date(); d.setHours(0, 0, 0, 0); E.debut = new Date(d.getTime() + base * 1000); }
  $('statut').textContent = depart != null ? `Démo calée sur la course de ${heureMin(depart)}, accélérée ×10` : 'Démo : bus simulé, accéléré ×10';
  const parTick = new URLSearchParams(location.search).has('rapide') ? 400 : 5;   // ?rapide : pour les tests
  E.demo = setInterval(() => {
    for (let k = 0; k < parTick; k++) {
      if (i >= rows.length) { $('statut').textContent = 'Fin de la démo'; finService(); return; }
      const r = rows[i++], gps = { lat: r.lat, lon: r.lon, speed: r.v };
      surEchantillon({ t: r.t, lon: r.L, lat: r.Lt, mag: Math.hypot(r.L, r.Lt), jerk: r.jerk, known: true, speed: r.v, gps });
      E.log.push([r.t.toFixed(1), r.lat.toFixed(6), r.lon.toFixed(6), (r.v * 3.6).toFixed(1), r.h1.toFixed(2), r.h2.toFixed(2), r.L.toFixed(2), r.Lt.toFixed(2), r.jerk.toFixed(2), E.lvl]);
    }
  }, 100);
}

// ---------- démarrage ----------
async function init() {
  initIdentification(); initRessenti();
  $('courseBtn').addEventListener('click', () => E.enCourse ? finCourse(E.tDernier, false) : debutCourse(E.tDernier, false));
  $('finService').addEventListener('click', () => { if (confirm(passager() ? 'Arrêter la mesure de votre trajet ?' : 'Arrêter l’enregistrement et voir le bilan ?')) finService(); });
  $('recommencer').addEventListener('click', recommencer);
  $('partager').addEventListener('click', partager);
  $('nouveau').addEventListener('click', () => montrer('ecranService'));
  $('menuBilan').addEventListener('click', () => montrer('ecranId'));
  fetch('horaires-imagine.json').then(r => r.json()).then(h => { horaires = h; }).catch(() => { /* pas de ponctualité hors ligne */ });
  try { reseau = await (await fetch('reseau-imagine.json')).json(); initService(); }
  catch (e) { erreur('erreurId', 'Impossible de charger les lignes du réseau. Vérifiez la connexion puis rechargez la page.'); }
}
init();
