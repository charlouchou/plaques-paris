#!/usr/bin/env node
/**
 * build-data.mjs — produit web/data/plaques.json (format défini dans CONTRAT.md).
 *
 * Usage :
 *   node scripts/build-data.mjs             # télécharge l'export, cherche les liens Wikipédia FR
 *   node scripts/build-data.mjs --offline   # réutilise data/export-raw.json (pas de téléchargement)
 *   node scripts/build-data.mjs --no-wiki   # pas de requêtes Wikipédia : tous les liens = recherche
 *
 * Résolution Wikipédia en deux temps (limite poli : ≤ 1 requête/s, Retry-After respecté) :
 *   1. action=query&titles=… (50 noms par requête) : articles qui portent exactement ce nom ;
 *   2. list=search (une requête par nom) uniquement pour les noms restants.
 * Caches : data/wiki-cache.json (relançable sans tout refaire).
 *
 * Sans dépendance (Node >= 18, fetch natif).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_PATH = path.join(ROOT, 'web', 'data', 'plaques.json');
const RAW_PATH = path.join(DATA_DIR, 'export-raw.json');
const CACHE_PATH = path.join(DATA_DIR, 'wiki-cache.json');

const EXPORT_URL =
  'https://opendata.paris.fr/api/explore/v2.1/catalog/datasets/plaques_commemoratives/exports/json';
const WIKI_API = 'https://fr.wikipedia.org/w/api.php';
const WIKI_ARTICLE = 'https://fr.wikipedia.org/wiki/';
const WIKI_SEARCH = 'https://fr.wikipedia.org/w/index.php?search=';
const USER_AGENT = 'plaques-paris-demo/1.0 (https://opendata.paris.fr)';
const MIN_INTERVAL_MS = 1000; // ≤ 1 requête/s vers Wikipédia
const TITLES_PER_REQUEST = 50;
const CACHE_SAVE_EVERY = 25;
const DUP_ID_STEP = 100000; // id des doublons d'index_plaque : index + k * 100000

const ARGS = new Set(process.argv.slice(2));
const OFFLINE = ARGS.has('--offline');
const NO_WIKI = ARGS.has('--no-wiki');

const log = (...a) => console.error('[build-data]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- export

async function loadExport() {
  if (OFFLINE) {
    log(`lecture locale ${path.relative(ROOT, RAW_PATH)}`);
    return JSON.parse(await readFile(RAW_PATH, 'utf8'));
  }
  log(`téléchargement de l'export…`);
  const res = await fetch(EXPORT_URL, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`export HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('export inattendu : pas un tableau JSON');
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(RAW_PATH, text);
  return data;
}

// ---------------------------------------------------------------- normalisation

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
};

/** Adresse + code postal : "28 AVENUE BOSQUET" + ardt 7 → "28 AVENUE BOSQUET, 75007". */
function formatAdresse(adresse, ardt) {
  const a = clean(adresse);
  const n = Number(ardt);
  if (!a) return null;
  if (!Number.isInteger(n) || n < 1 || n > 20) return a;
  return `${a}, ${75000 + n}`;
}

/** Nom affiché : personnalite, sinon titre, sinon premier segment de la retranscription. */
function displayName(row) {
  const pers = clean(row.personnalite);
  if (pers) return pers;
  const titre = clean(row.titre);
  if (titre) return titre;
  const segs = (row.retranscription || '')
    .split('/')
    .map(clean)
    .filter(Boolean);
  const twoWords = segs.find((s) => s.split(' ').length >= 2 && s.length <= 80);
  const fallback = twoWords || segs[0];
  if (fallback) return fallback.length > 80 ? fallback.slice(0, 77) + '…' : fallback;
  return `Plaque n° ${row.index_plaque}`;
}

function coords(row) {
  const g = row.geo_point_2d;
  const lat = Number(g?.lat ?? row.y_4326);
  const lon = Number(g?.lon ?? row.x_4326);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
}

/** Noms à essayer dans l'ordre : premier nom de la personnalité, puis le titre. */
function candidatesFor(row, name) {
  const out = [];
  const pers = clean(row.personnalite);
  if (pers) out.push(pers.split(',')[0].trim());
  const titre = clean(row.titre);
  if (titre) out.push(titre);
  if (out.length === 0) out.push(name);
  return [...new Set(out.filter((c) => c && c.length >= 3))];
}

// ---------------------------------------------------------------- correspondance

const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'd', 'l', 'en', 'a', 'au', 'aux', 'sur', 'sous', 'un', 'une']);

