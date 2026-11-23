# Plaques de Paris — contrat d'équipe

Webapp **mobile** : carte Google Maps des plaques commémoratives de Paris.
Clic sur un point → nom de la personne/objet + lien vers une page web qui l'explique.

## Source
API Ville de Paris (2619 plaques) :
- Export complet : https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/plaques_commemoratives/exports/json
- Champs utiles : index_plaque, titre, personnalite, retranscription, adresse, ardt, siecle, objet_1, geo_point_2d {lat, lon}

## Arborescence (chacun ne touche QUE ses dossiers)
- `scripts/` + `data/`  → agent **data** (workspace `plaques-data`)
- `web/`                → agent **frontend** (workspace `plaques-ui`)
- `tests/`              → agent **qa** (workspace `plaques-qa`)
- Racine (CONTRAT.md, README) → chef uniquement

## Format de données : `web/data/plaques.json` (produit par l'agent data, via `node scripts/build-data.mjs`)
Tableau JSON d'objets :
```json
{
  "id": 7131,
  "nom": "Robert Garric",          // personnalite, sinon titre
  "titre": "Robert Garric",
  "texte": "ROBERT GARRIC/FONDATEUR/...",  // retranscription
  "adresse": "28 AVENUE BOSQUET, 75007",
  "lat": 48.857492, "lon": 2.303494,
  "categorie": "les écrivains et intellectuels",  // objet_1 ou null
  "lien": "https://fr.wikipedia.org/wiki/Robert_Garric",  // page vérifiée existante, ou null
  "lienType": "wikipedia" | "wikidata" | "aucun"
}
```
- Exclure les plaques sans coordonnées.
- `lien` : chercher l'article Wikipédia FR (API https://fr.wikipedia.org/w/api.php, action=query&list=search, ou opensearch), throttle poli (≤ 5 req/s, User-Agent générique "plaques-paris-demo/1.0"), cache dans `data/wiki-cache.json` pour pouvoir relancer. Chaque lien doit pointer vers une page qui existe vraiment (vérifiée, pas d'homonymie, jamais de lien de recherche). Ordre : article Wikipédia FR → fiche Wikidata → `lien: null`, `lienType: "aucun"` (l'UI affiche « Pas de page trouvée »).

## Frontend
- Pur statique (HTML/CSS/JS, pas de build), servi par `npx serve web` ou `python3 -m http.server -d web 8080`.
- Google Maps JS API, clé dans `web/config.js` : `window.GOOGLE_MAPS_API_KEY = "";` (vide par défaut → afficher un message clair au lieu de planter).
- MarkerClusterer (@googlemaps/markerclusterer depuis unpkg/jsdelivr, version figée).
- Clic marqueur → panneau / InfoWindow : nom (gros), adresse, texte de la plaque, bouton « En savoir plus » → `lien` (target _blank).
- Mobile first : plein écran, viewport correct, boutons ≥ 44px, bouton « me localiser », barre de recherche par nom (bonus).

## QA
- Tests dans `tests/` : validation du JSON (schéma, coords dans Paris 48.80–48.91 / 2.22–2.47, liens https), et tests navigateur Playwright (viewport iPhone) sur le site servi.
- Signaler les bugs directement à l'agent concerné via `cmux agent message <workspace> "..."`.

## Communication
- Messages entre agents : `cmux agent message <workspace> "texte"` ; répondre avec `--reply-to <id>`.
- Quand vous avez fini votre partie : envoyer un message au chef (workspace `plaques-chef`) avec un résumé.
- Ne jamais taper dans le terminal d'un autre agent.
