#!/usr/bin/env node
// Validation de web/data/plaques.json selon le contrat (CONTRAT.md).
// Sans dépendance. Usage : node tests/validate-data.mjs [chemin/vers/plaques.json]
// Code de sortie 0 = OK, 1 = erreurs de validation, 2 = fichier illisible.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(here, "..", "web", "data", "plaques.json");
const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const file = resolve(fileArg ?? DEFAULT_PATH);

// Bornes de Paris (CONTRAT.md)
const LAT_MIN = 48.8, LAT_MAX = 48.91;
const LON_MIN = 2.22, LON_MAX = 2.47;

const LIEN_TYPES = new Set(["wikipedia", "recherche", "wikidata"]); // wikidata ajouté par le frontend (non prévu au contrat)
const REQUIRED_KEYS = ["id", "nom", "titre", "texte", "adresse", "lat", "lon", "categorie", "lien", "lienType"];

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

// ---------- Lecture ----------
if (!existsSync(file)) {
  console.error(`ECHEC : fichier introuvable : ${file}`);
  console.error("  (l'agent data doit produire web/data/plaques.json via node scripts/build-data.mjs)");
  process.exit(2);
}

let data;
try {
  data = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`ECHEC : JSON invalide dans ${file} : ${e.message}`);
  process.exit(2);
}

if (!Array.isArray(data)) {
  console.error("ECHEC : la racine du JSON doit être un tableau.");
  process.exit(2);
}

// ---------- Validation par entrée ----------
const isNonEmptyString = (v) => typeof v === "string" && v.trim().length > 0;
const isHttps = (v) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
const inParis = (lat, lon) =>
  lat >= LAT_MIN && lat <= LAT_MAX && lon >= LON_MIN && lon <= LON_MAX;

const seenIds = new Map(); // id -> index
let missingCoords = 0;
let nullTitre = 0;
let nullAdresse = 0;

data.forEach((p, i) => {
  const tag = `entrée #${i} (id=${p?.id ?? "?"})`;

  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    err(`${tag} : n'est pas un objet`);
    return;
  }

  // Schéma : clés présentes
  for (const k of REQUIRED_KEYS) {
    if (!(k in p)) err(`${tag} : champ manquant « ${k} »`);
  }

  // id unique entier
  if (!Number.isInteger(p.id)) {
    err(`${tag} : « id » doit être un entier`);
  } else if (seenIds.has(p.id)) {
    err(`${tag} : id dupliqué (déjà vu à l'index ${seenIds.get(p.id)})`);
  } else {
    seenIds.set(p.id, i);
  }

  // Nom : obligatoire (personnalite, sinon titre). Titre / adresse : string ou null
  // (le contrat ne précise pas qu'ils sont obligatoires ; comptés en statistiques).
  if (!isNonEmptyString(p.nom)) err(`${tag} : « nom » vide ou absent`);
  if (p.titre !== null && typeof p.titre !== "string") err(`${tag} : « titre » doit être une chaîne ou null`);
  if (p.titre === null || (typeof p.titre === "string" && !p.titre.trim())) nullTitre++;

  // Coordonnées
  if (typeof p.lat !== "number" || typeof p.lon !== "number" || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) {
    missingCoords++;
    err(`${tag} : coordonnées absentes ou non numériques (lat=${p.lat}, lon=${p.lon}) — ces entrées doivent être exclues`);
  } else if (!inParis(p.lat, p.lon)) {
    err(`${tag} : coordonnées hors de Paris (${p.lat}, ${p.lon}) — bornes lat ${LAT_MIN}–${LAT_MAX}, lon ${LON_MIN}–${LON_MAX}`);
  }

  // Lien https
  if (!isNonEmptyString(p.lien)) {
    err(`${tag} : « lien » absent`);
  } else if (!isHttps(p.lien)) {
    err(`${tag} : lien non https : ${p.lien}`);
  }

  // lienType
  if (!LIEN_TYPES.has(p.lienType)) {
    err(`${tag} : lienType invalide : ${JSON.stringify(p.lienType)} (attendu wikipedia | recherche | wikidata)`);
  } else if (isHttps(p.lien ?? "")) {
    const host = new URL(p.lien).hostname;
    if (p.lienType === "wikipedia" && host !== "fr.wikipedia.org") {
      warn(`${tag} : lienType=wikipedia mais hôte ${host} (attendu fr.wikipedia.org)`);
    }
    if (p.lienType === "recherche" && !(host === "fr.wikipedia.org" && p.lien.includes("search="))) {
      warn(`${tag} : lienType=recherche mais lien inattendu : ${p.lien}`);
    }
  }

  // Champs texte / nullable
  if (p.adresse !== null && typeof p.adresse !== "string") err(`${tag} : « adresse » doit être une chaîne ou null`);
  if (!isNonEmptyString(p.adresse)) nullAdresse++;
  if (typeof p.texte !== "string") err(`${tag} : « texte » doit être une chaîne`);
  if (p.categorie !== null && typeof p.categorie !== "string") err(`${tag} : « categorie » doit être une chaîne ou null`);
});

// Seuil d'avertissement : part de liens Wikipédia directs (contrat : article trouvé si fiable)
const WIKI_MIN_SHARE = 0.1;

// ---------- Statistiques ----------
const count = (arr, keyFn) => {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const valid = data.filter((p) => p && typeof p.lat === "number" && typeof p.lon === "number");
const lats = valid.map((p) => p.lat), lons = valid.map((p) => p.lon);
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : "0.0") + " %";
const wiki = data.filter((p) => p?.lienType === "wikipedia").length;
const recherche = data.filter((p) => p?.lienType === "recherche").length;
const cats = count(data.filter((p) => p?.categorie), (p) => p.categorie);
const noms = data.filter((p) => isNonEmptyString(p?.nom)).length;

