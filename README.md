# Plaques de Paris

Webapp mobile pour découvrir les personnalités des plaques commémoratives de Paris (données : opendata.paris.fr).

- `web/` : site statique (Google Maps), déployé sur GitHub Pages à chaque push sur `main`
- `scripts/build-data.mjs` : génère `web/data/plaques.json` (liens Wikipédia/Wikidata vérifiés)
- `tests/` : validation des données + tests Playwright (iPhone 13)

Développement local : `python3 -m http.server -d web 8080`
