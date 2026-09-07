// Panel — a front-end for the Publisher → Line → Thread → Volume model.
// A "thread" is whatever a reader follows: a character for superhero books,
// a creator for manga and creator-owned work, a team or an event where those fit.

const view = document.querySelector('#view');
const sheet = document.querySelector('#sheet');
const sheetBody = document.querySelector('#sheet-body');
const toastEl = document.querySelector('#toast');
const searchInput = document.querySelector('#search-input');

const state = { shelf: [], filters: {}, results: [], editions: [], query: '' };
let discoverBootstrapPoll;

// Comics vocabulary is genuinely opaque from the outside, and the app is full of
// it. Anything in here gets a dotted underline and explains itself on hover.
const GLOSSARY = {
  omnibus: 'One oversized hardcover collecting a long run of issues — often 700+ pages, and usually the cheapest way to own a whole era.',
  compendium: 'Phone-book sized softcover. Even more pages than an omnibus, on cheaper paper with smaller print.',
  absolute: 'DC’s premium line: oversized, slipcased hardcovers with remastered artwork.',
  'epic collection': 'Marvel’s paperback line that reprints a run in story order, numbered so you can read straight through.',
  masterworks: 'Marvel’s archival hardcovers, reprinting the earliest issues of a title with restored colour.',
  'deluxe edition': 'A hardcover at larger-than-normal size, usually with sketches, scripts or covers in the back.',
  'library edition': 'Oversized hardcover collecting a complete run, built to last on a shelf.',
  hardcover: 'A bound collection at standard size — a few issues rather than a whole run.',
  'collected edition': 'The everyday trade paperback: one story arc gathered into a single book.',
  'one-shot': 'A self-contained single issue that is not part of an ongoing series.',
  annual: 'An oversized once-a-year issue, usually a standalone story.',
  imprint: 'A publishing line within a publisher, with its own editorial identity — Vertigo inside DC, MAX inside Marvel.',
  'earth-616': 'The main Marvel continuity — the "default" universe most Marvel comics take place in.',
  'prime earth': 'DC’s main continuity since 2011, the equivalent of Marvel’s Earth-616.',
  vertigo: 'DC’s adult imprint (1993–2020): Sandman, Preacher, Y: The Last Man.',
  max: 'Marvel’s adult imprint — Punisher MAX, Alias.',
  volume: 'ComicVine’s word for a single series run — every "The Amazing Spider-Man" launch is its own volume.',
  manga: 'Comics from Japanese publishers, read right to left and usually collected in numbered volumes.',
  opds: 'An open catalogue standard that comic readers use to browse a server’s library.',
  notability: 'Our own ranking, not a rating: publisher provenance, an established run and its age. ComicVine has no reader ratings.',
  'best match': 'Exact titles and all of your words come first. A publisher or year in the search is treated as an instruction; notability only breaks otherwise equal matches.',
  'in library': 'Downloaded and imported into Komga. You can read it now.',
  searching: 'Requested in Mylar, which is still hunting for it across GetComics and your Prowlarr indexers. This can take a while.',
  series: 'An ongoing run of single issues, as opposed to a collected book.',
  character: 'A person in the comics. Following one shows every book they appear in.',
  creator: 'A writer or artist. The way into manga and creator-owned books, where nobody follows a single character.',
  team: 'A group read as one thing — the Avengers, the X-Men, the Justice League.',
  event: 'A crossover storyline running through several titles at once, like Secret Wars or Dark Web.',
  'issue range': 'Which issues this particular run covers. The only reliable way to tell six volumes all called "The Amazing Spider-Man" apart.',
  komga: 'Your comic library server. Once a request downloads, it is imported here and becomes readable.',
  mylar: 'The downloader. Requesting a book hands it to Mylar, which searches your indexers in the background.',
};

// An explicit affordance rather than a dotted underline: a small ⓘ that says
// there is something to read here. Placed anywhere a term might not be obvious.
const info = (key, align = '') => {
  const tip = GLOSSARY[String(key).toLowerCase()];
  if (!tip) return '';
  return `<button type="button" class="info ${align}" data-tip="${esc(tip)}"
    aria-label="What does ${esc(key)} mean?">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5"></circle><path d="M12 11v6"></path><circle cx="12" cy="7.4" r="1.1" fill="currentColor" stroke="none"></circle>
    </svg></button>`;
};

const term = (text, key = text) => {
  const tip = GLOSSARY[String(key).toLowerCase()];
  return tip ? `<span class="term" tabindex="0" data-tip="${esc(tip)}">${esc(text)}</span>` : esc(text);
};

/* ---------------- poster size ---------------- */

const poster = document.querySelector('#poster');
function setPoster(px, persist = true) {
  const size = Math.min(320, Math.max(110, Number(px) || 150));
  document.documentElement.style.setProperty('--poster', `${size}px`);
  poster.value = String(size);
  // Per-device preference; a phone and a desk monitor want different answers.
  if (persist) { try { localStorage.setItem('panel:poster', String(size)); } catch { /* private mode */ } }
}
try { setPoster(localStorage.getItem('panel:poster') ?? 150, false); } catch { setPoster(150, false); }
poster.addEventListener('input', (event) => setPoster(event.target.value));

// How many titles a page shows. Kept beside poster size because they are the
// same kind of preference: how much you want on screen at once.
const PAGE_SIZES = [24, 48, 72, 96];
function pageSize() {
  try {
    const stored = Number(localStorage.getItem('panel:pagesize'));
    return PAGE_SIZES.includes(stored) ? stored : 48;
  } catch { return 48; }
}
function setPageSize(value) {
  try { localStorage.setItem('panel:pagesize', String(value)); } catch { /* private mode */ }
}

// Panel preferences deliberately live in the browser. They affect this reader's
// presentation and request flow, not Mylar/Komga's global configuration.
const setting = (name, fallback) => {
  try { return localStorage.getItem(`panel:${name}`) ?? fallback; } catch { return fallback; }
};
const setSetting = (name, value) => {
  try { localStorage.setItem(`panel:${name}`, String(value)); } catch { /* private mode */ }
};
const settingOn = (name, fallback = false) => setting(name, String(fallback)) === 'true';
function applyAccessibility() {
  document.documentElement.classList.toggle('reduce-motion', settingOn('reduce-motion'));
}
applyAccessibility();
const perPageSelect = (id) => `<label><span class="kicker">Per page</span>
  <select data-pagesize id="${id}">${PAGE_SIZES.map((n) =>
    `<option value="${n}"${n === pageSize() ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`;

/* ---------------- plumbing ---------------- */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const esc = (value = '') =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Provider URLs are display metadata, not executable instructions. ComicVine
// normally supplies HTTPS detail pages, but keeping the scheme gate here means
// a malformed cached response can never create a javascript: link in a sheet.
function externalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'That request could not be completed.');
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  toastEl.textContent = message;
  toastEl.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = ''; }, 4200);
}

const skeletonCard = `<div class="skeleton-card">
  <div class="skeleton"></div>
  <div class="skeleton-line" style="width:80%"></div>
  <div class="skeleton-line" style="width:52%"></div>
</div>`;

// Mirrors the shape of what is coming, so the page does not jump when it lands.
const skeletons = (n, cols) =>
  `<div class="grid"${cols ? ` style="grid-template-columns:${cols}"` : ''}>${skeletonCard.repeat(n)}</div>`;

const skeletonRail = (n = 8) => `<div class="rail">${skeletonCard.repeat(n)}</div>`;

// Deterministic tint from the id, so a title always looks the same before its
// real cover arrives — and stays recognisable if ComicVine never has one.
const TINTS = ['#1d3f6e', '#8d2f1f', '#4a4634', '#6b3f86', '#25241f', '#2c6152', '#7a4a1e', '#3d3a52'];
const tintFor = (id = '') => TINTS[[...String(id)].reduce((n, c) => n + c.charCodeAt(0), 0) % TINTS.length];

function coverHtml(item, { flag = '', ratio = '2 / 3' } = {}) {
  const tint = tintFor(item.id);
  const label = esc(item.title || item.name || '');
  const inner = item.cover || item.image
    ? `<img src="${esc(item.cover || item.image)}" alt="" loading="lazy" decoding="async"
         onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'fallback',textContent:this.alt||''}))" />`
    : `<div class="fallback">${label}</div>`;
  return `<div class="cover" style="aspect-ratio:${ratio};background:${tint}">${inner}${
    flag ? `<span class="flag">${esc(flag)}</span>` : ''}</div>`;
}

/* ---------------- breadcrumbs ---------------- */

// Publisher → Thread → Volume is the whole model, and a reader only ever learns
// it by seeing it. Every segment but the last is somewhere you can actually go;
// the last is where you are. A one-segment trail renders nothing -- a lone
// crumb teaches no chain.
function breadcrumb(segments) {
  const parts = segments.filter(Boolean);
  if (parts.length < 2) return '';
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.map((segment, index) => {
    const node = index === parts.length - 1
      ? `<span class="kicker current" aria-current="page">${esc(segment.label)}</span>`
      : `<button class="kicker" ${segment.attr}>${esc(segment.label)}</button>`;
    return index ? `<span class="crumb-sep" aria-hidden="true">/</span>${node}` : node;
  }).join('')}</nav>`;
}

const crumbBrowse = { label: 'Browse', attr: 'data-route="browse"' };
const crumbPublisher = (name) => (name
  ? { label: name, attr: `data-publisher="${esc(name)}"` }
  : null);

/* ---------------- routing ---------------- */

const routes = {};
function go(path) {
  if (sheet.open) sheet.close();
  if (location.hash !== `#${path}`) location.hash = path; else render();
}

async function render() {
  const start = setting('start-page', 'discover');
  const path = (location.hash || `#/${start}`).slice(1);
  const [, name, ...rest] = path.split('/');
  const route = routes[name] || routes.discover;
  // Rail scroll listeners die with the elements when the view is replaced.
  if (name !== 'discover') clearTimeout(discoverBootstrapPoll);
  document.querySelectorAll('[data-route]').forEach((b) => {
    const active = b.dataset.route === name
      || (name === 'thread' && b.dataset.route === 'threads')
      || (['search', 'publisher', 'hub', 'decade'].includes(name) && b.dataset.route === 'browse');
    b.setAttribute('aria-current', String(active));
  });
  window.scrollTo({ top: 0 });
  try {
    await route(...rest);
    armVeil();
  } catch (error) {
    view.innerHTML = `<div class="empty"><p>${esc(error.message)}</p></div>`;
  }
}

/* ---------------- shelf ---------------- */

async function loadShelf() {
  const data = await api('/api/library');
  state.shelf = data.items;
  state.counts = data.counts;
  document.querySelector('#shelf-count').textContent = data.counts.inLibrary;
  return data;
}

const onShelf = (id) => state.shelf.some((x) => x.id === String(id));

// Two states, one word each, everywhere: Requested (asked for, still on its
// way) and In library (downloaded, readable now). Mylar's own six states are
// real but belong only in the request detail, never on a cover flag.
function shelfFlag(item) {
  const found = state.shelf.find((x) => x.id === String(item.id));
  if (found) return found.inLibrary ? 'In library' : 'Requested';
  return item.requested ? 'Requested' : '';
}

function volumeCard(item) {
  const owned = item.requested || onShelf(item.id);
  // ComicVine calls every publication sequence an "issue." On a collected
  // edition that means an entry in the omnibus line, not the single comics it
  // contains. Say what the reader is actually choosing instead.
  const formatMeta = item.edition !== 'Series'
    ? (item.issues > 1 ? `${item.issues}-volume collection` : 'Single-volume edition')
    : [item.issueRange, item.issues ? plural(item.issues, 'issue') : null]
      .filter(Boolean).join(' · ');
  return `<article class="card">
    <button class="cover-btn" data-volume="${esc(item.id)}" style="all:unset;cursor:pointer">
      ${coverHtml(item, { flag: shelfFlag(item) })}
    </button>
    <div class="meta">
      <span class="kicker" style="color:${item.edition === 'Omnibus' ? 'var(--accent)' : 'var(--muted)'}">${
        esc([item.medium === 'manga' ? 'Manga' : null, item.edition].filter(Boolean).join(' · '))}</span>
      <h3>${esc(item.title)}</h3>
      <span class="sub">${[item.publisher, item.year].filter(Boolean).map(esc).join(' · ')}</span>
      <span class="sub range">${esc(formatMeta) || '&nbsp;'}</span>
      ${/* The card opens the sheet; it never requests. Say what it does and let
             the cover flag carry whether this is already on the shelf. */ ''}
      <button class="act" data-request="${esc(item.id)}">Details →</button>
    </div>
  </article>`;
}