console.log(`Fichier : ${file}`);
console.log("");
console.log("=== Statistiques ===");
console.log(`Entrées                : ${data.length}`);
console.log(`Ids uniques            : ${seenIds.size}`);
console.log(`Noms renseignés        : ${noms} (${pct(noms, data.length)})`);
console.log(`Sans coordonnées       : ${missingCoords}`);
console.log(`Titre vide/null        : ${nullTitre} (${pct(nullTitre, data.length)})`);
console.log(`Adresse vide/null      : ${nullAdresse} (${pct(nullAdresse, data.length)})`);
if (valid.length) {
  console.log(`Emprise lat            : ${Math.min(...lats).toFixed(5)} → ${Math.max(...lats).toFixed(5)}`);
  console.log(`Emprise lon            : ${Math.min(...lons).toFixed(5)} → ${Math.max(...lons).toFixed(5)}`);
}
console.log(`Liens wikipedia        : ${wiki} (${pct(wiki, data.length)})`);
console.log(`Liens recherche        : ${recherche} (${pct(recherche, data.length)})`);
if (data.length && wiki / data.length < WIKI_MIN_SHARE) {
  warn(`part de liens Wikipédia directs faible : ${pct(wiki, data.length)} (seuil ${WIKI_MIN_SHARE * 100} %) — l'agent data a-t-il résolu les articles ?`);
}
console.log(`Catégories distinctes  : ${cats.length}`);
if (cats.length) {
  console.log("Top catégories :");
  for (const [k, n] of cats.slice(0, 10)) console.log(`  ${String(n).padStart(5)}  ${k}`);
}
const sansCat = data.length - cats.reduce((s, [, n]) => s + n, 0);
if (sansCat) console.log(`Sans catégorie         : ${sansCat}`);

// ---------- Contrôle réseau d'un échantillon de liens Wikipédia ----------
// Échantillon de 100 entrées lienType=wikipedia réparties régulièrement. Vérifie :
// statut 200 après redirections, pas de « index.php?search », pas de page d'homonymie.
// Désactivable avec --no-links (ex. hors ligne). Throttle ≤ 5 req/s, UA générique.
const LINK_SAMPLE = 100;
const LINK_MIN_INTERVAL_MS = 200; // 5 req/s max
const LINK_UA = "plaques-paris-demo/1.0";
const skipLinks = process.argv.includes("--no-links");

async function checkLink(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": LINK_UA, Accept: "text/html" },
    signal: AbortSignal.timeout(15_000),
  });
  const finalUrl = res.url;
  const body = res.ok ? (await res.text()).slice(0, 400_000) : "";
  return { status: res.status, finalUrl, body };
}

const isDisambig = (html) =>
  /Catégorie:Homonymie|class="[^"]*\bhomonymie\b|mw-disambig|Page d'homonymie/i.test(html);

if (!skipLinks) {
  const wikiEntries = data.filter((p) => p?.lienType === "wikipedia" && isHttps(p.lien ?? ""));
  if (!wikiEntries.length) {
    warn("contrôle des liens ignoré : aucune entrée lienType=wikipedia");
  } else {
    const step = Math.max(1, Math.floor(wikiEntries.length / LINK_SAMPLE));
    const sample = [];
    for (let i = 0; i < wikiEntries.length && sample.length < LINK_SAMPLE; i += step) sample.push(wikiEntries[i]);
    console.log("");
    console.log(`=== Contrôle de ${sample.length} liens Wikipédia (réseau) ===`);
    let ok = 0;
    for (const p of sample) {
      const tag = `id=${p.id} « ${p.nom} »`;
      try {
        const r = await checkLink(p.lien);
        if (r.status !== 200) {
          err(`lien ${tag} : statut HTTP ${r.status} (${p.lien})`);
        } else if (/index\.php\?search/.test(r.finalUrl)) {
          err(`lien ${tag} : retombe sur une recherche (${r.finalUrl})`);
        } else if (isDisambig(r.body)) {
          err(`lien ${tag} : page d'homonymie (${r.finalUrl})`);
        } else {
          ok++;
        }
      } catch (e) {
        err(`lien ${tag} : requête échouée (${e.message})`);
      }
      await new Promise((resolve) => setTimeout(resolve, LINK_MIN_INTERVAL_MS));
    }
    console.log(`Liens valides : ${ok}/${sample.length}`);
  }
}

// ---------- Avertissements et verdict ----------
const MAX_SHOW = 25;
if (warnings.length) {
  console.log("");
  console.log(`=== Avertissements (${warnings.length}) ===`);
  warnings.slice(0, MAX_SHOW).forEach((w) => console.log(`  - ${w}`));
  if (warnings.length > MAX_SHOW) console.log(`  … ${warnings.length - MAX_SHOW} de plus`);
}

console.log("");
if (errors.length) {
  console.log(`=== Erreurs (${errors.length}) ===`);
  errors.slice(0, MAX_SHOW).forEach((e) => console.log(`  - ${e}`));
  if (errors.length > MAX_SHOW) console.log(`  … ${errors.length - MAX_SHOW} de plus`);
  console.log("");
  console.log("ECHEC validation des données");
  process.exit(1);
}

if (data.length === 0) {
  console.log("ECHEC : tableau vide");
  process.exit(1);
}

console.log("OK validation des données");
process.exit(0);
