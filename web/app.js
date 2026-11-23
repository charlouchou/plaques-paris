/* Plaques de Paris — carte Google Maps, marqueurs groupés, fiche et recherche.
 * Pas de build : HTML/CSS/JS statique. Tout texte issu des données passe par textContent (pas d'innerHTML).
 */
(function () {
  'use strict';

  var PARIS_CENTER = { lat: 48.8566, lng: 2.3522 };
  var PARIS_BOUNDS = { latMin: 48.8, latMax: 48.92, lonMin: 2.2, lonMax: 2.48 };
  var DATA_URLS = ['data/plaques.json', 'data/sample.json']; // plaques.json en priorité
  var MAPS_CALLBACK = '__plaquesMapsReady';
  var MAX_RESULTS = 20;

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    search: $('search'),
    results: $('search-results'),
    locate: $('locate'),
    status: $('status'),
    toast: $('toast'),
    configError: $('config-error'),
    configMessage: $('config-error-message'),
    panel: $('info-panel'),
    name: $('info-name'),
    categorie: $('info-categorie'),
    address: $('info-address'),
    texte: $('info-texte'),
    link: $('info-link'),
    nolink: $('info-nolink'),
    close: $('info-close')
  };

  var state = {
    map: null,
    plaques: [],
    markers: new Map(),   // id -> google.maps.Marker
    clusterer: null,
    userMarker: null,
    selectedId: null,
    toastTimer: null
  };

  /* ---------- Utilitaires ---------- */

  function normalize(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  }

  function isInParis(lat, lon) {
    return lat >= PARIS_BOUNDS.latMin && lat <= PARIS_BOUNDS.latMax &&
           lon >= PARIS_BOUNDS.lonMin && lon <= PARIS_BOUNDS.lonMax;
  }

  function isHttpsUrl(u) {
    return typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u);
  }

  // Normalise une entrée du JSON ; renvoie null si elle n'a pas de coordonnées exploitables.
  function toPlaque(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var lat = Number(raw.lat);
    var lon = Number(raw.lon);
    if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
    var nom = String(raw.nom || raw.titre || 'Sans nom').trim();
    // lien null (lienType 'aucun') ou non HTTPS : pas de bouton, on affiche « Pas de page trouvée ».
    var lien = isHttpsUrl(raw.lien) ? raw.lien : null;
    return {
      id: raw.id != null ? String(raw.id) : nom + '@' + lat + ',' + lon,
      nom: nom,
      texte: raw.texte ? String(raw.texte) : '',
      adresse: raw.adresse ? String(raw.adresse) : '',
      categorie: raw.categorie ? String(raw.categorie) : '',
      lat: lat,
      lon: lon,
      lien: lien,
      lienType: raw.lienType ? String(raw.lienType) : ''
    };
  }

  function showToast(message, ms) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.toast.hidden = true; }, ms || 3500);
  }

  function setStatus(text) {
    el.status.textContent = text;
  }

  /* ---------- Chargement des données ---------- */

  function loadPlaques() {
    var tryUrl = function (i, lastError) {
      if (i >= DATA_URLS.length) {
        return Promise.reject(lastError || new Error('Aucune donnée disponible'));
      }
      var url = DATA_URLS[i];
      return fetch(url, { cache: 'no-cache' })
        .then(function (res) {
          if (!res.ok) throw new Error(url + ' : HTTP ' + res.status);
          return res.json();
        })
        .then(function (json) {
          if (!Array.isArray(json)) throw new Error(url + ' : tableau JSON attendu');
          var plaques = json.map(toPlaque).filter(Boolean);
          return { plaques: plaques, source: url };
        })
        .catch(function (err) {
          console.warn('[plaques] ' + err.message);
          return tryUrl(i + 1, err);
        });
    };
    return tryUrl(0, null);
  }

  /* ---------- Google Maps ---------- */

  function loadGoogleMaps(key) {
    return new Promise(function (resolve, reject) {
      window.gm_authFailure = function () {
        reject(new Error('Clé Google Maps refusée (restrictions de domaine ou facturation).'));
      };
      window[MAPS_CALLBACK] = function () { resolve(window.google.maps); };

      var script = document.createElement('script');
      script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
        '&callback=' + MAPS_CALLBACK + '&language=fr&region=FR';
      script.async = true;
      script.onerror = function () { reject(new Error('Impossible de charger Google Maps.')); };
      document.head.appendChild(script);
    });
  }

  function createMap() {
    return new google.maps.Map($('map'), {
      center: PARIS_CENTER,
      zoom: 13,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
      gestureHandling: 'greedy'
    });
  }

  function buildMarkers() {
    var markers = state.plaques.map(function (p) {
      var marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lon },
        title: p.nom
      });
      marker.addListener('click', function () { selectPlaque(p.id, true); });
      state.markers.set(p.id, marker);
      return marker;
    });

    if (window.markerClusterer && window.markerClusterer.MarkerClusterer) {
      state.clusterer = new window.markerClusterer.MarkerClusterer({ map: state.map, markers: markers });
    } else {
      // Repli si le script MarkerClusterer n'a pas pu être chargé : marqueurs simples.
      console.warn('[plaques] MarkerClusterer indisponible, marqueurs non groupés.');
      markers.forEach(function (m) { m.setMap(state.map); });
    }
  }

  /* ---------- Fiche ---------- */

  function findPlaque(id) {
    for (var i = 0; i < state.plaques.length; i++) {
      if (state.plaques[i].id === id) return state.plaques[i];
    }
    return null;
  }

  function openPanel(p) {
    state.selectedId = p.id;
    el.name.textContent = p.nom;
    el.categorie.textContent = p.categorie;
    el.categorie.hidden = !p.categorie;
    el.address.textContent = p.adresse;
    el.address.hidden = !p.adresse;
    el.texte.textContent = p.texte;
    el.texte.hidden = !p.texte;
    if (p.lien) {
      el.link.href = p.lien;
      el.link.textContent = p.lienType === 'wikidata' ? 'Fiche Wikidata' : 'En savoir plus';
      el.link.hidden = false;
      el.nolink.hidden = true;
    } else {
      el.link.removeAttribute('href');
      el.link.hidden = true;
      el.nolink.hidden = false;
    }
    el.panel.classList.add('is-open');
    el.panel.setAttribute('aria-hidden', 'false');
  }

  function closePanel() {
    state.selectedId = null;
    el.panel.classList.remove('is-open');
    el.panel.setAttribute('aria-hidden', 'true');
  }

  function selectPlaque(id, fromMarker) {
    var p = findPlaque(id);
    if (!p) return;
    openPanel(p);
    if (state.map) {
      state.map.panTo({ lat: p.lat, lng: p.lon });
      if (!fromMarker || state.map.getZoom() < 16) state.map.setZoom(Math.max(state.map.getZoom(), 16));
    }
  }

  /* ---------- Recherche ---------- */

  function searchPlaques(query) {
    var q = normalize(query);
    if (!q) return [];
    var starts = [];
    var contains = [];
    state.plaques.forEach(function (p) {
      var n = normalize(p.nom);
      if (n.indexOf(q) === 0) starts.push(p);
      else if (n.indexOf(q) > 0) contains.push(p);
    });
    return starts.concat(contains).slice(0, MAX_RESULTS);
  }

  function renderResults() {
    var matches = searchPlaques(el.search.value);
    el.results.textContent = '';
    if (!el.search.value.trim()) {
      el.results.hidden = true;
      return;
    }
    if (matches.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Aucune plaque trouvée';
      empty.style.padding = '10px 12px';
      empty.style.color = 'var(--muted)';
      el.results.appendChild(empty);
    }
    matches.forEach(function (p) {
      var li = document.createElement('li');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('data-testid', 'search-result');
      btn.dataset.id = p.id;
      btn.textContent = p.nom;
      if (p.adresse) {
        var small = document.createElement('small');
        small.textContent = p.adresse;
        btn.appendChild(small);
      }
      li.appendChild(btn);
      el.results.appendChild(li);
    });
    el.results.hidden = false;
  }

  function hideResults() {
    el.results.hidden = true;
  }

  /* ---------- Localisation ---------- */

  function locateUser() {
    if (!navigator.geolocation) {
      showToast('La géolocalisation n’est pas disponible sur cet appareil.');
      return;
    }
    el.locate.disabled = true;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        el.locate.disabled = false;
        var ll = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (!state.map) {
          showToast('Carte indisponible : impossible d’afficher votre position.');
          return;
        }
        if (!state.userMarker) {
          state.userMarker = new google.maps.Marker({
            map: state.map,
            position: ll,
            title: 'Vous êtes ici',
            clickable: false,
            zIndex: 1000,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#1a73e8',
              fillOpacity: 1,
              strokeColor: '#ffffff',
              strokeWeight: 3
            }
          });
        } else {
          state.userMarker.setPosition(ll);
        }
        state.map.panTo(ll);
        state.map.setZoom(16);
        if (!isInParis(ll.lat, ll.lng)) showToast('Vous semblez être hors de Paris.');
      },
      function (err) {
        el.locate.disabled = false;
        var msg = err && err.code === 1
          ? 'Accès à la position refusé. Autorisez-le dans les réglages du navigateur.'
          : 'Position introuvable pour le moment.';
        showToast(msg, 5000);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  /* ---------- Écouteurs ---------- */

  function bindUi() {
    el.search.addEventListener('input', renderResults);
    el.search.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = searchPlaques(el.search.value)[0];
        if (first) {
          selectPlaque(first.id, false);
          el.search.blur();
          hideResults();
        }
      } else if (e.key === 'Escape') {
        el.search.value = '';
        hideResults();
      }
    });
    el.search.addEventListener('blur', function () {
      // Délai pour laisser le clic sur un résultat aboutir avant de masquer la liste.
      setTimeout(hideResults, 150);
    });
    el.results.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-id]');
      if (!btn) return;
      el.search.value = btn.textContent.trim();
      hideResults();
      selectPlaque(btn.dataset.id, false);
    });

    el.locate.addEventListener('click', locateUser);
    el.close.addEventListener('click', closePanel);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePanel();
    });
  }

  function enableUi(enabled) {
    el.search.disabled = !enabled;
    el.locate.disabled = !enabled;
  }

  function showConfigError(message) {
    if (message) el.configMessage.textContent = message;
    el.configError.hidden = false;
  }

  /* ---------- Démarrage ---------- */

  function boot() {
    bindUi();

    var key = String((window.GOOGLE_MAPS_API_KEY || '')).trim();
    var mapReady;
    if (!key) {
      showConfigError();
      mapReady = Promise.resolve(null);
    } else {
      mapReady = loadGoogleMaps(key)
        .then(function () { return createMap(); })
        .catch(function (err) {
          console.error('[plaques] ' + err.message);
          showConfigError('Google Maps n’a pas pu être chargé : ' + err.message);
          return null;
        });
    }

    var dataReady = loadPlaques();

    Promise.all([mapReady, dataReady])
      .then(function (results) {
        var map = results[0];
        var data = results[1];
        state.map = map;
        state.plaques = data.plaques;

        if (map) buildMarkers();

        // Crochet de lecture pour les tests QA (non utilisé par l'interface).
        window.__plaquesApp = {
          map: state.map,
          markers: Array.from(state.markers, function (entry) {
            return { id: entry[0], marker: entry[1] };
          })
        };

        var count = state.plaques.length;
        setStatus(count + ' plaques · Données : Ville de Paris (Open Data)');
        enableUi(true);
        if (!map) {
          // Sans carte, la recherche reste utilisable pour consulter les fiches.
          el.locate.disabled = true;
        }
        console.info('[plaques] ' + count + ' plaques chargées depuis ' + data.source);
      })
      .catch(function (err) {
        console.error('[plaques] ' + err.message);
        setStatus('Impossible de charger les plaques.');
        showToast('Données indisponibles. Réessayez plus tard.', 6000);
      });
  }

  boot();
})();