/* ---------------- page ledes ---------------- */

// The big editorial lede is an introduction, and an introduction only lands
// once. First visit: it fades in and says what the page is for. Every visit
// after: one quiet line, with the copy a click away. It used to spend a third
// of the screen telling a reader of a year that they can search for things.
// `kicker`, `title` and `body` are trusted markup written here, not user input.
const seenPage = (route) => setting(`seen:${route}`, '') === 'yes';

// The introduction is a veil, not a header. On a first visit it covers the
// page, the words arrive blurred and settle, and then the whole thing dissolves
// to leave the page behind it — about three seconds, no button to press. Every
// visit after that, the page just opens. The old collapsed "What is this?" bar
// read like a breadcrumb and unfurled to show the very copy it was hiding.
function lede(route, { kicker, title, body = '' }) {
  const first = !seenPage(route);
  if (first) setSetting(`seen:${route}`, 'yes');
  // The veil is stashed rather than returned: routes that rebuild the view's
  // innerHTML after calling lede() would otherwise wipe it, and a fixed overlay
  // has no business living inside the scrolling content anyway.
  if (first) pendingVeil = { kicker, title, body };
  return `<section class="lede lede-brief"><span class="kicker" style="color:var(--accent)">${kicker}</span></section>`;
}

let pendingVeil = null;

// Dismiss on its own schedule, or the moment the reader does anything.
function armVeil() {
  const intro = pendingVeil;
  pendingVeil = null;
  if (!intro) return;
  // Motion is the whole idea here, so a reader who has asked for less of it
  // gets a still panel rather than a janky one.
  const still = settingOn('reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const veil = document.createElement('div');
  veil.className = `veil${still ? ' veil-still' : ''}`;
  veil.innerHTML = `<div class="veil-copy">
      <span class="kicker" style="color:var(--accent)">${intro.kicker}</span>
      <h1>${intro.title}</h1>
      ${intro.body ? `<p>${intro.body}</p>` : ''}
    </div>`;
  document.body.append(veil);
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    veil.classList.add('veil-out');
    // Removed rather than left transparent, so it never eats a click.
    veil.addEventListener('transitionend', () => veil.remove(), { once: true });
    setTimeout(() => veil.remove(), 900);
    window.removeEventListener('keydown', dismiss);
    window.removeEventListener('pointerdown', dismiss);
    window.removeEventListener('wheel', dismiss);
  };
  const timer = setTimeout(dismiss, veil.classList.contains('veil-still') ? 1400 : 2900);
  window.addEventListener('keydown', dismiss);
  window.addEventListener('pointerdown', dismiss);
  window.addEventListener('wheel', dismiss, { passive: true });
}

/* ---------------- stacked art ---------------- */

// The fanned-cover motif used by starter paths, publisher tiles and format
// tiles. The layout is driven by how many covers there actually are: one cover
// centres, two lean against each other, three fan. Previously the positions
// were fixed at three, so a path with a single Batman book sat lonely against
// the left edge.
function stackedArt(sources, initials = '') {
  // Up to six are rendered; CSS container queries decide how many the card is
  // actually wide enough to show, so the count follows the layout rather than
  // a number baked in here.
  // Six is plenty: the covers grow to fill whatever width the card has, so more
  // of them buys nothing but downloads — and at fourteen apiece this page was
  // asking for three hundred cover fetches on a cold first load.
  const covers = (sources || []).filter(Boolean).slice(0, 6);
  if (!covers.length) return `<div class="stack-art" data-count="0" aria-hidden="true"><span>${esc(initials)}</span></div>`;
  // A cover that fails removes its own slot rather than leaving an empty frame;
  // the survivors re-flex and the band still reaches both edges.
  return `<div class="stack-art" data-count="${covers.length}" aria-hidden="true">${covers.map((src, index) =>
    `<div class="stack-cover stack-cover-${index}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"
       onerror="this.closest('.stack-cover').remove()" /></div>`).join('')}</div>`;
}

const coverUrl = (volumeId) => `/api/cover/${encodeURIComponent(String(volumeId))}`;

// A tile with no art falls back to initials, so they have to read as a mark
// rather than a truncation: "Image Comics" is IC, not "Im".
const initialsOf = (name = '') => String(name).split(/\s+/).filter(Boolean)
  .slice(0, 3).map((word) => word[0].toUpperCase()).join('');

/* ---------------- discover ---------------- */

routes.discover = async () => {
  clearTimeout(discoverBootstrapPoll);
  view.innerHTML = `${lede('discover', {
      kicker: 'Your shelf',
      title: 'Everything you follow,<br />in <em>one place</em>.',
      body: 'Search a character, a creator or a book. Requesting hands it to Mylar, which hunts it down and files it into Komga.',
    })}
    <div id="shelf-section">
      <div class="section-head"><span class="kicker no">01</span><h2>Your shelf</h2></div>
      ${skeletonRail(7)}
    </div>
    <div id="starter-paths">
      <div class="section-head"><span class="kicker no">02</span><h2>Good places to start</h2>
        <span class="kicker aside">Built from your local catalogue</span></div>
      ${skeletonRail(5)}
    </div>
    <div id="rails">
      <div class="section-head"><span class="kicker no">02</span><h2>Omnibuses</h2></div>
      ${skeletonRail(8)}
    </div>`;

  const shelfSection = document.querySelector('#shelf-section');
  loadShelf().then(({ items, counts }) => {
    const recent = items.slice(0, 12);
    shelfSection.innerHTML = `
      <div class="section-head">
        <span class="kicker no">01</span><h2>Your shelf</h2>
        <span class="kicker aside">${counts.inLibrary} in library · ${counts.searching} still searching</span>
      </div>
      ${recent.length ? `<div class="rail">${recent.map((x) => `
        <article class="card">
          ${coverHtml(x, { flag: x.inLibrary ? 'In library' : 'Requested' })}
          <div class="meta"><h3>${esc(x.title)}</h3>
          <span class="sub">${esc(x.state)}${x.books ? ` · ${plural(x.books, 'book')}` : ''}</span></div>
        </article>`).join('')}</div>`
        : '<div class="empty">Nothing requested yet.</div>'}`;
  }).catch((e) => { shelfSection.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });

  const starterPaths = document.querySelector('#starter-paths');
  api('/api/discover/paths').then(({ paths }) => {
    starterPaths.innerHTML = `<div class="section-head"><span class="kicker no">02</span><h2>Good places to start</h2>
      <span class="kicker aside">Grows from titles you have explored</span></div>
      <div class="path-grid">${paths.map((path, index) => {
        const art = path.items.filter((item) => item.cover).slice(0, 3);
        return `<article class="path-card path-card-${index % 5}">
          ${stackedArt(art.map((item) => item.cover),
            initialsOf(path.title))}
          <div class="path-copy"><span class="kicker" style="color:var(--accent)">Starter path</span><h3>${esc(path.title)}</h3>
            <p>${path.items.length ? `${path.items.length} saved titles to explore.` : 'Search this path to start teaching Panel about it.'}</p>
            <button class="secondary" ${path.hub ? `data-hub="${esc(path.hub)}"` : `data-search="${esc(path.search)}"`}>Explore →</button></div>
        </article>`;
      }).join('')}</div>`;
  }).catch(() => { starterPaths.innerHTML = ''; });

  const rails = document.querySelector('#rails');
  const renderRails = ({ sections, bootstrapping = false }) => {
    rails.innerHTML = sections.map((section, i) => `
      <div class="section-head">
        <span class="kicker no">0${i + 2}</span><h2>${esc(section.title)}</h2>
        ${section.items.length ? '<span class="kicker aside">From titles you’ve explored</span>' : ''}
      </div>
      ${section.items.length ? `<div class="rail" data-discover-rail="${esc(section.id)}" data-next-offset="${section.items.length}" data-has-more="${section.hasMore}">${section.items.map(volumeCard).join('')}${section.hasMore ? '<span class="rail-sentinel" aria-hidden="true"></span>' : ''}</div>`
        : bootstrapping
          ? '<div class="empty">Building your first local shelves…</div>'
          : `<div class="empty">Not in your local catalogue yet. <button class="secondary" ${section.hub ? `data-hub="${esc(section.hub)}"` : `data-search="${esc(section.query)}"`}>Explore ${esc(section.title)} →</button></div>`}`).join('');
    observeRailEnds();
    if (bootstrapping) {
      discoverBootstrapPoll = setTimeout(() => {
        if (location.hash === '#/discover' || !location.hash) api('/api/discover').then(renderRails).catch(() => {});
      }, 4_000);
    }
  };
  api('/api/discover').then(renderRails)
    .catch(() => { rails.innerHTML = '<div class="empty">ComicVine is not answering right now.</div>'; });
};

// Rail paging is driven by scroll position, not IntersectionObserver.
// iPadOS never reliably fired IO for a 2px sentinel sitting inside a
// mask-image'd horizontal scroller, so on iPad the rails silently stopped
// extending and never reached the loop. Distance-to-end is deterministic,
// costs one layout read per frame at most, and behaves identically everywhere.
const RAIL_TRIGGER_PX = 400;
const railScrollHandlers = new WeakMap();

function observeRailEnds() {
  document.querySelectorAll('[data-discover-rail]').forEach(attachRailPaging);
}

// Throttled on a timer rather than requestAnimationFrame. rAF is starved in
// background tabs and is not reliably delivered during iOS momentum scrolling,
// and a missed frame here does not just drop a repaint -- it strands the guard
// flag and stops the rail paging for good.
const RAIL_CHECK_MS = 120;

function attachRailPaging(rail) {
  if (railScrollHandlers.has(rail)) return;
  let last = 0;
  let trailing;
  const check = () => {
    last = Date.now();
    if (!rail.isConnected) return;
    if (rail.scrollWidth - rail.scrollLeft - rail.clientWidth > RAIL_TRIGGER_PX) return;
    extendRail(rail);
  };
  const onScroll = () => {
    clearTimeout(trailing);
    const since = Date.now() - last;
    // Leading edge for responsiveness, trailing edge so the end of a flick is
    // never the event that gets dropped.
    if (since >= RAIL_CHECK_MS) check();
    else trailing = setTimeout(check, RAIL_CHECK_MS - since);
  };
  railScrollHandlers.set(rail, onScroll);
  rail.addEventListener('scroll', onScroll, { passive: true });
  // A rail whose first page does not overflow its container never emits a
  // scroll event, so it would otherwise sit half-empty forever.
  check();
}

// Rotate the opening books to the tail, keeping the reader's current view
// stationary by subtracting the width they used to occupy.
function loopRail(rail) {
  const cards = [...rail.querySelectorAll(':scope > .card')];
  const batch = cards.slice(0, Math.min(12, cards.length));
  if (batch.length < 2) return;
  const gap = Number.parseFloat(getComputedStyle(rail).columnGap) || 0;
  const shift = batch.reduce((total, card) => total + card.getBoundingClientRect().width, 0)
    + gap * batch.length;
  const sentinel = rail.querySelector('.rail-sentinel');
  batch.forEach((card) => (sentinel ? rail.insertBefore(card, sentinel) : rail.append(card)));
  rail.scrollLeft = Math.max(0, rail.scrollLeft - shift);
}

async function extendRail(rail) {
  if (rail.dataset.loading === 'true') return;
  if (rail.dataset.loopAtEnd === 'true') { loopRail(rail); return; }
  if (rail.dataset.hasMore !== 'true') return;
  rail.dataset.loading = 'true';
  const sentinel = rail.querySelector('.rail-sentinel');
  sentinel?.classList.add('loading');
  let added = 0;
  try {
    const page = await api(`/api/discover/rail/${encodeURIComponent(rail.dataset.discoverRail)}`
      + `?offset=${encodeURIComponent(rail.dataset.nextOffset)}&size=12`);
    added = page.items.length;
    const html = page.items.map(volumeCard).join('');
    if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
    else rail.insertAdjacentHTML('beforeend', html);
    rail.dataset.nextOffset = String(Number(rail.dataset.nextOffset) + page.items.length);
    rail.dataset.hasMore = String(page.hasMore);
    if (!page.hasMore || !page.items.length) {
      // The final local page is the cap. Stop fetching; from here the rail
      // rotates its own opening batch behind the tail instead.
      rail.dataset.loopAtEnd = 'true';
    }
  } catch {
    // A transient local-server failure should not show an alarming error in a
    // decorative shelf; the next scroll retries.
    sentinel?.classList.remove('loading');
  } finally {
    rail.dataset.loading = 'false';
  }
  // Twelve narrow cards may still not fill a wide iPad rail. Only chase a page
  // that actually added something, so a rail that cannot grow never spins.
  if (added && rail.isConnected) {
    setTimeout(() => {
      if (rail.isConnected && rail.scrollWidth - rail.scrollLeft - rail.clientWidth <= RAIL_TRIGGER_PX) {
        extendRail(rail);
      }
    }, 0);
  }
}

