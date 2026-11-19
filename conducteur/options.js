// Réglages de l'exploitant (docs/INDICATEURS.md). En prototype, ils sont fixés ici ;
// plus tard, ils viendront de Supabase, réglés par un administrateur.
//
// vitesse_pics : 'off' (défaut) | 'conducteur' | 'troncons' | 'nominatif'
//   off        : rien n'est calculé ni stocké au-delà de la vitesse moyenne
//   conducteur : le conducteur voit ses propres pics ; l'exploitation ne les voit pas
//   troncons   : l'exploitation voit les pics agrégés par tronçon, arrêt, ligne, sans nom (≥ 5 trajets)
//   nominatif  : non proposé en France (CNIL : la géolocalisation des véhicules de salariés
//                ne peut pas servir à contrôler le respect des limitations de vitesse)
import { VITESSE_PICS } from '../outils/analyse-csv.js';

const EXPLOITANT = {
  pays: 'FR',
  vitesse_pics: 'off',
};

export function lireOptions() {
  const o = { ...EXPLOITANT };
  // pour les tests et démonstrations : ?vitesse_pics=conducteur dans l'adresse (off ou conducteur seulement)
  try {
    const p = new URLSearchParams(location.search).get('vitesse_pics');
    if (p === 'off' || p === 'conducteur') o.vitesse_pics = p;
  } catch (e) { /* adresse illisible : réglage de l'exploitant */ }
  if (!VITESSE_PICS.includes(o.vitesse_pics)) o.vitesse_pics = 'off';
  if (o.vitesse_pics === 'nominatif' && o.pays === 'FR') {
    console.warn('vitesse_pics = nominatif n’est pas proposé en France : option désactivée.');
    o.vitesse_pics = 'off';
  }
  return o;
}
