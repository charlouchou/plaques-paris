// Tests navigateur (Playwright, viewport iPhone 13) sur web/ servi en local.
// Sélecteurs = data-testid du frontend : map, search, search-results, search-result,
// locate, info-panel, info-name, info-link, info-close, config-error.
// Les marqueurs MarkerClusterer (Google Maps) n'ont pas de data-testid : la fiche
// est ouverte via la recherche, qui emprunte le même chemin d'ouverture.

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = process.env.WEB_DIR ?? join(here, "..", "web");

// Lit la clé dans web/config.js : window.GOOGLE_MAPS_API_KEY = "";
function readApiKey() {
  const src = readFileSync(join(WEB, "config.js"), "utf8");
  const m = src.match(/GOOGLE_MAPS_API_KEY\s*=\s*["']([^"']*)["']/);
  return m ? m[1].trim() : "";
}
const HAS_KEY = readApiKey().length > 0;

// Une plaque connue du jeu chargé par l'app (plaques.json prioritaire, sinon sample.json).
function knownPlaque() {
  for (const f of ["plaques.json", "sample.json"]) {
    const p = join(WEB, "data", f);
    if (existsSync(p)) {
      const arr = JSON.parse(readFileSync(p, "utf8"));
      const first = arr.find((x) => x?.nom);
      if (first) return first;
    }
  }
  return null;
}
const PLAQUE = knownPlaque();

// Erreurs console tolérées (à remplir seulement avec justification).
const ALLOWED_CONSOLE_ERRORS = [];

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (url.includes("favicon")) return; // 404 favicon : bruit navigateur
    const text = msg.text();
    if (ALLOWED_CONSOLE_ERRORS.some((re) => re.test(text))) return;
    errors.push(`console.error: ${text} ${url ? `(${url})` : ""}`);
  });
  return errors;
}

test.describe("chargement", () => {
  test("la page charge sans erreur console ni exception", async ({ page }) => {
    const errors = collectErrors(page);
    const response = await page.goto("/", { waitUntil: "load" });
    expect(response?.status(), "HTTP status de /").toBe(200);
    // Laisse le temps aux scripts (Maps, MarkerClusterer, plaques.json) de s'exécuter.
    await page.waitForTimeout(2_000);
    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("pas de débordement horizontal (mobile)", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "largeur de page > viewport").toBeLessThanOrEqual(0);
  });
});

test.describe("sans clé API", () => {
  test.skip(HAS_KEY, "une clé est présente dans web/config.js : tests « avec clé » actifs");

  test("affiche un message clair (config-error) au lieu de planter", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/", { waitUntil: "load" });
    const msg = page.getByTestId("config-error");
    await expect(msg, "message « clé API manquante » visible").toBeVisible();
    await expect(msg).not.toHaveText(/^\s*$/);
    await expect(page.locator(".gm-style"), "pas de rendu Google Maps sans clé").toHaveCount(0);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("avec clé API", () => {
  test.skip(!HAS_KEY, "aucune clé dans web/config.js : tests « carte » ignorés");

  test("la carte s'affiche", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    const map = page.getByTestId("map");
    await expect(map).toBeVisible();
    // Google Maps a rendu ses tuiles / contrôles dans le conteneur.
    await expect(map.locator(".gm-style").first(), "Google Maps rendu").toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("config-error"), "pas de message d'erreur de config").toBeHidden();
  });

  test("recherche et « me localiser » présents, tactiles (≥ 44 px)", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    for (const id of ["search", "locate"]) {
      const el = page.getByTestId(id);
      await expect(el, `data-testid=${id} visible`).toBeVisible();
      const box = await el.boundingBox();
      expect(box, `boîte de ${id}`).not.toBeNull();
      expect(box.height, `hauteur de ${id}`).toBeGreaterThanOrEqual(44);
      expect(box.width, `largeur de ${id}`).toBeGreaterThanOrEqual(44);
    }
  });

  test("ouverture d'une plaque → panneau avec nom + lien https", async ({ page }) => {
    test.skip(!PLAQUE, "aucune plaque dans web/data/ (plaques.json / sample.json)");
    const errors = collectErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByTestId("map").locator(".gm-style").first()).toBeVisible({ timeout: 30_000 });

    // Recherche par nom → résultat → fiche.
    const search = page.getByTestId("search");
    await search.fill(PLAQUE.nom);
    const result = page.getByTestId("search-result").filter({ hasText: PLAQUE.nom }).first();
    await expect(result, `résultat de recherche pour « ${PLAQUE.nom} »`).toBeVisible();
    await result.click();

    const panel = page.getByTestId("info-panel");
    await expect(panel, "panneau d'information visible").toBeVisible();

    const name = page.getByTestId("info-name");
    await expect(name).toBeVisible();
    const nameText = (await name.innerText()).trim();
    expect(nameText.length, "nom non vide").toBeGreaterThan(0);
    expect(nameText, "nom affiché = nom de la plaque").toContain(PLAQUE.nom);

    const link = page.getByTestId("info-link");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href, "lien présent").not.toBeNull();
    expect(href, "lien en https").toMatch(/^https:\/\//);
    expect(href, "lien identique à celui des données").toBe(PLAQUE.lien);
    expect(await link.getAttribute("target"), "ouverture dans un nouvel onglet").toBe("_blank");
    const box = await link.boundingBox();
    expect(box?.height ?? 0, "bouton « En savoir plus » ≥ 44 px").toBeGreaterThanOrEqual(44);

    expect(errors, errors.join("\n")).toEqual([]);
  });

  test("fermer le panneau le masque", async ({ page }) => {
    test.skip(!PLAQUE, "aucune plaque dans web/data/ (plaques.json / sample.json)");
    await page.goto("/", { waitUntil: "load" });
    await page.getByTestId("search").fill(PLAQUE.nom);
    await page.getByTestId("search-result").filter({ hasText: PLAQUE.nom }).first().click();
    await expect(page.getByTestId("info-panel")).toBeVisible();
    await page.getByTestId("info-close").click();
    await expect(page.getByTestId("info-panel")).toBeHidden();
  });
});