/* ---------------- curated hubs ---------------- */

routes.hub = async (id) => {
  view.innerHTML = `<section class="lede"><span class="kicker" style="color:var(--accent)">Browse</span>
    <h1>Loading this <em>collection.</em></h1></section>`;
  const { paths } = await api('/api/discover/paths');
  const hub = paths.find((path) => path.hub === id || path.id === id);
  if (!hub) throw new Error('That browse collection is not available.');
  const copy = {
    'creator-owned': 'Stories led by their creators rather than a shared superhero universe. Start anywhere — each series is its own world.',
  }[id] || 'A local shelf of titles Panel has learned from your browsing.';
  view.innerHTML = `<section class="lede"><span class="kicker" style="color:var(--accent)">Browse without a keyword</span>
    <h1>${esc(hub.title)}</h1><p>${esc(copy)}</p></section>
    <div class="section-head"><span class="kicker no">01</span><h2>Start anywhere</h2>
      <span class="kicker aside">Saved in your local catalogue</span></div>
    ${filterBar(hub.items.length, applyContentFilter(hub.items).length)}
    ${applyContentFilter(hub.items).length
      ? `<div class="grid">${applyContentFilter(hub.items).map(volumeCard).join('')}</div>`
      : `<div class="empty">Panel has not learned any titles for this collection yet. Search for a book you already know, then this hub will grow naturally.</div>`}`;
};

/* ---------------- browse ---------------- */

// A cold catalogue resolves its curated names one paced request at a time, so
// a rail can answer while it is still half a list. Come back for the rest
// instead of leaving the reader looking at the single card that happened to be
// cached -- that state read as "Panel knows one team", which is not the truth.
const SEED_POLL_MS = 4000;
const SEED_POLL_TRIES = 24;

function seededRail(kind, slot, paint) {
  // Resolves on the first paint, not the last: a route must not be held open
  // by the tail of a cold fill, or the first-visit veil arrives a minute late.
  let settle;
  const painted = new Promise((resolve) => { settle = resolve; });
  (async () => {
    for (let attempt = 0; attempt <= SEED_POLL_TRIES; attempt += 1) {
      // A rail that has left the document belongs to a page the reader has
      // already navigated away from; the server keeps filling either way.
      if (!slot.isConnected) break;
      let data;
      try { data = await api(`/api/threads/seeded/${kind}`); } catch { break; }
      if (!slot.isConnected) break;
      paint(data.items || []);
      settle();
      if (!data.pending) break;
      await new Promise((resolve) => { setTimeout(resolve, SEED_POLL_MS); });
    }
    settle();
  })();
  return painted;
}


// Formats drawn to scale. The spine width is the actual differentiator between
// these things -- an omnibus is a brick, a trade paperback is not -- so the card
// shows it rather than describing it. Copy is plain English on purpose: the
// jargon is the main barrier to buying collected editions.
// A format filter that follows the reader from page to page. "I only collect
// omnibuses" is a standing preference, not something to re-state on every
// search, so it is stored per device and applied to every grid of books:
// publisher catalogues, a creator's credits, a hub, search. The Formats browse
// section is gone -- a shape of book was never a destination.
const contentFilter = () => ({
  format: setting('filter:format', 'all'),
  medium: setting('filter:medium', 'all'),
});

const filterActive = () => {
  const { format, medium } = contentFilter();
  return format !== 'all' || medium !== 'all';
};

function applyContentFilter(items) {
  const { format, medium } = contentFilter();
  return (items || []).filter((item) =>
    (format === 'all' || item.edition === format)
    && (medium === 'all' || (item.medium || 'comic') === medium));
}

// Rendered above any grid this filter governs, so the reader can always see
// why a catalogue looks short and undo it in one click.
function filterBar(total = null, shown = null) {
  const { format, medium } = contentFilter();
  const option = (value, label, current) =>
    `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="filters content-filters">
    <label><span class="kicker">Format ${info('collected edition')}</span>
      <select data-content-filter="format">
        ${option('all', 'All formats', format)}
        ${FORMATS.map((f) => option(f.name, f.name, format)).join('')}
      </select></label>
    <label><span class="kicker">Kind ${info('manga')}</span>
      <select data-content-filter="medium">
        ${option('all', 'Comics & manga', medium)}
        ${option('comic', 'Comics only', medium)}
        ${option('manga', 'Manga only', medium)}
      </select></label>
    ${filterActive() ? `<button class="secondary" data-clear-filter>Clear filter</button>` : ''}
    ${total !== null && shown !== null && shown !== total
      ? `<span class="kicker aside">${shown} of ${total} shown</span>` : ''}
  </div>`;
}

const FORMATS = [
  { name: 'Omnibus',           spine: 46, blurb: 'A brick. One oversized hardcover swallowing a whole run, often 700+ pages.' },
  { name: 'Compendium',        spine: 42, blurb: 'Phone-book thick and cheap. Huge page count, softcover, small print.' },
  { name: 'Library edition',   spine: 32, blurb: 'Oversized hardcover, complete runs, made to sit on a shelf for years.' },
  { name: 'Absolute',          spine: 34, blurb: 'DC at its most lavish: slipcased, oversized, remastered art.' },
  { name: 'Epic Collection',   spine: 22, blurb: 'Marvel in order, in paperback. The cheapest way to read a long run.' },
  { name: 'Masterworks',       spine: 20, blurb: 'Marvel’s archival hardcovers. Early issues, restored colour.' },
  { name: 'Deluxe edition',    spine: 18, blurb: 'Hardcover, bigger trim, sketches and scripts in the back.' },
  { name: 'Hardcover',         spine: 14, blurb: 'A bound collection at normal size. A few issues, not a run.' },
  { name: 'Collected edition', spine: 9,  blurb: 'The everyday trade paperback: one story arc, one book.' },
];

routes.browse = async () => {
  // Browse offers destinations, not filters. "By kind" used to live here and was
  // removed: Comics/Manga is a filter present on every search, and as a card it
  // was two grey rectangles and an arrow.
  view.innerHTML = `${lede('browse', {
      kicker: 'Browse',
      title: 'Start with a house,<br />a team, an <em>event</em>, an era.',
    })}

    <div class="section-head"><span class="kicker no">01</span><h2>Publishers</h2>
      <span class="kicker aside">Every house, its lines and its full catalogue</span></div>
    <div id="houses" class="house-grid">${
      '<div class="house-tile skeleton-tile"></div>'.repeat(5)}</div>

    <div class="section-head"><span class="kicker no">02</span><h2>Events</h2>
      <span class="kicker aside">Crossovers that run through several titles at once</span></div>
    <div id="browse-events">${skeletonRail(7)}</div>

    ${/* Eras come out of the local mirror, so this section keeps working while
          ComicVine is cooling down and the rest of the app has gone quiet. */ ''}
    <div class="section-head"><span class="kicker no">03</span><h2>Teams</h2>
      <span class="kicker aside">Line-ups from Wikidata, not ComicVine's guesswork</span></div>
    <div id="browse-teams">${skeletonRail(7)}</div>

    <div class="section-head"><span class="kicker no">04</span><h2>Eras</h2>
      <span class="kicker aside">From your own catalogue — no ComicVine needed</span></div>
    <div id="decades" class="house-grid">${
      '<div class="house-tile skeleton-tile"></div>'.repeat(5)}</div>`;

  for (const [kind, id] of [['story_arc', '#browse-events'], ['team', '#browse-teams']]) {
    const slot = document.querySelector(id);
    if (!slot) continue;
    seededRail(kind, slot, (items) => {
      slot.innerHTML = items.length
        ? `<div class="rail">${items.map((item) => threadCard(item)).join('')}</div>` : '';
    });
  }

  api('/api/decades').then(({ items }) => {
    const slot = document.querySelector('#decades');
    if (!slot) return;
    slot.innerHTML = items.map((era, index) => `
      <button class="art-tile era-tile art-tile-${index % 5}" data-decade="${esc(era.decade)}">
        ${stackedArt((era.art || []).map(coverUrl), `${String(era.decade).slice(2)}s`)}
        <span class="art-copy">
          <span class="disp art-name">${esc(era.decade)}s</span>
          <span class="house-lines">${era.label ? `${esc(era.label)} · ` : ''}${plural(era.titles, 'title')}</span>
        </span>
      </button>`).join('');
  }).catch(() => { const slot = document.querySelector('#decades'); if (slot) slot.innerHTML = ''; });

  api('/api/publishers').then(({ items }) => {
    document.querySelector('#houses').innerHTML = items.map((house, index) => `
      <button class="art-tile house-tile art-tile-${index % 5}" data-publisher="${esc(house.name)}">
        ${stackedArt((house.art || []).map(coverUrl), initialsOf(house.name))}
        <span class="art-copy">
          ${/* Naming the lines teaches what an imprint is; counting them taught
                nothing. "4 imprints" is a number a reader cannot use. */ ''}
          ${/* The wordmark IS the name, so it takes the name's slot. A house
                 with no wordmark keeps the serif setting; both read as the
                 same line of the card. */ ''}
          ${house.wordmark
            ? `<img class="house-wordmark${house.wordmarkInvert ? ' invert' : ''}"
                 src="${esc(house.wordmark)}" alt="${esc(house.name)}" loading="lazy" decoding="async" />`
            : `<span class="disp art-name">${esc(house.name)}</span>`}
          <span class="house-lines">${house.lines.length
            ? esc(house.lines.slice(0, 4).join(' · '))
            : 'The full catalogue'}</span>
        </span>
      </button>`).join('');
  }).catch(() => { document.querySelector('#houses').innerHTML = ''; });

};

/* ---------------- characters & creators ---------------- */

// Tier three of the model finally has a front door. Before this it was
// reachable only sideways -- a search that happened to match, a rail on a
// publisher page, a credit chip inside a volume sheet.
const THREAD_KIND_LABELS = {
  character: 'Characters', person: 'Creators', team: 'Teams', story_arc: 'Events',
};

const threadAttrs = (item) => `data-thread="${esc(item.kind)}/${esc(item.id)}" data-thread-name="${esc(item.name)}"`;

const threadCard = (item, ratio = '2 / 3', fallbackSub = '') => `<article class="card">
  <button ${threadAttrs(item)} style="all:unset;cursor:pointer">
    ${coverHtml({ id: item.id, name: item.name, image: item.image }, { ratio })}
  </button>
  <div class="meta">
    <h3>${esc(item.name)}</h3>
    <span class="sub">${esc(item.publisher || fallbackSub)}</span>
    ${/* ComicVine reports no appearance count for creators or events; an
          unqualified "0 appearances" reads as a fact rather than a blank field. */ ''}
    <span class="sub range">${item.appearances
      ? `${item.appearances.toLocaleString()} appearances` : '&nbsp;'}</span>
  </div>
</article>`;

// Wikidata tells us what the relationship is; the UI never turns that into an
// internal route unless the matching ComicVine object already lives locally.
// A search fallback is honest and still gives a reader somewhere useful to go.
function loreChip(item, group) {
  const label = group === 'family' || group === 'affiliations'
    ? `${item.name}${item.relation ? ` · ${item.relation}` : ''}`
    : item.name;
  return item.thread
    ? `<button class="chip kicker" ${threadAttrs({ ...item.thread, name: item.name })}>${esc(label)}</button>`
    : `<button class="chip kicker" data-search="${esc(item.name)}">${esc(label)}</button>`;
}

function renderLore(slot, lore) {
  if (!slot.isConnected || !lore.available) { slot.remove(); return; }
  slot.innerHTML = `<section class="lore-profile">
    <div class="section-head"><span class="kicker no">${slot.dataset.loreNo}</span><h2>Lore</h2>
      <a class="kicker lore-source" href="https://www.wikidata.org/wiki/${encodeURIComponent(lore.entity)}"
        target="_blank" rel="noreferrer">Structured relationships from Wikidata ↗</a></div>
    ${lore.description ? `<p class="lore-summary">${esc(lore.description)}</p>` : ''}
    <div class="lore-groups">${lore.groups.map((group) => `<section class="lore-group">
      <span class="kicker">${esc(group.label)}</span>
      <div class="chips">${group.items.map((item) => loreChip(item, group.key)).join('')}</div>
    </section>`).join('')}</div>
  </section>`;
}

