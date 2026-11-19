// Accès à Supabase pour l'appli conducteur et le tableau de bord.
// Le client est chargé à la demande : sans réseau, l'appli continue de fonctionner (les trajets attendent).
import { SUPABASE_URL, SUPABASE_CLE_PUBLIQUE, RESEAU } from './supabase-config.js';

let clientP = null;
export function client() {
  if (!clientP) clientP = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm')
    .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_CLE_PUBLIQUE, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kind-auth' } }))
    .catch(e => { clientP = null; throw e; });
  return clientP;
}

// Les conducteurs ont un compte Supabase dont l'adresse est fictive : leur code suivi de ce domaine réservé.
export const emailConducteur = code => `${code.trim().toLowerCase()}@conducteurs.example.com`;
export const estErreurReseau = e => !navigator.onLine || /fetch|network|réseau|load failed/i.test(String(e && (e.message || e)));

export async function utilisateur() {
  const sb = await client();
  const { data } = await sb.auth.getSession();
  return data.session ? data.session.user : null;
}

// conducteur : code + PIN (6 chiffres). Vérifie que le compte a bien le rôle conducteur avec ce code.
export async function connecterConducteur(code, pin) {
  const sb = await client();
  const { data, error } = await sb.auth.signInWithPassword({ email: emailConducteur(code), password: pin });
  if (error) throw error;
  const { data: p, error: e2 } = await sb.from('profils').select('role, code_conducteur, reseau_id').eq('user_id', data.user.id).maybeSingle();
  if (e2) throw e2;
  if (!p || p.role !== 'conducteur' || p.code_conducteur.toLowerCase() !== code.trim().toLowerCase()) {
    await sb.auth.signOut();
    throw new Error('Ce compte n’est pas enregistré comme conducteur.');
  }
  return { uid: data.user.id, code: p.code_conducteur, reseau: p.reseau_id };
}

// passager : connexion anonyme (pas de compte) ; réutilise la session anonyme du téléphone s'il y en a une
export async function connecterPassager() {
  const sb = await client();
  const u = await utilisateur();
  if (u && u.is_anonymous) return u.id;
  if (u) await sb.auth.signOut();
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.user.id;
}

// responsable / autorité organisatrice : e-mail + mot de passe
export async function connecterResponsable(email, motDePasse) {
  const sb = await client();
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password: motDePasse });
  if (error) throw error;
  const { data: p } = await sb.from('profils').select('role, reseau_id').eq('user_id', data.user.id).maybeSingle();
  if (!p || !['responsable', 'ao'].includes(p.role)) { await sb.auth.signOut(); throw new Error('Ce compte n’a pas accès au tableau de bord.'); }
  return { uid: data.user.id, role: p.role, reseau: p.reseau_id, email: data.user.email };
}

async function gzip(texte) {
  if (!('CompressionStream' in window)) return { corps: new Blob([texte], { type: 'text/csv' }), ext: 'csv' };
  const flux = new Blob([texte]).stream().pipeThrough(new CompressionStream('gzip'));
  return { corps: await new Response(flux).blob(), ext: 'csv.gz' };
}

// Envoie un trajet terminé (enregistrement IndexedDB de l'appli) : ligne « trajets », courses, événements,
// puis le CSV brut compressé dans le stockage privé. Renvoyer deux fois met à jour sans doublon.
export async function envoyerTrajet(rec) {
  const sb = await client();
  const u = await utilisateur();
  if (!u || u.id !== rec.auteur) throw new Error('pas connecté avec le compte de ce trajet');
  const b = rec.bilan || {};
  const ligne = {
    reseau_id: RESEAU, id_local: rec.id, role: rec.role, code_conducteur: rec.role === 'conducteur' ? rec.conducteur : null,
    mode: rec.mode, ligne_id: rec.ligne ? rec.ligne.id : null, sens: rec.sens, vehicule: rec.vehicule || null, profil: rec.profil,
    campagne: rec.campagne || null, simulation: !!rec.simulation, debut: rec.debut, fin: rec.fin || null,
    score: b.score ?? null, sous_notes: b.sous || null, ressenti: rec.ressenti, vitesse: b.vitesse || null, aux_arrets: b.arrets || null,
    qualite: b.qualite || null, ponctualite: b.ponctualite || null, ralentissements: b.ralentissements || null,
  };
  const { data: t, error } = await sb.from('trajets').upsert(ligne, { onConflict: 'auteur,id_local' }).select('id').single();
  if (error) throw error;
  // courses et événements : remplacés en bloc
  await sb.from('courses').delete().eq('trajet_id', t.id);
  await sb.from('evenements').delete().eq('trajet_id', t.id);
  const ponct = b.ponctualite || [];
  const courses = (b.courses || []).map((c, i) => ({ trajet_id: t.id, n: c.n, t_debut: c.t_debut, t_fin: c.t_fin, sens: c.direction ?? null,
    destination: c.destination || null, score: c.score ?? null, trip_id: ponct[i] && !ponct[i].hors_service ? ponct[i].course.trip_id : null }));
  if (courses.length) { const { error: e } = await sb.from('courses').insert(courses); if (e) throw e; }
  const evts = (b.evenements || []).map(e => ({ trajet_id: t.id, course_n: e.course_n ?? null, critere: e.critere, type: e.type || null,
    niveau: e.niveau, t: e.t, pic: e.pic, kmh: e.kmh, lat: e.lat, lon: e.lon }));
  if (evts.length) { const { error: e } = await sb.from('evenements').insert(evts); if (e) throw e; }
  // données brutes
  if (rec.csv) {
    const { corps, ext } = await gzip(rec.csv), chemin = `${u.id}/${rec.id}.${ext}`;
    const { error: e } = await sb.storage.from('trajets-bruts').upload(chemin, corps, { contentType: ext === 'csv' ? 'text/csv' : 'application/gzip', upsert: false });
    if (e && !/exists|duplicate/i.test(e.message)) throw e;
    await sb.from('trajets').update({ fichier_brut: chemin }).eq('id', t.id);
  }
  return t.id;
}