/** Minuscules, sans accents ni ponctuation : "Camille Saint-Saëns" → "camille saint saens". */
function fold(s) {
  return String(s)
    .replace(/œ/gi, 'oe')
    .replace(/æ/gi, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const stripParens = (t) => t.replace(/\s*\([^)]*\)\s*$/, '');

/**
 * Le titre d'article correspond-il raisonnablement au nom ?
 * - égalité après suppression de la parenthèse de désambiguïsation ("Jean X (résistant)") ;
 * - ou, pour un nom d'au moins 2 mots significatifs, tous ses mots présents dans le titre.
 */
function titleMatches(candidate, title) {
  const c = fold(candidate);
  const t = fold(stripParens(title));
  if (!c || !t) return false;
  if (c === t) return true;
  const full = fold(title);
  if (full.startsWith('liste ') || full.includes('homonymie')) return false;
  const cTok = c.split(' ').filter((w) => w && !STOP.has(w));
  if (cTok.length < 2) return false;
  const tSet = new Set(full.split(' '));
  return cTok.every((w) => tSet.has(w));
}

// ---------------------------------------------------------------- Wikipédia

const articleUrl = (title) => WIKI_ARTICLE + encodeURIComponent(title.replace(/ /g, '_'));
const searchUrl = (name) => WIKI_SEARCH + encodeURIComponent(name);

let lastWikiCall = 0;
async function throttle() {
  const wait = lastWikiCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastWikiCall = Date.now();
}

/**
 * Appel GET à l'API avec throttle, Retry-After et réessais.
 * Lève une erreur (rateLimited=true si 429 persistant).
 */
async function wikiGet(params) {
  const url = `${WIKI_API}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await throttle();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        lastErr.rateLimited = res.status === 429;
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, 5000 * attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) {
        lastErr = new Error(`API ${json.error.code}`);
        await sleep(5000 * attempt); // ex. maxlag
        continue;
      }
      return json;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

class WikiResolver {
  constructor(cache) {
    this.cache = cache; // { titles: { [nom]: {...} }, search: { [requête]: {...} } }
    this.dirty = 0;
    this.stats = { titleBatches: 0, searchRequests: 0, cacheHitsSearch: 0, failures: 0, skipped: 0 };
    this.rateLimitStreak = 0;
    this.tripped = false;
    this.memo = new Map(); // nom → { lien, lienType }
  }

  async save() {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    await writeFile(tmp, JSON.stringify(this.cache, null, 1));
    await rename(tmp, CACHE_PATH);
    this.dirty = 0;
  }

  noteFailure(e, what) {
    this.stats.failures++;
    log(`échec Wikipédia (${what}) : ${e.message}`);
    if (e.rateLimited && ++this.rateLimitStreak >= 3) {
      this.tripped = true;
      log('Wikipédia limite les requêtes : arrêt des requêtes pour ce run, relancer plus tard pour compléter');
    }
  }

  /**
   * Étape 1 : vérifie par lots de 50 si des articles portent exactement ces noms.
   * Résultat mis en cache : titles[nom] = { page, viaRedirect, disambig, missing }.
   */
  async batchTitles(names) {
    const todo = names.filter((n) => !(n in this.cache.titles));
    log(`vérification groupée : ${todo.length} noms à interroger (${Math.ceil(todo.length / TITLES_PER_REQUEST)} requêtes)`);
    for (let i = 0; i < todo.length; i += TITLES_PER_REQUEST) {
      if (this.tripped) { this.stats.skipped += todo.length - i; break; }
      const chunk = todo.slice(i, i + TITLES_PER_REQUEST);
      try {
        const json = await wikiGet({
          action: 'query',
          titles: chunk.join('|'),
          redirects: '1',
          prop: 'pageprops',
          ppprop: 'disambiguation',
        });
        this.stats.titleBatches++;
        this.rateLimitStreak = 0;
        const pages = new Map((json.query?.pages ?? []).map((p) => [p.title, p]));
        const norm = new Map((json.query?.normalized ?? []).map((r) => [r.from, r.to]));
        const redir = new Map((json.query?.redirects ?? []).map((r) => [r.from, r.to]));
        for (const name of chunk) {
          let t = norm.get(name) ?? name;
          let viaRedirect = false;
          if (redir.has(t)) { t = redir.get(t); viaRedirect = true; }
          const p = pages.get(t);
          this.cache.titles[name] = p && !p.missing
            ? { page: p.title, viaRedirect, disambig: Boolean(p.pageprops && 'disambiguation' in p.pageprops), at: new Date().toISOString() }
            : { page: null, at: new Date().toISOString() };
        }
        await this.save();
      } catch (e) {
        this.noteFailure(e, 'titres groupés');
      }
    }
  }

  /** Article accepté pour ce nom à partir du lot (sans requête supplémentaire). */
  fromBatch(name) {
    const r = this.cache.titles[name];
    if (!r || !r.page || r.disambig) return null;
    if (r.viaRedirect) return r.page; // redirection depuis ce nom exact
    return titleMatches(name, r.page) ? r.page : null;
  }

  /** Étape 2 : recherche individuelle (uniquement pour les noms non trouvés). */
  async search(query) {
    if (this.cache.search[query]) {
      this.stats.cacheHitsSearch++;
      return this.cache.search[query];
    }
    if (this.tripped) { this.stats.skipped++; return null; }
    this.stats.searchRequests++;
    try {
      const json = await wikiGet({
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrnamespace: '0',
        gsrlimit: '5',
        redirects: '1',
        prop: 'pageprops',
        ppprop: 'disambiguation',
      });
      const pages = (json.query?.pages ?? [])
        .filter((p) => p && p.title && !p.missing)
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((p) => ({ title: p.title, disambig: Boolean(p.pageprops && 'disambiguation' in p.pageprops) }));
      const redirects = (json.query?.redirects ?? []).map((r) => ({ from: r.from, to: r.to }));
      this.cache.search[query] = { pages, redirects, at: new Date().toISOString() };
      this.rateLimitStreak = 0;
      if (++this.dirty >= CACHE_SAVE_EVERY) await this.save();
      return this.cache.search[query];
    } catch (e) {
      this.noteFailure(e, `recherche « ${query} »`);
      return null;
    }
  }

  fromSearch(candidate, entry) {
    const ok = entry.pages.filter((p) => {
      if (p.disambig) return false;
      if (titleMatches(candidate, p.title)) return true;
      return entry.redirects.some((r) => r.to === p.title && fold(r.from) === fold(candidate));
    });
    if (ok.length === 0) return null;
    const exact = ok.find((p) => fold(p.title) === fold(candidate));
    return (exact ?? ok[0]).title;
  }

  /** Lien final pour une plaque : lot d'abord, puis recherche pour les noms restants. */
  async resolve(row, name) {
    if (this.memo.has(name)) return this.memo.get(name);
    let result = { lien: searchUrl(name), lienType: 'recherche' };
    if (!NO_WIKI) {
      const cands = candidatesFor(row, name);
      let title = null;
      for (const c of cands) {
        title = this.fromBatch(c);
        if (title) break;
      }
      if (!title) {
        for (const c of cands) {
          const entry = await this.search(c);
          if (!entry) continue;
          title = this.fromSearch(c, entry);
          if (title) break;
        }
      }
      if (title) result = { lien: articleUrl(title), lienType: 'wikipedia' };
    }
    this.memo.set(name, result);
    return result;
  }
}

// ---------------------------------------------------------------- main

async function loadCache() {
  const empty = { titles: {}, search: {} };
  if (NO_WIKI) return empty;
  try {
    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    const cache = { titles: raw.titles ?? {}, search: raw.search ?? {} };
    // ancien format : recherches stockées à plat
    for (const [k, v] of Object.entries(raw)) if (k !== 'titles' && k !== 'search') cache.search[k] = v;
    log(`cache Wikipédia : ${Object.keys(cache.titles).length} noms vérifiés, ${Object.keys(cache.search).length} recherches`);
    return cache;
  } catch {
    log('cache Wikipédia absent, il sera créé');
    return empty;
  }
}

async function main() {
  const raw = await loadExport();
  log(`${raw.length} lignes dans l'export`);

  const wiki = new WikiResolver(await loadCache());

  // lignes utiles + ids uniques
  const seenIds = new Map();
  const stats = { exported: raw.length, sansCoords: 0, idsDupliques: 0 };
  const rows = [];
  for (const row of raw) {
    const c = coords(row);
    if (!c) {
      stats.sansCoords++;
      continue;
    }
    const base = Number(row.index_plaque);
    const k = seenIds.get(base) ?? 0;
    seenIds.set(base, k + 1);
    if (k > 0) stats.idsDupliques++;
    rows.push({ row, c, id: k > 0 ? base + k * DUP_ID_STEP : base, nom: displayName(row) });
  }

  // étape 1 : vérification groupée de tous les noms candidats
  if (!NO_WIKI) {
    const names = [...new Set(rows.flatMap((r) => candidatesFor(r.row, r.nom)))];
    await wiki.batchTitles(names);
  }

  // étape 2 + assemblage
  const entries = [];
  for (const { row, c, id, nom } of rows) {
    const { lien, lienType } = await wiki.resolve(row, nom);
    if (entries.length % 200 === 0) log(`${entries.length} plaques traitées…`);
    entries.push({
      id,
      nom,
      titre: clean(row.titre) ?? nom,
      texte: clean(row.retranscription),
      adresse: formatAdresse(row.adresse, row.ardt),
      lat: c.lat,
      lon: c.lon,
      categorie: clean(row.objet_1),
      lien,
      lienType,
    });
  }

  if (!NO_WIKI) await wiki.save();

  // contrôles
  const uniq = new Set(entries.map((e) => e.id)).size;
  if (uniq !== entries.length) throw new Error('ids non uniques après traitement');
  if (entries.length === 0) throw new Error('aucune entrée produite');

  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(entries));

  const nWiki = entries.filter((e) => e.lienType === 'wikipedia').length;
  const report = {
    ecrit: path.relative(ROOT, OUT_PATH),
    entrees: entries.length,
    ...stats,
    wikipedia: nWiki,
    recherche: entries.length - nWiki,
    pctWikipedia: Math.round((1000 * nWiki) / entries.length) / 10,
    requetesWiki: wiki.stats,
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('[build-data] ERREUR :', e.stack || e.message);
  process.exit(1);
});