const relationshipChip = (item) => item.id
  ? `<button class="chip kicker" ${threadAttrs(item)}>${esc(item.name)}</button>`
  : `<button class="chip kicker" data-search="${esc(item.name)}">${esc(item.name)}</button>`;

// A changing team is not one definitive snapshot. Keep the curated core
// roster easy to scan, but do not erase the much longer historical list just
// because it does not fit above the fold.
function memberRoster(items, initial = 12) {
  if (!items?.length) return '';
  return `<div class="member-roster"><div class="chips">${items.map((item, index) =>
    `<span${index >= initial ? ' hidden' : ''}>${relationshipChip(item)}</span>`).join('')}</div>
    ${items.length > initial ? `<button class="request-unfurl kicker" data-unfurl-roster
      data-roster-initial="${initial}" data-roster-total="${items.length}">
      Show all ${items.length} members ↓</button>` : ''}</div>`;
}

routes.threads = async () => {
  view.innerHTML = `${lede('threads', {
      kicker: 'Characters &amp; creators',
      title: 'Follow a <em>person</em>,<br />not an issue number.',
      body: 'Characters, creators, teams and the events that cross between them. Open one to see the books it is credited on.',
    })}${skeletonRail(7)}`;

  const { groups } = await api('/api/threads/browse');
  // Seeded well-known names arrive after the local list is on screen, so the
  // page is never blocked on ComicVine and degrades to "what you've explored".
  const seedable = ['character', 'person', 'team', 'story_arc'];
  // Only characters keep a tail of whatever the catalogue happens to know.
  // For creators, teams and events that tail was the problem: a page of
  // jobbing inkers and acronym teams nobody has heard of, ahead of Stan Lee.
  const keepsLocalTail = new Set(['character']);
  if (!groups.length) {
    // An action, not an explanation of how the local catalogue fills up.
    view.innerHTML += `<div class="empty">
      <p>Nothing filed yet. Open a publisher and Panel will start learning who its
         characters and creators are.</p>
      <button class="secondary" data-route="browse">Browse publishers →</button>
    </div>`;
    return;
  }

  const aside = {
    Characters: 'Most published first',
    Creators: 'Writers and artists — the way into manga and creator-owned books',
    Teams: 'Groups read as one thing',
    Events: 'Crossovers running through several titles at once',
  };
  // Every seedable kind gets a section even when the catalogue knows nobody,
  // because the seeds are about to fill it.
  const shown = [...groups];
  for (const kind of seedable) {
    if (!shown.some((group) => group.kind === kind)) {
      shown.push({ kind, label: THREAD_KIND_LABELS[kind], items: [] });
    }
  }
  const order = ['character', 'person', 'team', 'story_arc'];
  shown.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  view.innerHTML = view.querySelector('.lede').outerHTML + shown.map((group) => `
    <div class="section-head"><h2>${esc(group.label)}</h2>
      <span class="kicker aside">${esc(aside[group.label] || '')}</span></div>
    <div class="rail" data-thread-kind="${esc(group.kind)}">${
      group.items.map((item) => threadCard(item)).join('')
      || (seedable.includes(group.kind) ? skeletonCard.repeat(6) : '')}</div>`).join('');

  await Promise.all(seedable.map(async (kind) => {
    const rail = document.querySelector(`[data-thread-kind="${kind}"]`);
    if (!rail) return;
    const group = shown.find((entry) => entry.kind === kind);
    await seededRail(kind, rail, (items) => {
      // Curated names lead, the local catalogue follows. Local ordering for
      // teams and creators is "most recently cached", which surfaced R.A.I.D.
      // and a jobbing inker ahead of the X-Men and Alan Moore.
      const seen = new Set(items.map((item) => String(item.id)));
      const tail = keepsLocalTail.has(kind) || !items.length
        ? group.items.filter((item) => !seen.has(String(item.id)))
        : [];
      const merged = [...items, ...tail];
      rail.innerHTML = merged.length
        ? merged.map((item) => threadCard(item)).join('')
        : '<div class="empty">Nothing here yet — open a book and its credits will fill this in.</div>';
    });
  }));
};

routes.decade = async (decadeArg, pageArg) => {
  const decade = Number(decadeArg);
  const page = Math.max(1, Number(pageArg) || 1);
  view.innerHTML = `${breadcrumb([crumbBrowse, { label: `${decade}s` }])}${skeletons(12)}`;
  await loadShelf().catch(() => {});
  const data = await api(`/api/decade/${decade}/volumes?page=${page}&size=${pageSize()}`);
  const shown = applyContentFilter(data.items);
  const pager = (position) => `
    <div class="pager ${position}">
      ${page > 1 ? `<button class="kicker" data-decade-page="${page - 1}">← Previous</button>` : '<span></span>'}
      <span class="kicker">Page ${page.toLocaleString()} of ${data.pages.toLocaleString()}
        · ${data.total.toLocaleString()} titles</span>
      ${page < data.pages ? `<button class="kicker" data-decade-page="${page + 1}">Next →</button>` : '<span></span>'}
    </div>`;
  view.innerHTML = `
    ${breadcrumb([crumbBrowse, { label: `${decade}s` }])}
    <div class="pub-head" style="grid-template-columns:1fr">
      <div>
        <span class="kicker" style="color:var(--accent)">Era</span>
        <h1 class="disp">${decade}s</h1>
        ${data.label ? `<p class="deck">${esc(data.label)}</p>` : ''}
        <div class="stats" style="border-top:0;margin-top:18px;padding-top:0">
          <div><span class="kicker">Titles</span><b class="disp">${data.total.toLocaleString()}</b></div>
        </div>
      </div>
    </div>
    ${filterBar(data.items.length, shown.length)}
    ${pager('top')}
    <div class="grid">${shown.map(volumeCard).join('')}</div>
    ${pager('bottom')}`;
  state.decade = { decade, page };
};

routes.publisher = async (encoded, pageArg) => {
  const name = decodeURIComponent(encoded || '');
  const page = Math.max(1, Number(pageArg) || 1);
  const slug = name.replace(/\W+/g, '');

  view.innerHTML = `<section class="lede" style="border:0;padding-bottom:20px">
      <span class="kicker" style="color:var(--accent)">Publisher</span>
      <h1>${esc(name)}</h1>
    </section>${skeletons(12)}`;

  const [houses] = await Promise.all([api('/api/publishers'), loadShelf().catch(() => {})]);
  const house = houses.items.find((h) => h.name === name) ?? { name, lines: [], logo: null };
  const data = await api(`/api/publisher/${encodeURIComponent(name)}/volumes?page=${page}&size=${pageSize()}`);

  const pager = (position) => `
    <div class="pager ${position}">
      ${page > 1 ? `<button class="kicker" data-page="${page - 1}">← Previous</button>` : '<span></span>'}
      <span class="kicker">Page ${page.toLocaleString()} of ${data.pages.toLocaleString()}
        · ${data.total.toLocaleString()} titles</span>
      ${page < data.pages ? `<button class="kicker" data-page="${page + 1}">Next →</button>` : '<span></span>'}
    </div>`;

  view.innerHTML = `
    ${breadcrumb([crumbBrowse, { label: name }])}
    <div class="pub-head">
      ${house.logo ? `<div class="pub-logo"><img src="${esc(house.logo)}" alt="${esc(name)}" /></div>` : ''}
      <div>
        <span class="kicker" style="color:var(--accent)">Publisher</span>
        <h1 class="disp">${esc(name)}</h1>
        ${house.deck ? `<p class="deck">${esc(house.deck)}</p>` : ''}
        <div class="stats" style="border-top:0;margin-top:18px;padding-top:0">
          <div><span class="kicker">Titles</span><b class="disp">${data.total.toLocaleString()}</b></div>
          <div><span class="kicker">Lines</span><b class="disp">${house.lines.length}</b></div>
        </div>
      </div>
    </div>

    ${house.lines.length ? `
      <div class="section-head"><span class="kicker no">01</span><h2>Universes &amp; imprints</h2>
        <span class="kicker aside">${info('imprint', 'right')}</span></div>
      <div class="chips">${house.lines.map((line) => `
        <button class="chip kicker" data-search="${esc(`${name} ${line}`)}">${esc(line)}</button>`).join('')}</div>` : ''}

    <div id="pub-chars-${slug}"></div>
    <div id="pub-teams-${slug}"></div>

    <div class="section-head"><span class="kicker no">04</span><h2>All titles</h2>
      <div class="aside filters" style="border:0;padding:0;grid-template-columns:auto">${perPageSelect('pub-size')}</div></div>
    ${data.source === 'local-cache'
      ? '<p class="sort-note kicker">ComicVine is temporarily unavailable. Showing the saved local catalogue, not the publisher’s full list.</p>'
      : ''}
    ${filterBar(data.items.length, applyContentFilter(data.items).length)}
    ${pager('top')}
    <div class="grid">${applyContentFilter(data.items).map(volumeCard).join('')}</div>
    ${pager('bottom')}`;

  state.publisher = { name, page, pages: data.pages };

  // Characters and teams load behind the catalogue: each is several searches,
  // and the books are what the page is for.
  const strip = (slot, no, title, aside, endpoint, ratio) => {
    slot.innerHTML = `<div class="section-head"><span class="kicker no">${no}</span><h2>${title}</h2>
      <span class="kicker aside">${aside}</span></div><div class="rail">${skeletonCard.repeat(7)}</div>`;
    api(endpoint)
      .then(({ items }) => {
        if (!items.length) { slot.innerHTML = ''; return; }
        slot.innerHTML = `<div class="section-head"><span class="kicker no">${no}</span><h2>${title}</h2>
            <span class="kicker aside">${aside}</span></div>
          <div class="rail">${items.slice(0, 16).map((t) => `
            <article class="card">
              <button ${threadAttrs(t)} style="all:unset;cursor:pointer">
                ${coverHtml({ id: t.id, name: t.name, image: t.image }, { ratio })}
              </button>
              <div class="meta"><h3>${esc(t.name)}</h3>
                ${/* ComicVine reports no appearance count for teams; an unqualified
                      "0 appearances" reads as a fact rather than a missing field. */ ''}
                ${t.appearances ? `<span class="sub">${t.appearances.toLocaleString()} appearances</span>` : ''}</div>
            </article>`).join('')}</div>`;
      })
      .catch(() => { slot.innerHTML = ''; });
  };
  strip(document.querySelector(`#pub-chars-${slug}`), '02', 'Characters', 'Most published first',
        `/api/publisher/${encodeURIComponent(name)}/characters`, '2 / 3');
  strip(document.querySelector(`#pub-teams-${slug}`), '03', 'Teams', 'Groups and line-ups',
        `/api/publisher/${encodeURIComponent(name)}/teams`, '2 / 3');
};

/* ---------------- search ---------------- */