test.describe("marqueurs (crochet de test window.__plaquesApp)", () => {
  test.skip(!HAS_KEY, "aucune clé dans web/config.js : tests marqueurs ignorés");

  test("clic sur un vrai marqueur → info-panel is-open avec nom + lien https", async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByTestId("map").locator(".gm-style").first()).toBeVisible({ timeout: 30_000 });

    // Attend que les marqueurs soient créés (crochet de test exposé par l'UI).
    await page.waitForFunction(() => (window.__plaquesApp?.markers?.length ?? 0) > 0, null, { timeout: 30_000 });

    // Déclenche le clic Google Maps sur le premier marqueur.
    const markerId = await page.evaluate(() => {
      const { markers } = window.__plaquesApp;
      const m = markers[0];
      window.google.maps.event.trigger(m.marker, "click");
      return m.id;
    });

    const panel = page.getByTestId("info-panel");
    await expect(panel, "panneau ouvert (is-open)").toHaveClass(/is-open/);
    await expect(panel).toBeVisible();

    const name = page.getByTestId("info-name");
    await expect(name).not.toHaveText(/^\s*$/);

    // Le nom affiché correspond à la plaque du marqueur cliqué.
    const data = JSON.parse(readFileSync(join(WEB, "data", "plaques.json"), "utf8"));
    const entry = data.find((p) => String(p.id) === String(markerId));
    if (entry) expect((await name.innerText()).trim(), "nom = plaque du marqueur").toContain(entry.nom);

    const link = page.getByTestId("info-link");
    await expect(link).toBeVisible();
    expect(await link.getAttribute("href"), "lien https").toMatch(/^https:\/\//);
    expect(await link.getAttribute("target")).toBe("_blank");

    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("cas lien = null (données injectées via route)", () => {
  test.skip(!HAS_KEY, "aucune clé dans web/config.js : test ignoré");
  test.skip(!PLAQUE, "aucune plaque dans web/data/ : test ignoré");

  test("plaque sans lien : pas d'erreur, pas de lien cassé affiché", async ({ page }) => {
    const errors = collectErrors(page);
    // Intercepte plaques.json et met lien=null sur la plaque de test.
    await page.route(/\/data\/plaques\.json$/, async (route) => {
      const response = await route.fetch();
      const arr = await response.json();
      const target = arr.find((p) => String(p.id) === String(PLAQUE.id));
      if (target) {
        target.lien = null;
        target.lienType = null;
      }
      await route.fulfill({ response, body: JSON.stringify(arr), contentType: "application/json" });
    });

    await page.goto("/", { waitUntil: "load" });
    await expect(page.getByTestId("map").locator(".gm-style").first()).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("search").fill(PLAQUE.nom);
    await page.getByTestId("search-result").filter({ hasText: PLAQUE.nom }).first().click();
    await expect(page.getByTestId("info-panel"), "fiche ouverte malgré lien=null").toBeVisible();
    await expect(page.getByTestId("info-name")).toContainText(PLAQUE.nom);

    // Pas de lien : le bouton est masqué et le message « Pas de page trouvée » s'affiche.
    await expect(page.getByTestId("info-nolink"), "message « Pas de page trouvée »").toBeVisible();
    await expect(page.getByTestId("info-nolink")).toContainText(/pas de page/i);
    const link = page.getByTestId("info-link");
    if (await link.count()) {
      const href = await link.getAttribute("href");
      const visible = await link.isVisible();
      expect(!visible || (href && /^https:\/\//.test(href)), `lien affiché alors que lien=null (href=${href})`).toBe(true);
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