routes.search = async (encoded, scoped) => {
  const query = decodeURIComponent(encoded || '');
  state.scope = scoped ? decodeURIComponent(scoped) : '';
  searchInput.value = query;
  view.innerHTML = `<section class="lede" style="border:0;padding-bottom:24px">
      <span class="kicker" style="color:var(--accent)">Search</span>
      <h1>Results for <em>“${esc(query)}”</em></h1>
    </section>
    ${state.scope ? `<div class="chips" style="padding-bottom:18px">
      <span class="chip kicker">Within ${esc(state.scope)}</span></div>` : ''}
    <div id="threads"></div>
    <div id="books">${skeletons(10)}</div>`;

  // Threads first: they are how you get into the graph, and they answer a
  // different question from "which book is this".
  api(`/api/threads?q=${encodeURIComponent(query)}${state.scope ? `&publisher=${encodeURIComponent(state.scope)}` : ''}`)
    .then(({ groups }) => {
    const el = document.querySelector('#threads');
    if (!groups?.length) return;
    el.innerHTML = groups.map((group) => `
      <div class="section-head"><h2>${esc(group.label)}</h2></div>
      <div class="rail">${group.items.map((t) => `
        <article class="card">
          <button ${threadAttrs(t)} style="all:unset;cursor:pointer">
            ${coverHtml({ id: t.id, name: t.name, image: t.image }, { ratio: '2 / 3' })}
          </button>
          <div class="meta"><h3>${esc(t.name)}</h3>
            <span class="sub">${esc(t.publisher || group.label)}</span></div>
        </article>`).join('')}</div>`).join('');
  }).catch(() => {});

  const books = document.querySelector('#books');
  try {
    await loadShelf().catch(() => {});
    state.query = query;
    // Search keeps its own richer filter row, but it opens on whatever standing
    // choice the reader made elsewhere rather than resetting to "all".
    const standing = contentFilter();
    state.filters = { ...standing, publisher: 'all', sort: 'relevance', ...(state.pendingFilters ?? {}) };
    state.pendingFilters = null;
    books.innerHTML = `<div class="section-head"><h2>Titles</h2>
        <span class="kicker aside" id="count"></span></div>
      <div class="filters" id="filters"></div>
      <p class="sort-note kicker" id="sort-note"></p>
      <div id="results">${skeletons(10)}</div>`;
    await loadBooks();
  } catch (error) {
    books.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
};

// The format filter is a query, not a view filter: ComicVine ranks collected
// editions so low that searching "spider-man" surfaces exactly one omnibus on
// its first page, so asking for the format has to reach the API.
async function loadBooks() {
  const results = document.querySelector('#results');
  results.innerHTML = skeletons(10);
  const format = state.filters.format;
  const medium = state.filters.medium;
  const url = `/api/search?q=${encodeURIComponent(state.query)}&size=${pageSize()}`
    + (format && format !== 'all' ? `&edition=${encodeURIComponent(format)}` : '')
    + (medium && medium !== 'all' ? `&medium=${encodeURIComponent(medium)}` : '')
    + (state.scope ? `&publisher=${encodeURIComponent(state.scope)}` : '');
  try {
    const data = await api(url);
    state.results = data.items;
    state.editions = data.editions ?? [];
    renderFilters();
    renderResults();
  } catch (error) {
    results.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function renderFilters() {
  const publishers = [...new Set(state.results.map((x) => x.publisher).filter(Boolean))].sort();
  // Every format the classifier knows, not just the ones this page happened to
  // return -- otherwise the list shrinks to three the moment a search is narrow.
  const editions = state.editions.length
    ? state.editions
    : [...new Set(state.results.map((x) => x.edition).filter(Boolean))];
  const select = (key, label, options) => `<label><span class="kicker">${label}</span>
    <select data-filter="${key}">${options.map(([v, t]) =>
      `<option value="${esc(v)}"${state.filters[key] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  document.querySelector('#filters').innerHTML =
    select('medium', `Kind ${info('manga')}`, [['all', 'Comics & manga'], ['comic', 'Comics only'], ['manga', 'Manga only']]) +
    select('format', `Format ${info('collected edition')}`, [['all', 'All formats'], ...editions.map((e) => [e, e])]) +
    select('publisher', 'Publisher', [['all', 'All publishers'], ...publishers.map((p) => [p, p])]) +
    select('sort', `Sort ${info('notability')}`, [
      ['relevance', 'Best match'],
      ['notable', 'Most notable'],
      ['newest', 'Newest'],
      ['issues', 'Most issues'],
      ['title', 'A–Z'],
    ]) +
    perPageSelect('search-size');
}

// Says plainly where the order comes from. ComicVine has no ratings, so any
// ordering beyond text matching is ours and should be labelled as ours.
const SORT_NOTES = {
  relevance: 'Exact titles, every requested word, publisher and year first; <b>notability</b> only breaks ties.',
  notable: 'Ranked by <b>notability</b> — our own measure, not a reader rating.',
  newest: 'Most recently started series first.',
  issues: 'Longest runs first.',
  title: 'Alphabetical.',
};

function renderResults() {
  const { publisher, sort } = state.filters;
  const note = document.querySelector('#sort-note');
  if (note) {
    note.innerHTML = (SORT_NOTES[sort] || '')
      .replace('<b>notability</b>', term('notability', 'notability'));
  }
  // Format is applied server-side by loadBooks(); only publisher narrows here.
  let list = state.results.filter((x) => publisher === 'all' || x.publisher === publisher);
  // "Best match" is text relevance first, then notability — how well known the
  // publisher is and how substantial the book is. Without that tiebreak a search
  // for a character returns long-running foreign reprints ahead of the real run,
  // because they all match the name exactly and reprints have more issues.
  if (sort === 'notable') list = [...list].sort((a, b) => (b.notability || 0) - (a.notability || 0));
  if (sort === 'newest') list = [...list].sort((a, b) => (b.year || 0) - (a.year || 0));
  if (sort === 'issues') list = [...list].sort((a, b) => b.issues - a.issues);
  if (sort === 'title') list = [...list].sort((a, b) => a.title.localeCompare(b.title));
  document.querySelector('#count').textContent = `${list.length} of ${state.results.length}`;
  // #results is a plain container so it can hold either a skeleton grid or the
  // real one; the grid class has to come from whichever is being rendered.
  document.querySelector('#results').innerHTML = list.length
    ? `<div class="grid">${list.map(volumeCard).join('')}</div>`
    : '<div class="empty">Nothing matches those filters.</div>';
}

/* ---------------- thread ---------------- */

routes.thread = async (kind, id, encodedName) => {
  view.innerHTML = `<div class="thread">
      <div class="skeleton portrait" style="aspect-ratio:3/4"></div>
      <div>
        <div class="skeleton-line" style="width:38%"></div>
        <div class="skeleton-line" style="width:64%;height:56px;margin-top:16px"></div>
        <div class="skeleton-line" style="width:44%;margin-top:18px"></div>
        <div class="skeleton-line" style="width:90%;margin-top:30px"></div>
        <div class="skeleton-line" style="width:82%;margin-top:10px"></div>
      </div>
    </div>`;
  const fallbackName = encodedName ? decodeURIComponent(encodedName) : '';
  const nameQuery = fallbackName ? `?name=${encodeURIComponent(fallbackName)}` : '';
  const [thread] = await Promise.all([api(`/api/thread/${kind}/${id}${nameQuery}`), loadShelf().catch(() => {})]);
  // Real navigational ancestry for the volume sheet -- not a guess at which
  // character "owns" a book, which would be inventing a relationship.
  state.thread = { kind, id, name: thread.name, publisher: thread.publisher };
  const stat = (label, value) => value
    ? `<div><span class="kicker">${label}</span><b class="disp">${esc(value)}</b></div>` : '';
  // "Thread" is Panel's word for the tier, not the reader's. Say what this is.
  const kindLabel = { person: 'Creator', story_arc: 'Event', team: 'Team' }[thread.kind] || 'Character';
  // ComicVine's character-team field is both noisy and a subset of the
  // Wikidata affiliation graph below. Showing it first makes a character page
  // repeat itself and gives its weaker source the louder position. Teams still
  // need their own (lore-backed) line-up, so only character pages suppress it.
  const showNativeConnections = kind !== 'character' && thread.teams?.length;
  const hasHistoricMembers = kind === 'team' && thread.historicMembers?.length;
  const hasLore = kind === 'character' || kind === 'team';
  const loreNo = kind === 'character' ? '01' : hasHistoricMembers ? '03' : '02';
  const connectedNo = kind === 'character' ? '02' : kind === 'team'
    ? (hasHistoricMembers ? '04' : '03')
    : showNativeConnections ? '02' : '01';

  view.innerHTML = `
    ${breadcrumb([crumbBrowse, crumbPublisher(thread.publisher), { label: thread.name }])}
    <section class="thread">
      <div>${coverHtml({ id: thread.id, name: thread.name, image: thread.image }, { ratio: '3 / 4' })}</div>
      <div>
        <span class="kicker" style="color:var(--accent)">${esc(kindLabel)}</span>
        <h1>${esc(thread.name)}</h1>
        ${thread.realName || thread.aliases?.length
          ? `<div class="alias">${esc(thread.realName || thread.aliases.slice(0, 3).join(' · '))}</div>` : ''}
        <div class="stats">
          ${stat('Appearances', thread.appearances ? thread.appearances.toLocaleString() : '')}
          ${stat('Publisher', thread.publisher)}
          ${stat('First seen', thread.firstAppearance)}
        </div>
        ${thread.deck ? `<p class="deck">${esc(thread.deck)}</p>` : ''}
      </div>
    </section>
    ${/* The only native relationship strip left is a team's line-up. Character
           affiliations are rendered by the stronger Wikidata profile below. */ ''}
    ${showNativeConnections ? `
      <div class="section-head"><span class="kicker no">01</span>
        <h2>${kindLabel === 'Team' ? 'Core roster' : 'Also appears with'}</h2>
        <span class="kicker aside">${kindLabel === 'Team'
          ? 'Verified relationships from Wikidata' : 'Teams and groups'}</span></div>
      ${kindLabel === 'Team' ? memberRoster(thread.teams) : `<div class="chips">${thread.teams.map(relationshipChip).join('')}</div>`}
      ${thread.lineUpSource === 'lore'
        ? '<p class="sort-note kicker">Wikidata supplies the core roster. Open a member for their own lore and credited books.</p>'
        : ''}` : ''}
    ${hasHistoricMembers ? `
      <div class="section-head"><span class="kicker no">02</span><h2>Recorded members</h2>
        <span class="kicker aside">Across different eras</span></div>
      <p class="sort-note kicker">ComicVine’s wider, time-spanning list — useful for finding people such as Jubilee and Rogue, but not presented as one current line-up.</p>
      ${memberRoster(thread.historicMembers)}` : ''}
    ${hasLore ? `<div id="thread-lore" data-lore-no="${loreNo}"></div>` : ''}
    <div class="section-head"><span class="kicker no">${connectedNo}</span>
      <h2>Connected books</h2><span class="kicker aside">Actual saved ComicVine credits</span></div>
    <div id="thread-books">${skeletons(12)}</div>`;

  // This is intentionally after the profile paint: Wikidata enriches a
  // character, it does not decide whether the page is usable. Its direct
  // relationships then open familiar Panel pages when known, or search when
  // Panel has not learned that person/team yet.
  if (hasLore) {
    const loreSlot = document.querySelector('#thread-lore');
    api(`/api/thread/${kind}/${id}/lore`)
      .then((lore) => { if (loreSlot) renderLore(loreSlot, lore); })
      .catch(() => { if (loreSlot?.isConnected) loreSlot.remove(); });
  }

  // Do not approximate a relationship with a title search. These are volumes
  // where the saved ComicVine detail actually credits this creator/character.
  api(`/api/thread/${kind}/${id}/volumes`)
    .then(({ items, source }) => {
      // Say plainly when the list is derived from the line-up rather than from
      // credits on the team itself.
      const note = source === 'team-series-and-line-up'
        ? '<p class="sort-note kicker">This shelf alternates X-Men series found by title with books carrying saved credits for core members. The two paths are shown together, not conflated.</p>'
        : source === 'team-series'
          ? '<p class="sort-note kicker">ComicVine files no credits against this team, so these are series found by the team name.</p>'
          : source === 'line-up'
            ? '<p class="sort-note kicker">ComicVine files no credits against a team, so this shelf uses books carrying saved credits for core members.</p>'
            : '';
      const shown = applyContentFilter(items);
      document.querySelector('#thread-books').innerHTML = items.length
        ? `${note}${filterBar(items.length, shown.length)}<div class="grid">${shown.map(volumeCard).join('')}</div>`
        : filterActive()
        ? `${filterBar(0, 0)}<div class="empty">No ${esc(contentFilter().format === 'all' ? 'matching' : contentFilter().format.toLowerCase())} books here. <button class="secondary" data-clear-filter>Clear filter</button></div>`
        : `<div class="empty">Panel has not saved any credited books for ${esc(thread.name)} yet. Open a title or search for one to enrich this path; it will never guess from a keyword.</div>`;
    })
    .catch(() => { document.querySelector('#thread-books').innerHTML = '<div class="empty">Could not load saved relationships.</div>'; });
};

/* ---------------- library ---------------- */

// A watchlisted run can be a hundred issues long. Show enough to read at a
// glance and let the reader unfurl the rest.
const REQUEST_PARTS_SHOWN = 6;

// Mylar only knows a part as "Volume 2". ComicVine usually has the real title
// and a sentence about the book, so fetch that per series after first paint --
// the requests list must not wait on it, and it degrades to Mylar's naming.
async function hydrateRequestParts(comicIds) {
  await Promise.all([...new Set(comicIds)].map(async (comicId) => {
    let items;
    try { ({ items } = await api(`/api/volume/${encodeURIComponent(comicId)}/issues`)); }
    catch { return; }
    if (!items?.length) return;
    const slot = document.querySelector(`[data-parts-for="${CSS.escape(String(comicId))}"]`);
    if (!slot) return;
    const byNumber = new Map(items.map((item) => [String(item.number), item]));
    for (const title of slot.querySelectorAll('[data-part-title]')) {
      const meta = byNumber.get(title.dataset.partTitle);
      if (!meta) continue;
      // Only replace Mylar's naming when ComicVine actually adds something.
      if (meta.name && !/^(?:volume|part|issue)\s*\d+$/i.test(meta.name)) {
        title.textContent = meta.name;
      }
      const blurb = slot.querySelector(`[data-part-blurb="${CSS.escape(title.dataset.partTitle)}"]`);
      if (blurb && meta.blurb) blurb.textContent = meta.blurb;
    }
  }));
}

routes.library = async () => {
  view.innerHTML = `<section class="lede" style="border:0"><span class="kicker" style="color:var(--accent)">Your shelf</span>
    <h1>What you asked for,<br />and what <em>arrived</em>.</h1></section>${skeletons(1, '1fr')}`;
  const [{ items, counts, komga }, activity] = await Promise.all([loadShelf(), api('/api/requests')]);
  const requestState = (status) => ({ Wanted: 'Queued', Snatched: 'Snatched', Downloaded: 'Downloaded', Archived: 'In library', Failed: 'Needs attention', Skipped: 'Not requested' }[status] || status);
  const groups = [...activity.items.reduce((map, part) => {
    const key = part.comicId;
    if (!map.has(key)) map.set(key, { comicId: key, series: part.series, publisher: part.publisher, year: part.year, parts: [] });
    map.get(key).parts.push(part); return map;
  }, new Map()).values()];
  view.innerHTML = `
    ${lede('library', {
      kicker: 'Your shelf',
      title: 'What you asked for,<br />and what <em>arrived</em>.',
    })}
    <div class="stats" style="border-top:0;margin:0 0 26px;padding-top:0">
      <div><span class="kicker">Requested</span><b class="disp">${counts.watching}</b></div>
      <div><span class="kicker">In library ${info('in library')}</span><b class="disp" style="color:var(--shelf)">${counts.inLibrary}</b></div>
      <div><span class="kicker">Still searching ${info('searching')}</span><b class="disp" style="color:var(--accent)">${counts.searching}</b></div>
    </div>
    ${activity.items.length ? `<section class="request-activity">
      <div class="section-head"><span class="kicker no">01</span><h2>Requests</h2>
        <span class="kicker aside">${activity.counts.snatched} snatched · ${activity.counts.wanted} queued · ${activity.counts.failed} need attention</span>
        <button class="secondary" data-refresh-requests>Refresh from Mylar</button></div>
      <p class="request-explainer">Panel queues only the parts you selected. Mylar searches your indexers; <em>Snatched</em> means it reached the download client, and Komga marks it readable after import.</p>
      <div class="request-center">${groups.map((group) => `<article class="request-series">
        ${/* Mylar's comic id is the ComicVine volume id, so the cover Panel
               already has on disk is addressable. coverHtml falls back to the
               title tile if there is no art. */ ''}
        <div class="request-series-head">
          <button class="request-series-cover" data-volume="${esc(group.comicId)}" aria-label="${esc(group.series)}">
            ${coverHtml({ id: group.comicId, title: group.series, cover: `/api/cover/${encodeURIComponent(group.comicId)}` })}
          </button>
          <div><span class="kicker">Mylar watchlist</span><h3>${esc(group.series)}</h3><p>${esc([group.publisher, group.year].filter(Boolean).join(' · '))}</p></div>
          <button class="secondary" data-request="${esc(group.comicId)}">Manage parts</button></div>
        ${/* A watchlisted run can carry a hundred parts. Show a readable
               handful and let the reader unfurl the rest. */ ''}
        <div class="request-parts" data-parts-for="${esc(group.comicId)}">${group.parts.map((part, index) => {
          const canRetry = !['Downloaded', 'Archived', 'Snatched'].includes(part.status);
          return `<div class="request-part${index >= REQUEST_PARTS_SHOWN ? ' extra' : ''}"${index >= REQUEST_PARTS_SHOWN ? ' hidden' : ''}>
            <div><span class="kicker">${esc(part.number || '—')}</span>
              <b data-part-title="${esc(part.number || '')}">${esc(part.name || `Part ${part.number}`)}</b>
              <small data-part-blurb="${esc(part.number || '')}"></small></div>
            <div class="request-part-action"><span class="kicker state ${['Downloaded', 'Archived'].includes(part.status) ? 'owned' : part.status === 'Failed' ? 'attention' : ''}">${esc(requestState(part.status))}</span>
              ${canRetry ? `<button class="secondary" data-retry-part="${esc(part.comicId)}/${esc(part.issueId)}">${part.status === 'Failed' ? 'Retry now' : 'Search again'}</button>` : ''}</div></div>`;
        }).join('')}</div>
        ${group.parts.length > REQUEST_PARTS_SHOWN ? `<button class="request-unfurl kicker" data-unfurl="${esc(group.comicId)}">
          Show all ${group.parts.length} parts ↓</button>` : ''}
      </article>`).join('')}</div>
    </section>` : `<section class="request-activity"><div class="section-head"><span class="kicker no">01</span><h2>Requests</h2></div><div class="empty">Choose a specific issue or volume and it will appear here with Mylar’s progress.</div></section>`}
    ${komga ? '' : '<p class="kicker" style="color:var(--accent);padding-bottom:14px">Komga is not connected — every title will read as searching.</p>'}
    <div class="index">${items.map((item, i) => `
      <div class="row">
        <span class="kicker" style="color:var(--faint)">${String(i + 1).padStart(2, '0')}</span>
        <div class="thumb">${coverHtml(item)}</div>
        <div>
          <div class="title">${esc(item.title)}</div>
          <span class="kicker">${esc(item.publisher || '')}${item.year ? ` · ${esc(item.year)}` : ''}</span>
        </div>
        <span class="kicker state ${item.inLibrary ? 'owned' : ''}">${esc(item.state)}${
          item.books ? ` · ${item.books}` : ''}</span>
      </div>`).join('')}</div>`;

  // After paint, never before it.
  if (groups.length) hydrateRequestParts(groups.map((group) => group.comicId));
};

/* ---------------- settings ---------------- */

const healthState = (available, ready, missing) => available ? ready : missing;

routes.settings = async () => {
  view.innerHTML = `<section class="lede settings-lede"><span class="kicker" style="color:var(--accent)">Panel preferences</span>
    <h1>Make the reading room<br /><em>your own.</em></h1>
    <p>These preferences only change Panel. Your Mylar, Komga and downloader setup stays untouched.</p>
  </section><div class="empty">Loading connection status…</div>`;
  const health = await api('/api/health');
  const cache = health.cache ?? { entries: 0 };
  const rate = health.comicvine?.limited
    ? `Cooling down · retry in ${Math.ceil((health.comicvine.retryInSeconds || 0) / 60)} min`
    : 'Available';
  const metron = health.metron?.available ? 'Connected' : (health.metron?.reason || 'Not configured');
  const enrich = health.enrichment ?? cache.enrichment ?? { pending: 0, done: 0 };
  const starts = [['discover', 'Discover'], ['browse', 'Browse'], ['threads', 'Characters & creators'], ['library', 'My requests']];
  view.innerHTML = `
    ${lede('settings', {
      kicker: 'Panel preferences',
      title: 'Make the reading room<br /><em>your own.</em>',
      body: 'These preferences only change Panel. Your Mylar, Komga and downloader setup stays untouched.',
    })}
    <section class="settings-section"><div class="section-head"><span class="kicker no">01</span><h2>Display</h2><span class="kicker aside">Saved on this device</span></div>
      <div class="settings-grid">
        <label class="setting"><span class="kicker">Start on</span><select data-setting="start-page">${starts.map(([value, label]) => `<option value="${value}"${setting('start-page', 'discover') === value ? ' selected' : ''}>${label}</option>`).join('')}</select><small>The page Panel opens to when you return.</small></label>
        <label class="setting"><span class="kicker">Poster size</span><input data-setting="poster" type="range" min="110" max="320" step="10" value="${poster.value}" /><small>${poster.value}px wide · changes every shelf and search grid.</small></label>
        <label class="setting"><span class="kicker">Results per page</span><select data-setting="page-size">${PAGE_SIZES.map((n) => `<option value="${n}"${n === pageSize() ? ' selected' : ''}>${n}</option>`).join('')}</select><small>Applies to publisher and search result pages.</small></label>
        <label class="setting toggle"><input data-setting="reduce-motion" type="checkbox"${settingOn('reduce-motion') ? ' checked' : ''} /><span><b>Reduce motion</b><small>Stops loading shimmer and other non-essential movement.</small></span></label>
      </div>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">02</span><h2>Requests</h2><span class="kicker aside">Mylar remains the request manager</span></div>
      <div class="settings-grid request-settings">
        <div class="setting"><span class="kicker">Choose before requesting</span><b>Collections open a volume picker</b><small>For a multi-volume collection, choose individual parts or request all of them. Panel then queues only those parts in Mylar.</small></div>
        <div class="setting"><span class="kicker">What happens next</span><b>Mylar searches in the background</b><small>Mylar, Prowlarr and your download client decide when a selected part arrives. Komga scans it after import.</small></div>
      </div>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">03</span><h2>Connections</h2><span class="kicker aside">Read-only diagnostics</span></div>
      <div class="connection-grid">
        <article class="connection"><span class="kicker">Catalogue</span><b>ComicVine</b><p class="status ${health.comicvine?.limited ? 'warn' : 'good'}">${esc(rate)}</p><small>Metadata, covers, people and series discovery.</small></article>
        <article class="connection"><span class="kicker">Requests</span><b>Mylar</b><p class="status ${health.ok ? 'good' : 'warn'}">${health.ok ? 'Connected' : 'Unavailable'}</p><small>Watchlist and background searching.</small></article>
        <article class="connection"><span class="kicker">Library</span><b>Komga</b><p class="status ${health.komga ? 'good' : 'warn'}">${healthState(health.komga, 'Connected', 'Not connected')}</p><small>Shows what has actually arrived on your shelf.</small></article>
        <article class="connection"><span class="kicker">Supplement</span><b>Metron</b><p class="status ${health.metron?.available ? 'good' : 'muted'}">${esc(metron)}</p><small>Optional story-arc data. No token is required for Panel to work.</small></article>
      </div>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">04</span><h2>Local catalogue</h2><span class="kicker aside">${(cache.volumes || 0).toLocaleString()} volumes · ${(cache.objects || 0).toLocaleString()} people & things · ${(cache.covers || 0).toLocaleString()} covers</span></div>
      <div class="cache-card"><div><b>Builds a local catalogue as you browse</b><p>Every ComicVine result Panel sees is kept in SQLite: volumes, characters, creators, teams, events and their known links. Repeat searches use local data first, then only ask ComicVine for information Panel has not learned yet.</p></div><button class="secondary" data-clear-cache>Clear response cache</button></div>
      <div class="cache-card enrichment-card"><div><b>Gentle enrichment is ${enrich.pending ? 'waiting' : 'caught up'}</b><p>${enrich.pending || 0} title${enrich.pending === 1 ? '' : 's'} queued · ${enrich.done || 0} enriched. Panel slowly fills in detail only for things you searched, opened, followed or requested. It pauses automatically when ComicVine rate-limits.</p></div></div>
      <p class="settings-note">Clearing response cache does not erase the local catalogue, its relationship links, requests, downloads or Mylar settings.</p>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">05</span><h2>Reset</h2></div>
      <div class="cache-card"><div><b>Reset this device’s Panel preferences</b><p>Returns the start page, poster size, page size and request confirmation to their defaults. Server data is unaffected.</p></div><button class="secondary" data-reset-preferences>Reset preferences</button></div>
    </section>`;
};

/* ---------------- volume sheet ---------------- */

async function openVolume(id) {
  sheetBody.innerHTML = `<div class="sheet-top"><span class="kicker">Volume</span></div>
    <div class="sheet-body">
      <div class="skeleton"></div>
      <div>
        <div class="skeleton-line" style="width:70%;height:34px"></div>
        <div class="skeleton-line" style="width:40%;margin-top:20px"></div>
        <div class="skeleton-line" style="width:92%;margin-top:24px"></div>
        <div class="skeleton-line" style="width:88%;margin-top:10px"></div>
        <div class="skeleton-line" style="width:64%;margin-top:10px"></div>
      </div>
    </div>`;
  sheet.showModal();
  try {
    const item = await api(`/api/volume/${id}`);
    const owned = item.requested || onShelf(item.id);
    const fromThread = location.hash.startsWith('#/thread/') ? state.thread : null;
    const isCollection = item.edition !== 'Series';
    // A regular run can be just as selective as a six-volume omnibus line.
    // Anything with more than one Mylar part gets a picker; the old one-click
    // series path made it impossible to ask for only issue #1.
    const canChooseParts = item.issues > 1;
    const partNoun = isCollection ? 'volume' : 'issue';
    const requestScope = !canChooseParts
      ? (isCollection ? 'queues this one book.' : 'queues this single issue.')
      : isCollection
        ? `queues all ${item.issues} volumes — uncheck any you do not want before confirming.`
        : `lets you pick individual issues out of ${item.issues}. Nothing is queued until you confirm.`;
    const explain = item.edition === 'Omnibus'
      ? 'An omnibus is one oversized book collecting a long run of issues — the whole story in a single volume.'
      : item.edition === 'Collected edition'
        ? 'A collected edition gathers a story arc or a handful of issues into one book.'
        : 'A regular series, collected issue by issue rather than as one book.';
    // ComicVine attaches cast to a volume/series record, not to every issue in
    // that run. State that evidence level in the sheet: a cover called X-Men
    // is not a claim that the named character appears in each individual issue.
    const relatedSection = (groups, heading) => groups?.length ? `<section class="sheet-related">
      <div class="section-head"><span class="kicker no">More</span><h2>${esc(heading)}</h2></div>
      <p class="sort-note kicker">ComicVine volume records list this credit; this is not an issue-by-issue appearance claim.</p>
      ${groups.map((group) => `<div class="related-group"><button class="chip kicker" ${threadAttrs(group)}>${esc(group.name)} · credited by ComicVine →</button>
        <div class="rail">${group.items.map(volumeCard).join('')}</div></div>`).join('')}
    </section>` : '';
    sheetBody.innerHTML = `
      <div class="sheet-top">
        <span class="kicker" style="color:var(--accent)">${esc(item.edition)} ${info(item.edition)}</span>
        <button id="close-sheet" aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M6 6l12 12M18 6L6 18"></path></svg>
        </button>
      </div>
      <div class="sheet-body">
        <div>${coverHtml(item, { flag: shelfFlag(item) })}</div>
        <div>
          ${/* The design canvas puts the chain on the screen where the reader
                 commits. The thread segment appears only when they actually
                 arrived from one. */ ''}
          ${breadcrumb([
            crumbPublisher(item.publisher),
            fromThread ? { label: fromThread.name, attr: threadAttrs(fromThread) } : null,
            { label: 'This volume' },
          ])}
          <h2>${esc(item.title)}</h2>
          <div class="stats" style="border-top:0;margin-top:18px;padding-top:0">
            ${item.publisher ? `<div><span class="kicker">Publisher</span><b class="disp">${esc(item.publisher)}</b></div>` : ''}
            ${item.year ? `<div><span class="kicker">Started</span><b class="disp">${esc(item.year)}</b></div>` : ''}
            ${item.issues ? `<div><span class="kicker">${isCollection ? 'Volumes' : 'Issues'}</span><b class="disp">${esc(item.issues)}</b></div>` : ''}
          </div>
          <p class="copy">${esc(item.description || 'ComicVine has no description for this listing.')}</p>
          <div class="plain"><span class="kicker" style="color:var(--accent)">In plain English</span>
            <p style="margin:6px 0 0;color:var(--body);line-height:1.6">${esc(explain)}</p></div>
          ${item.creators?.length ? `<div class="credits">
            <span class="kicker">Created by</span>
            <div class="chips">${item.creators.map((c) =>
              `<button class="chip kicker" ${threadAttrs({ kind: 'person', id: c.id, name: c.name })}>${esc(c.name)}</button>`).join('')}</div>
          </div>` : ''}
          ${item.characters?.length ? `<div class="credits">
            <span class="kicker">Featuring</span>
            <div class="chips">${item.characters.map((c) =>
              `<button class="chip kicker" ${threadAttrs({ kind: 'character', id: c.id, name: c.name })}>${esc(c.name)}</button>`).join('')}</div>
          </div>` : ''}
          ${/* One action, always called Request, with its scope stated underneath so
                 the reader knows what they are committing to before they commit.
                 The open-ended series watch is a separate, secondary choice --
                 it used to occupy this same slot without saying it behaved
                 differently forever. */ ''}
          <div class="actions">
            ${canChooseParts
              ? `<button class="primary" data-pick-parts="${esc(item.id)}" data-part-noun="${partNoun}" data-part-total="${esc(item.issues)}">Request</button>`
              : `<button class="primary" data-request-edition="${esc(item.id)}" ${owned ? 'disabled' : ''}>
                  ${owned ? (shelfFlag(item) || 'Requested') : 'Request'}
                 </button>`}
            ${isCollection ? '' : `<button class="secondary" data-request-watch="${esc(item.id)}">Follow this series</button>`}
            ${externalUrl(item.url) ? `<a class="kicker" href="${esc(externalUrl(item.url))}" target="_blank" rel="noreferrer">View on ComicVine ↗</a>` : ''}
          </div>
          <p class="action-scope"><b>Request</b> ${esc(requestScope)}${isCollection ? ''
            : ' <b>Follow this series</b> adds it to Mylar’s watchlist and keeps taking every future issue.'}</p>
          ${canChooseParts ? `<div id="collection-request" class="collection-request" data-part-noun="${partNoun}" data-collection="${isCollection}"></div>` : ''}
        </div>
      </div>
      ${relatedSection(item.related?.creators, 'Volume credits for these creators')}
      ${relatedSection(item.related?.characters, 'Volume credits for these characters')}`;
  } catch (error) {
    sheetBody.innerHTML = `<div class="sheet-top"><span class="kicker">${esc(error.message)}</span></div>`;
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function preparedParts(id, onProgress) {
  let options = await api(`/api/request/${id}/options`);
  if (options.tracked && options.parts.length) return options;
  if (!options.tracked) {
    onProgress('Adding this collection to Mylar…');
    await api(`/api/request/${id}/prepare`, { method: 'POST' });
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    onProgress(`Preparing its volume list in Mylar… ${attempt + 1}/20`);
    await pause(1_500);
    options = await api(`/api/request/${id}/options`);
    if (options.tracked && options.parts.length) return options;
  }
  throw new Error('Mylar has not finished importing this collection yet. Leave it on the watchlist and try again shortly.');
}

function partName(part, noun = 'part') {
  const number = part.number ? `${noun[0].toUpperCase()}${noun.slice(1)} ${part.number}` : `Untitled ${noun}`;
  return part.name ? `${number} · ${part.name}` : number;
}

function renderPartPicker(id, options) {
  const slot = document.querySelector('#collection-request');
  if (!slot) return;
  const noun = slot.dataset.partNoun || 'part';
  const parts = [...options.parts].sort((a, b) => Number(a.number) - Number(b.number));
  // On a collected edition the run is the product: the reader said "Request" to
  // get here, so the whole thing starts selected and this step is subtraction.
  // A single-issue series is the opposite -- picking issues is inherently
  // selective, and "I want all of it" is what Follow this series means. Either
  // way the head copy says which it is, so the default is never a surprise.
  const preselect = slot.dataset.collection === 'true';
  slot.innerHTML = `<section class="part-picker">
    <div class="part-picker-head"><span class="kicker" style="color:var(--accent)">${preselect ? 'Confirm' : 'Choose'} ${esc(noun)}s</span>
      <p>${preselect
        ? `All ${parts.filter((part) => part.requestable).length} selected. Uncheck anything you want to skip.`
        : `Pick the ${esc(noun)}s you want. To take every future one instead, use <b>Follow this series</b>.`}</p></div>
    <div class="part-list">${parts.map((part) => `<label class="part-row ${part.requestable ? '' : 'done'}">
      <input type="checkbox" data-part-number="${esc(part.number)}" ${part.requestable ? (preselect ? 'checked' : '') : 'disabled'} />
      <span><b>${esc(partName(part, noun))}</b><small>${esc(part.status === 'Skipped' ? 'Not requested yet' : part.status)}</small></span>
    </label>`).join('')}</div>
    <div class="actions">
      <button class="primary" data-request-parts="${esc(id)}">Request selected</button>
      <button class="secondary" data-clear-parts>Clear</button>
      <button class="secondary" data-select-all-parts>Select all</button>
      <span class="kicker" data-part-count></span>
    </div>
  </section>`;
  refreshPartSelection();
}

async function openPartPicker(id, button) {
  const slot = document.querySelector('#collection-request');
  if (!slot) return;
  button.disabled = true;
  const noun = button.dataset.partNoun || 'part';
  try {
    const options = await api(`/api/request/${id}/options`);
    // When Mylar has not seen this series yet, ComicVine's known part count is
    // enough to let the reader decide. Mylar is only involved after Request
    // selected, not as an awkward preliminary step.
    if (!options.tracked || !options.parts.length) {
      const total = Math.min(500, Math.max(2, Number(button.dataset.partTotal) || 2));
      options.parts = Array.from({ length: total }, (_, index) => ({
        number: String(index + 1), name: null, status: 'Ready to request', requestable: true,
      }));
    }
    renderPartPicker(id, options);
  } catch (error) {
    button.disabled = false;
    slot.innerHTML = `<p class="kicker" style="color:var(--accent)">${esc(error.message)}</p>`;
  }
}

function refreshPartSelection() {
  const selected = [...document.querySelectorAll('[data-part-number]:checked')];
  const action = document.querySelector('[data-request-parts]');
  const count = document.querySelector('[data-part-count]');
  const noun = document.querySelector('#collection-request')?.dataset.partNoun || 'part';
  if (action) action.disabled = !selected.length;
  if (count) count.textContent = selected.length
    ? `${selected.length} ${noun}${selected.length === 1 ? '' : 's'} selected`
    : `Choose one or more ${noun}s`;
}

async function queueSelectedParts(id, button) {
  const partNumbers = [...document.querySelectorAll('[data-part-number]:checked')].map((input) => input.dataset.partNumber);
  if (!partNumbers.length) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Requesting…';
  try {
    const result = await api(`/api/request/${id}/parts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partNumbers }),
    });
    if (result.pending) {
      button.disabled = false;
      button.textContent = 'Try selected again';
      toast(result.message || 'Mylar is still preparing this series.');
      return;
    }
    button.textContent = result.queued ? `Requested ${result.queued}` : 'Already requested';
    toast(result.queued
      ? `${result.queued} selected volume${result.queued === 1 ? '' : 's'} added to Mylar.`
      : 'Those selected volumes were already being handled by Mylar.');
    loadShelf().catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error.message, 'error');
  }
}

async function requestEdition(id, button) {
  const original = button.textContent.trim();
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const options = await preparedParts(id, (message) => { button.textContent = message.startsWith('Adding') ? 'Adding to Mylar…' : 'Preparing…'; });
    const part = options.parts.find((item) => item.requestable);
    if (!part) throw new Error('Mylar already has this edition queued or downloaded.');
    await api(`/api/request/${id}/parts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partNumbers: [part.number] }),
    });
    button.textContent = 'Requested';
    button.classList.add('owned');
    toast('Added to Mylar. It searches your indexers in the background.');
    loadShelf().catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error.message, 'error');
  }
}

async function addSeriesToMylar(id, button) {
  const original = button.textContent.trim();
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    await api('/api/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    button.textContent = 'Added to Mylar';
    button.classList.add('owned');
    toast('Added to Mylar’s watchlist. Its current and future issues will be handled there.');
    loadShelf().catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error.message, 'error');
  }
}

async function retryPart(comicId, issueId, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    await api(`/api/request/${encodeURIComponent(comicId)}/part/${encodeURIComponent(issueId)}/retry`, { method: 'POST' });
    toast('Mylar is searching that exact part again.');
    render();
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error.message, 'error');
  }
}

/* ---------------- events ---------------- */

document.addEventListener('click', async (event) => {
  const unfurlRoster = event.target.closest('[data-unfurl-roster]');
  if (unfurlRoster) {
    const roster = unfurlRoster.closest('.member-roster');
    const initial = Number(unfurlRoster.dataset.rosterInitial) || 12;
    const total = Number(unfurlRoster.dataset.rosterTotal) || 0;
    const expanded = unfurlRoster.dataset.expanded === 'true';
    roster?.querySelectorAll('.chips > span').forEach((item, index) => {
      item.hidden = expanded && index >= initial;
    });
    unfurlRoster.dataset.expanded = String(!expanded);
    unfurlRoster.textContent = expanded ? `Show all ${total} members ↓` : 'Show fewer members ↑';
    return;
  }
  const clearCacheButton = event.target.closest('[data-clear-cache]');
  if (clearCacheButton) {
    if (!window.confirm('Clear Panel’s short-lived response cache? Your local catalogue, requests and library are not affected.')) return;
    clearCacheButton.disabled = true;
    clearCacheButton.textContent = 'Clearing…';
    try { await api('/api/cache/clear', { method: 'POST' }); toast('Catalogue cache cleared.'); render(); }
    catch (error) { clearCacheButton.disabled = false; clearCacheButton.textContent = 'Clear response cache'; toast(error.message, 'error'); }
    return;
  }
  const resetPreferences = event.target.closest('[data-reset-preferences]');
  if (resetPreferences) {
    if (!window.confirm('Reset Panel preferences on this device?')) return;
    try {
      ['start-page', 'reduce-motion', 'confirm-requests', 'poster', 'pagesize'].forEach((key) => localStorage.removeItem(`panel:${key}`));
      // Resetting preferences replays the page introductions too.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('panel:seen:')) localStorage.removeItem(key);
      }
    } catch { /* private mode */ }
    setPoster(150); setPageSize(48); applyAccessibility(); toast('Panel preferences reset.'); render();
    return;
  }
  // The ⓘ is a button inside clickable cards; it explains, it does not navigate.
  if (event.target.closest('.info')) { event.preventDefault(); event.stopPropagation(); return; }
  const thread = event.target.closest('[data-thread]');
  if (thread) {
    const name = thread.dataset.threadName;
    return go(`/thread/${thread.dataset.thread}${name ? `/${encodeURIComponent(name)}` : ''}`);
  }
  const hub = event.target.closest('[data-hub]');
  if (hub) return go(`/hub/${encodeURIComponent(hub.dataset.hub)}`);
  const search = event.target.closest('[data-search]');
  if (search) {
    const scope = search.dataset.publisher ? `/${encodeURIComponent(search.dataset.publisher)}` : '';
    return go(`/search/${encodeURIComponent(search.dataset.search)}${scope}`);
  }
  const house = event.target.closest('[data-publisher]');
  if (house) return go(`/publisher/${encodeURIComponent(house.dataset.publisher)}`);
  const era = event.target.closest('[data-decade]');
  if (era) return go(`/decade/${encodeURIComponent(era.dataset.decade)}`);
  const eraPage = event.target.closest('[data-decade-page]');
  if (eraPage && state.decade) return go(`/decade/${state.decade.decade}/${eraPage.dataset.decadePage}`);
  const fmt = event.target.closest('[data-format]');
  if (fmt) {
    state.pendingFilters = { format: fmt.dataset.format };
    return go(`/search/${encodeURIComponent(fmt.dataset.format.toLowerCase())}`);
  }
  const pageBtn = event.target.closest('[data-page]');
  if (pageBtn && state.publisher) {
    return go(`/publisher/${encodeURIComponent(state.publisher.name)}/${pageBtn.dataset.page}`);
  }
  const volume = event.target.closest('[data-volume]');
  if (volume) return openVolume(volume.dataset.volume);
  const req = event.target.closest('[data-request]');
  // A card never performs a blind request. Open the detail sheet so a reader
  // sees whether this is a one-off edition, a multi-volume picker, or a series.
  if (req && !req.disabled) return openVolume(req.dataset.request);
  const refreshRequests = event.target.closest('[data-refresh-requests]');
  if (refreshRequests && !refreshRequests.disabled) {
    refreshRequests.disabled = true;
    refreshRequests.textContent = 'Refreshing…';
    try { await api('/api/requests?refresh=1'); toast('Request states refreshed from Mylar.'); render(); }
    catch (error) { refreshRequests.disabled = false; refreshRequests.textContent = 'Refresh from Mylar'; toast(error.message, 'error'); }
    return;
  }
  const clearFilter = event.target.closest('[data-clear-filter]');
  if (clearFilter) {
    setSetting('filter:format', 'all');
    setSetting('filter:medium', 'all');
    render();
    return;
  }
  const unfurl = event.target.closest('[data-unfurl]');
  if (unfurl) {
    const slot = document.querySelector(`[data-parts-for="${CSS.escape(unfurl.dataset.unfurl)}"]`);
    const hidden = slot ? [...slot.querySelectorAll('.request-part.extra')] : [];
    const opening = hidden.some((row) => row.hidden);
    hidden.forEach((row) => { row.hidden = !opening; });
    unfurl.textContent = opening
      ? 'Show fewer ↑'
      : `Show all ${slot.querySelectorAll('.request-part').length} parts ↓`;
    return;
  }
  const retry = event.target.closest('[data-retry-part]');
  if (retry && !retry.disabled) {
    const [comicId, issueId] = retry.dataset.retryPart.split('/');
    return retryPart(comicId, issueId, retry);
  }
  const pickParts = event.target.closest('[data-pick-parts]');
  if (pickParts && !pickParts.disabled) return openPartPicker(pickParts.dataset.pickParts, pickParts);
  const requestParts = event.target.closest('[data-request-parts]');
  if (requestParts && !requestParts.disabled) return queueSelectedParts(requestParts.dataset.requestParts, requestParts);
  const selectAllParts = event.target.closest('[data-select-all-parts]');
  if (selectAllParts) {
    document.querySelectorAll('[data-part-number]:not(:disabled)').forEach((input) => { input.checked = true; });
    refreshPartSelection();
    return;
  }
  const clearParts = event.target.closest('[data-clear-parts]');
  if (clearParts) {
    document.querySelectorAll('[data-part-number]:not(:disabled)').forEach((input) => { input.checked = false; });
    refreshPartSelection();
    return;
  }
  const requestEditionButton = event.target.closest('[data-request-edition]');
  if (requestEditionButton && !requestEditionButton.disabled) return requestEdition(requestEditionButton.dataset.requestEdition, requestEditionButton);
  const requestWatch = event.target.closest('[data-request-watch]');
  if (requestWatch && !requestWatch.disabled) return addSeriesToMylar(requestWatch.dataset.requestWatch, requestWatch);
  if (event.target.closest('#close-sheet')) return sheet.close();
  // Settings left the nav for the masthead, so route buttons are no longer only
  // found inside #nav.
  const nav = event.target.closest('[data-route]');
  if (nav) return go(`/${nav.dataset.route}`);
});

// role="button" elements need Enter/Space wired by hand.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[role="button"]');
  if (!target) return;
  event.preventDefault();
  target.click();
});

// A cover should feel like a physical book you can pull slightly forward from
// the shelf. This is deliberately a whole-cover preview, not a magnifier; CSS
// owns the animation while this supplies only a tiny cursor-relative offset.
// This used to call getBoundingClientRect() and write four custom properties on
// every single pointermove, which forces a synchronous layout per event -- with
// 96 cards on screen that is the most expensive thing the page does. Now the
// rect is measured once when the pointer enters a card, and the writes are
// coalesced into one animation frame.
let hoverCard = null;
let hoverBounds = null;
let hoverPoint = null;
let hoverQueued = false;

function paintHover() {
  hoverQueued = false;
  if (!hoverCard || !hoverBounds || !hoverPoint) return;
  const x = Math.max(0, Math.min(1, (hoverPoint.x - hoverBounds.left) / hoverBounds.width));
  const y = Math.max(0, Math.min(1, (hoverPoint.y - hoverBounds.top) / hoverBounds.height));
  hoverCard.style.setProperty('--cover-x', `${(x - 0.5) * 8}px`);
  hoverCard.style.setProperty('--cover-y', `${(y - 0.5) * 8}px`);
  hoverCard.style.setProperty('--cover-rx', `${(0.5 - y) * 3}deg`);
  hoverCard.style.setProperty('--cover-ry', `${(x - 0.5) * 3}deg`);
}

document.addEventListener('pointermove', (event) => {
  // Touch devices never get the tilt, so they never pay for it.
  if (event.pointerType === 'touch') return;
  const card = event.target.closest?.('.card');
  if (!card) { hoverCard = null; return; }
  if (card !== hoverCard) {
    const cover = card.querySelector('.cover');
    if (!cover) { hoverCard = null; return; }
    hoverCard = card;
    hoverBounds = cover.getBoundingClientRect();
  }
  hoverPoint = { x: event.clientX, y: event.clientY };
  if (hoverQueued) return;
  hoverQueued = true;
  requestAnimationFrame(paintHover);
}, { passive: true });

document.addEventListener('pointerout', (event) => {
  const card = event.target.closest?.('.card');
  if (!card || card.contains(event.relatedTarget)) return;
  if (card === hoverCard) { hoverCard = null; hoverBounds = null; }
  card.style.removeProperty('--cover-x'); card.style.removeProperty('--cover-y');
  card.style.removeProperty('--cover-rx'); card.style.removeProperty('--cover-ry');
});

// Horizontal shelves need to feel good with a mouse, not only a trackpad.
// Dragging is fast and direct; Shift-wheel and native horizontal wheels get a
// modest multiplier without stealing ordinary vertical page scrolling.
let railDrag;
document.addEventListener('pointerdown', (event) => {
  const rail = event.target.closest?.('.rail');
  if (!rail || event.pointerType === 'touch' || event.button !== 0 || event.target.closest?.('button, a, input, select')) return;
  railDrag = { rail, pointerId: event.pointerId, startX: event.clientX, startLeft: rail.scrollLeft, moved: false };
});
document.addEventListener('pointermove', (event) => {
  if (!railDrag || event.pointerId !== railDrag.pointerId) return;
  const distance = event.clientX - railDrag.startX;
  if (Math.abs(distance) > 3) railDrag.moved = true;
  if (!railDrag.moved) return;
  railDrag.rail.classList.add('dragging');
  railDrag.rail.scrollLeft = railDrag.startLeft - distance;
});
function endRailDrag(event) {
  if (!railDrag || (event?.pointerId != null && event.pointerId !== railDrag.pointerId)) return;
  const { rail, moved } = railDrag;
  rail.classList.remove('dragging');
  if (moved) {
    rail.dataset.suppressClick = 'true';
    setTimeout(() => { delete rail.dataset.suppressClick; }, 0);
  }
  railDrag = null;
}
document.addEventListener('pointerup', endRailDrag);
document.addEventListener('pointercancel', endRailDrag);
document.addEventListener('click', (event) => {
  const rail = event.target.closest?.('.rail');
  if (!rail?.dataset.suppressClick) return;
  event.preventDefault(); event.stopImmediatePropagation();
}, true);
document.addEventListener('wheel', (event) => {
  const rail = event.target.closest?.('.rail');
  if (!rail) return;
  const horizontal = event.shiftKey ? event.deltaY : event.deltaX;
  if (!horizontal) return;
  event.preventDefault();
  rail.scrollLeft += horizontal * 2.2;
}, { passive: false });

document.addEventListener('change', (event) => {
  if (event.target.matches('[data-part-number]')) {
    refreshPartSelection();
    return;
  }
  const preference = event.target.closest('[data-setting]');
  if (preference) {
    const name = preference.dataset.setting;
    if (name === 'poster') setPoster(preference.value);
    else if (name === 'page-size') setPageSize(Number(preference.value));
    else if (name === 'reduce-motion') { setSetting(name, preference.checked); applyAccessibility(); }
    else setSetting(name, preference.value);
    return;
  }
  const contentPick = event.target.closest('[data-content-filter]');
  if (contentPick) {
    setSetting(`filter:${contentPick.dataset.contentFilter}`, contentPick.value);
    render();
    return;
  }
  const filter = event.target.closest('[data-filter]');
  if (!filter) return;
  state.filters[filter.dataset.filter] = filter.value;
  if (filter.dataset.filter === 'format' || filter.dataset.filter === 'medium') {
    setSetting(`filter:${filter.dataset.filter}`, filter.value);
    loadBooks();
  }
  else renderResults();
});

document.addEventListener('change', (event) => {
  const size = event.target.closest('[data-pagesize]');
  if (!size) return;
  setPageSize(Number(size.value));
  render();
});

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (query.length >= 2) { searchInput.blur(); go(`/search/${encodeURIComponent(query)}`); }
});

sheet.addEventListener('click', (event) => { if (event.target === sheet) sheet.close(); });
window.addEventListener('hashchange', render);
// The shelf count lives in the masthead on every page, so it is loaded once at
// boot rather than only by the routes that happen to need the list.
loadShelf().catch(() => {});
render();
