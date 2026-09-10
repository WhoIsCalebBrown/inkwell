// Inkwell — a front-end for the Publisher → Line → Thread → Volume model.
// A "thread" is whatever a reader follows: a character for superhero books,
// a creator for manga and creator-owned work, a team or an event where those fit.

const view = document.querySelector('#view');
const sheet = document.querySelector('#sheet');
const sheetBody = document.querySelector('#sheet-body');
const toastEl = document.querySelector('#toast');
const searchInput = document.querySelector('#search-input');

const state = { shelf: [], filters: {}, results: [], editions: [], query: '' };
let discoverBootstrapPoll;
let discoverPagingCleanup = null;
let discoverSession = null;
let installationSetup = null;

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
// Two different kinds of not-knowing, and they need different answers.
// GLOSSARY is vocabulary the comics industry owns: a reader may simply never
// have met the word "omnibus". SOURCES is where a list on this page came from
// and how it was matched — Inkwell's own workings, published rather than
// implied. A reader who can see that a shelf is a name match and not a
// name match and not a recorded fact can tell us it is wrong and say why;
// without that, the only available complaint is "this looks random".
const SOURCES = {
  'connected books': 'Books whose ComicVine record names this person — in its list of who made the book, or who appears in it. Inkwell never guesses from a title: if a book is here, ComicVine put the name on it.',
  'team books': 'ComicVine records who appears in a book one character at a time and never by team, so these are series whose title matches the team’s name. That is a weaker match than a name on a record, and it can catch an unrelated book with the same words in it.',
  'core roster': 'Wikidata’s line-up for this team: a short, edited list of who is in it. ComicVine’s own list runs to hundreds of names across every era, which is why it is kept separate below.',
  'recorded members': 'Everyone ComicVine has ever filed as a member of this team, across every era. Long, unordered, and useful for finding somebody you half-remember.',
  lore: 'Wikidata — the open database behind Wikipedia’s infoboxes. Only what it states outright: who created the character, which universe they belong to, their teams and family. Inkwell works nothing out for itself here.',
  requests: 'Your Mylar watchlist, joined with what Komga has actually imported. Mylar reports what it is looking for and downloading; Komga is the proof a book arrived and can be read.',
  downloads: 'Mylar’s direct-download queue, read from its own queue page. Mylar reports a state and a size but never a byte count, so there is no percentage to show — how long a file has held its state is the honest signal.',
  recently: 'Books Mylar finished and imported, and any time its download queue stopped moving. Inkwell checks every five minutes so this is here when you come back.',
  'still waiting': 'Which of your indexers Mylar has tried, when it last tried, and when it is next scheduled to. Read from Mylar’s own database.',
  publishers: 'A fixed list of houses and their imprints, with cover art taken from books already in your local catalogue. No provider call is made to draw this page.',
  eras: 'Grouped by the year each book was published, from your own catalogue. Nothing external is consulted.',
  'browse events': 'A curated list of well-known crossovers, looked up once in ComicVine and then kept. ComicVine cannot sort by popularity, so a hand-written list is the only way to lead with names you would recognise.',
  'browse teams': 'A curated list of well-known teams, looked up once in ComicVine and then kept. ComicVine reports no popularity figure for teams at all, so they cannot be ranked automatically.',
  'browse characters': 'Curated well-known names first, then whoever else your own catalogue has learned from books you have opened.',
  'browse creators': 'A curated list of notable writers and artists, looked up once in ComicVine and then kept.',
  'all titles': 'Every volume ComicVine files under this publisher, newest first. The list of ids comes from the publisher’s own record, then a page at a time is filled in with details.',
  'universes & imprints': 'Publishing lines within this house, as Inkwell has them written down. Choosing one filters the catalogue below by imprint.',
  'search results': 'ComicVine’s search, re-ranked by Inkwell: an exact title wins, then all of your words, then a publisher or year you named. Your local catalogue answers first and is topped up from ComicVine.',
  'local catalogue': 'Everything Inkwell has kept from providers, on disk. It grows only from things you searched, opened, followed or requested — Inkwell never crawls.',
  'good places to start': 'Curated starting points, filled from books already in your catalogue. They are a way in, not a recommendation engine — Inkwell does not track what you read.',
  'discovery metadata': 'A reusable collection matched from facts Inkwell has already saved locally: publisher, year, format, issue count, and recorded ComicVine characters or creators. It does not call a provider while you scroll.',
  'editorial discovery': 'A deliberately limited starting collection. The matching rules are written by Inkwell so the shelf is useful before the local catalogue has enough richer metadata; it is labelled editorial rather than presented as a provider fact.',
  'from your shelf': 'Built from the series you currently track in Mylar, while excluding those tracked series from the results. Publisher affinity works immediately; character and creator shelves appear only after their ComicVine records have been saved locally.',
  'request scope': 'What pressing Request will actually hand to Mylar, spelled out before you press it. Nothing is queued until you confirm a selection.',
  'created by': 'The writers and artists ComicVine lists on this book’s own record. Opening one shows every other book its record names them on.',
  featuring: 'The characters ComicVine lists on this book’s record. It describes the book as a whole, not each issue inside it — a name here does not mean they appear on every page.',
};

const explain = (key) => {
  const term = String(key).toLowerCase();
  return GLOSSARY[term] ?? SOURCES[term] ?? '';
};

const info = (key, align = '') => {
  const tip = explain(key);
  if (!tip) return '';
  return `<button type="button" class="info ${align}" data-tip="${esc(tip)}"
    aria-label="What does ${esc(key)} mean?">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5"></circle><path d="M12 11v6"></path><circle cx="12" cy="7.4" r="1.1" fill="currentColor" stroke="none"></circle>
    </svg></button>`;
};

const term = (text, key = text) => {
  const tip = explain(key);
  return tip ? `<span class="term" tabindex="0" data-tip="${esc(tip)}">${esc(text)}</span>` : esc(text);
};

/* ---------------- poster size ---------------- */

// The storage prefix changed with the name. A reader's poster size, page size,
// filters and the flags recording which ledes they have already read are worth
// more than a tidy key, so the old ones are carried across once rather than
// abandoned — otherwise the rename silently resets every device and replays
// every first-visit veil.
try {
  for (const key of Object.keys(localStorage).filter((name) => name.startsWith('panel:'))) {
    const moved = `inkwell:${key.slice('panel:'.length)}`;
    if (localStorage.getItem(moved) === null) localStorage.setItem(moved, localStorage.getItem(key));
    localStorage.removeItem(key);
  }
} catch { /* private mode, or storage disabled entirely */ }

const poster = document.querySelector('#poster');
function setPoster(px, persist = true) {
  const size = Math.min(320, Math.max(110, Number(px) || 150));
  document.documentElement.style.setProperty('--poster', `${size}px`);
  poster.value = String(size);
  // Per-device preference; a phone and a desk monitor want different answers.
  if (persist) { try { localStorage.setItem('inkwell:poster', String(size)); } catch { /* private mode */ } }
}
try { setPoster(localStorage.getItem('inkwell:poster') ?? 150, false); } catch { setPoster(150, false); }
poster.addEventListener('input', (event) => setPoster(event.target.value));

// How many titles a page shows. Kept beside poster size because they are the
// same kind of preference: how much you want on screen at once.
const PAGE_SIZES = [24, 48, 72, 96];
function pageSize() {
  try {
    const stored = Number(localStorage.getItem('inkwell:pagesize'));
    return PAGE_SIZES.includes(stored) ? stored : 48;
  } catch { return 48; }
}
function setPageSize(value) {
  try { localStorage.setItem('inkwell:pagesize', String(value)); } catch { /* private mode */ }
}

// Inkwell preferences deliberately live in the browser. They affect this reader's
// presentation and request flow, not Mylar/Komga's global configuration.
const setting = (name, fallback) => {
  try { return localStorage.getItem(`inkwell:${name}`) ?? fallback; } catch { return fallback; }
};
const setSetting = (name, value) => {
  try { localStorage.setItem(`inkwell:${name}`, String(value)); } catch { /* private mode */ }
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

async function api(url, options = {}) {
  // Every request carries this. The server refuses writes without it, which is
  // what stops a page on another site from queueing or cancelling things here:
  // a form cannot set a header, and a fetch that tries is stopped by a
  // preflight Inkwell never answers.
  const response = await fetch(url, { ...options, headers: { ...options.headers, 'X-Inkwell': '1' } });
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
  // Setup is server state, not a browser preference. This means opening the
  // installation from another device cannot accidentally skip it, while an
  // existing /config never sees setup again after a container replacement.
  installationSetup = await api('/api/setup').catch(() => null);
  const setupRequired = installationSetup && !installationSetup.completed;
  const routeName = setupRequired ? 'setup' : name;
  const route = routes[routeName] || routes.discover;
  // Rail scroll listeners die with their elements, while vertical Discover
  // paging listens on window and therefore needs an explicit teardown.
  if (routeName !== 'discover') {
    clearTimeout(discoverBootstrapPoll);
    discoverPagingCleanup?.(); discoverPagingCleanup = null;
  }
  document.querySelectorAll('[data-route]').forEach((b) => {
    const active = b.dataset.route === routeName
      || (routeName === 'thread' && b.dataset.route === 'threads')
      || (routeName === 'collection' && b.dataset.route === 'discover')
      || (['search', 'publisher', 'hub', 'decade'].includes(routeName) && b.dataset.route === 'browse');
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

routes.setup = async () => {
  const setup = installationSetup || await api('/api/setup');
  const mylarConfigured = setup.requests?.configured && setup.requests?.endpoint;
  const comicVineConfigured = setup.discovery?.configured;
  const accessIsLan = setup.authentication === 'trusted-lan';
  view.innerHTML = `
    ${lede('setup', {
      kicker: 'First-run setup',
      title: 'Set up your<br /><em>reading room.</em>',
      body: 'Inkwell keeps its own data in /config and connects to the services you already run. Mylar and ComicVine are required; Komga is optional.',
    })}
    <section class="settings-section">
      <div class="section-head"><span class="kicker no">01</span><h2>Required connections</h2><span class="kicker aside">Configure these in your deployment, then restart Inkwell</span></div>
      <div class="settings-grid request-settings">
        <div class="setting"><span class="kicker">Mylar</span><b>${mylarConfigured ? 'Configured' : 'Needs attention'}</b><small>Set MYLAR_URL to Mylar’s address ending in /api. Mount Mylar appdata read-only so Inkwell can read its API and ComicVine credentials, or provide the two server-side credentials directly.</small>${mylarConfigured ? '<button class="secondary" data-test-mylar>Test Mylar connection</button>' : ''}<p class="status" data-mylar-test></p></div>
        <div class="setting"><span class="kicker">ComicVine</span><b>${comicVineConfigured ? 'Configured' : 'Needs attention'}</b><small>Inkwell uses the ComicVine credential from Mylar’s config.ini, or COMICVINE_API_KEY if you use direct server-side credentials. It is never sent to the browser.</small></div>
      </div>
      ${mylarConfigured && comicVineConfigured ? '' : '<p class="settings-note">Open the Configuration guide for examples. Do not enter container paths, API keys, or Mylar database details in this browser.</p>'}
    </section>
    <section class="settings-section">
      <div class="section-head"><span class="kicker no">02</span><h2>Access model</h2><span class="kicker aside">Inkwell v1 is one shared installation</span></div>
      <div class="settings-grid request-settings">
        <div class="setting"><span class="kicker">${accessIsLan ? 'Trusted LAN' : 'Shared Basic authentication'}</span><b>${accessIsLan ? 'Anyone who can reach this address can use Inkwell.' : 'A shared username and password protects this installation.'}</b><small>${accessIsLan ? 'This is appropriate only on a private LAN. For remote access, use a reverse proxy, Tailscale, or a tunnel with HTTPS and authentication.' : 'Inkwell has no public registration, user accounts, or roles. Everyone using these credentials has the same access.'}</small></div>
      </div>
      ${accessIsLan ? '<label class="setting toggle"><input type="checkbox" data-acknowledge-trusted-lan /><span><b>I understand this unauthenticated installation is limited to my trusted LAN.</b><small>I will use reverse-proxy or Tailscale authentication before exposing it remotely.</small></span></label>' : ''}
    </section>
    <section class="settings-section">
      <div class="section-head"><span class="kicker no">03</span><h2>Finish</h2></div>
      <div class="cache-card"><div><b>Ready when both required connections are configured.</b><p>Komga, Metron, notifications, and advanced Mylar settings can be added later from your deployment configuration. Completing setup does not modify Mylar or Komga.</p></div><button class="act" data-complete-setup${mylarConfigured && comicVineConfigured ? '' : ' disabled'}>Finish setup</button></div>
    </section>`;
};

/* ---------------- shelf ---------------- */

const normaliseText = (text) => String(text ?? '').toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

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

const discoverSeed = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`)
  .replace(/[^a-zA-Z0-9_-]/g, '');

function saveDiscoverSession() {
  try {
    sessionStorage.setItem('inkwell:discover-session', JSON.stringify({
      seed: discoverSession?.seed, served: discoverSession?.served || [],
    }));
  } catch { /* private mode is still a complete Discover experience */ }
}

function discoveryQuery(batch) {
  const query = new URLSearchParams({ batch: String(batch), seed: discoverSession.seed });
  if (discoverSession.served.length) query.set('served', discoverSession.served.join(','));
  return `/api/discover?${query}`;
}

function discoverySection(section, number) {
  const label = String(number).padStart(2, '0');
  const context = [section.kicker, section.subtitle].filter(Boolean).join(' · ');
  return `<section class="discover-rail-section" data-discovery-section="${esc(section.id)}">
    <div class="section-head">
      <span class="kicker no">${label}</span><h2>${esc(section.title)}</h2>
      ${context ? `<span class="kicker aside">${esc(context)}</span>` : ''}
      <button class="kicker discover-explore" data-collection="${esc(section.id)}">Explore →</button>
    </div>
    <div class="rail" data-discover-rail="${esc(section.id)}" data-discover-seed="${esc(discoverSession.seed)}"
      data-next-offset="${section.items.length}" data-has-more="${section.hasMore}">
      ${section.items.map(volumeCard).join('')}${section.hasMore ? '<span class="rail-sentinel" aria-hidden="true"></span>' : ''}
    </div>
  </section>`;
}

function appendDiscoverySections(sections) {
  const rails = document.querySelector('#rails');
  if (!rails || !sections.length) return;
  const first = discoverSession.nextNumber;
  rails.insertAdjacentHTML('beforeend', sections.map((section, index) => discoverySection(section, first + index)).join(''));
  discoverSession.nextNumber += sections.length;
  observeRailEnds();
}

function installDiscoverPaging() {
  discoverPagingCleanup?.();
  const check = () => {
    if (!discoverSession || discoverSession.loading || discoverSession.exhausted || !document.querySelector('#rails')) return;
    const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    if (remaining > 900) return;
    loadMoreDiscoveryRails();
  };
  let last = 0;
  let trailing;
  const onScroll = () => {
    clearTimeout(trailing);
    const since = Date.now() - last;
    if (since >= 160) { last = Date.now(); check(); }
    else trailing = setTimeout(() => { last = Date.now(); check(); }, 160 - since);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', check, { passive: true });
  discoverPagingCleanup = () => {
    clearTimeout(trailing);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', check);
  };
  setTimeout(check, 0);
}

async function loadMoreDiscoveryRails() {
  if (!discoverSession || discoverSession.loading || discoverSession.exhausted) return;
  const rails = document.querySelector('#rails');
  if (!rails) return;
  discoverSession.loading = true;
  let loading = rails.querySelector('#discover-more-loading');
  if (!loading) {
    rails.insertAdjacentHTML('beforeend', '<div id="discover-more-loading" class="discover-more-loading"><span class="kicker">Finding another way in…</span></div>');
    loading = rails.querySelector('#discover-more-loading');
  }
  try {
    const page = await api(discoveryQuery(6));
    discoverSession.served = page.served || discoverSession.served;
    saveDiscoverSession();
    loading?.remove();
    if (page.sections?.length) appendDiscoverySections(page.sections);
    if (page.exhausted || !page.sections?.length) {
      discoverSession.exhausted = true;
      rails.insertAdjacentHTML('beforeend', '<p class="discover-exhausted kicker">You have reached everything Inkwell can responsibly connect from this catalogue for now.</p>');
    }
  } catch {
    loading?.remove();
    // A later scroll retries; failing a decorative extension must not interrupt
    // the reader who is already browsing a useful page.
  } finally {
    if (discoverSession) discoverSession.loading = false;
  }
}

routes.discover = async () => {
  clearTimeout(discoverBootstrapPoll);
  discoverPagingCleanup?.(); discoverPagingCleanup = null;
  discoverSession = { seed: discoverSeed(), served: [], nextNumber: 3, loading: false, exhausted: false };
  saveDiscoverSession();
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
    <div id="rails">${skeletonRail(8)}</div>`;

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
          <button class="cover-btn" data-volume="${esc(x.id)}" style="all:unset;cursor:pointer">
            ${coverHtml(x, { flag: x.inLibrary ? 'In library' : 'Requested' })}
          </button>
          <div class="meta"><h3>${esc(x.title)}</h3>
          <span class="sub">${esc(x.state)}${x.books ? ` · ${plural(x.books, 'book')}` : ''}</span>
          <button class="act" data-volume="${esc(x.id)}">Details →</button></div>
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
          ${stackedArt(art.map((item) => item.cover), initialsOf(path.title))}
          <div class="path-copy"><span class="kicker" style="color:var(--accent)">Starter path</span><h3>${esc(path.title)}</h3>
            <p>${path.items.length ? `${path.items.length} saved titles to explore.` : 'Search this path to start teaching Inkwell about it.'}</p>
            <button class="secondary" ${path.hub ? `data-hub="${esc(path.hub)}"` : `data-search="${esc(path.search)}"`}>Explore →</button></div>
        </article>`;
      }).join('')}</div>`;
  }).catch(() => { starterPaths.innerHTML = ''; });

  const rails = document.querySelector('#rails');
  try {
    const page = await api(discoveryQuery(8));
    discoverSession.served = page.served || [];
    saveDiscoverSession();
    rails.innerHTML = '';
    appendDiscoverySections(page.sections || []);
    if (!page.sections?.length) {
      rails.innerHTML = page.bootstrapping
        ? '<div class="empty">Building your first local shelves…</div>'
        : '<div class="empty">Search for a book you know to begin growing Inkwell’s local discovery catalogue.</div>';
    }
    if (page.bootstrapping && !page.sections?.length) {
      discoverBootstrapPoll = setTimeout(() => {
        if (location.hash === '#/discover' || !location.hash) render();
      }, 4_000);
    } else installDiscoverPaging();
  } catch {
    rails.innerHTML = '<div class="empty">Inkwell could not load discovery right now.</div>';
  }
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
      + `?offset=${encodeURIComponent(rail.dataset.nextOffset)}&size=12`
      + `&seed=${encodeURIComponent(rail.dataset.discoverSeed || 'inkwell')}`);
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
  }[id] || 'A local shelf of titles Inkwell has learned from your browsing.';
  view.innerHTML = `<section class="lede"><span class="kicker" style="color:var(--accent)">Browse without a keyword</span>
    <h1>${esc(hub.title)}</h1><p>${esc(copy)}</p></section>
    <div class="section-head"><span class="kicker no">01</span><h2>Start anywhere</h2>
      <span class="kicker aside">Saved in your local catalogue</span></div>
    ${filterBar(hub.items.length, applyContentFilter(hub.items).length)}
    ${applyContentFilter(hub.items).length
      ? `<div class="grid">${applyContentFilter(hub.items).map(volumeCard).join('')}</div>`
      : `<div class="empty">Inkwell has not learned any titles for this collection yet. Search for a book you already know, then this hub will grow naturally.</div>`}`;
};

// A discovery rail is a reusable collection definition, not a one-off preview.
// Its full page therefore asks the server to resolve the same registered id,
// rather than translating labels back into an approximate text search.
routes.collection = async (encodedId, pageArg) => {
  const id = decodeURIComponent(encodedId || '');
  const page = Math.max(1, Number(pageArg) || 1);
  const seed = discoverSession?.seed || 'inkwell';
  view.innerHTML = `<section class="lede" style="border:0;padding-bottom:24px">
      <span class="kicker" style="color:var(--accent)">Collection</span>
      <h1>Loading this <em>collection.</em></h1></section>${skeletons(12)}`;
  const data = await api(`/api/discover/collection/${encodeURIComponent(id)}?page=${page}&size=${pageSize()}&seed=${encodeURIComponent(seed)}`);
  const shown = applyContentFilter(data.items);
  const pager = (position) => `
    <div class="pager ${position}">
      ${page > 1 ? `<button class="kicker" data-collection-page="${page - 1}">← Previous</button>` : '<span></span>'}
      <span class="kicker">Page ${page.toLocaleString()} of ${data.pages.toLocaleString()}
        · ${data.total.toLocaleString()} titles</span>
      ${page < data.pages ? `<button class="kicker" data-collection-page="${page + 1}">Next →</button>` : '<span></span>'}
    </div>`;
  view.innerHTML = `${breadcrumb([{ label: 'Discover', attr: 'data-route="discover"' }, { label: data.title }])}
    <section class="lede" style="border:0;padding:22px 0 26px">
      ${data.kicker ? `<span class="kicker" style="color:var(--accent)">${esc(data.kicker)}</span>` : ''}
      <h1>${esc(data.title)}</h1>
      ${data.subtitle ? `<p>${esc(data.subtitle)}</p>` : ''}
    </section>
    <div class="section-head"><span class="kicker no">01</span><h2>Explore the collection</h2>
      <span class="kicker aside">${data.personal ? 'From your shelf' : data.source === 'metadata' ? 'From saved catalogue metadata' : 'Editorial collection'}
        ${info(data.personal ? 'from your shelf' : data.source === 'metadata' ? 'discovery metadata' : 'editorial discovery')}</span></div>
    ${filterBar(data.items.length, shown.length)}
    ${pager('top')}
    <div class="grid">${shown.map(volumeCard).join('')}</div>
    ${pager('bottom')}`;
  state.collection = { id, page };
};

/* ---------------- browse ---------------- */

// A cold catalogue resolves its curated names one paced request at a time, so
// a rail can answer while it is still half a list. Come back for the rest
// instead of leaving the reader looking at the single card that happened to be
// cached -- that state read as "Inkwell knows one team", which is not the truth.
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
// A filter field, deliberately not a <label> wrapping its <select>. It used to
// be, with the ⓘ inside it — so tapping the icon activated the control it was
// explaining, and the dropdown and the tip opened on top of each other. The
// label now names the select by id instead, which leaves the icon a sibling of
// both and clickable on its own.
let fieldSeq = 0;
const filterField = (labelText, tip, control) => {
  const id = `field-${fieldSeq += 1}`;
  return `<div class="filter-field">
    <span class="kicker"><label for="${id}">${labelText}</label>${tip ? ` ${tip}` : ''}</span>
    ${control(id)}
  </div>`;
};

function filterBar(total = null, shown = null) {
  const { format, medium } = contentFilter();
  const option = (value, label, current) =>
    `<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;
  return `<div class="filters content-filters">
    ${filterField('Format', info('collected edition'), (id) => `<select id="${id}" data-content-filter="format">
        ${option('all', 'All formats', format)}
        ${FORMATS.map((f) => option(f.name, f.name, format)).join('')}
      </select>`)}
    ${filterField('Kind', info('manga'), (id) => `<select id="${id}" data-content-filter="medium">
        ${option('all', 'Comics & manga', medium)}
        ${option('comic', 'Comics only', medium)}
        ${option('manga', 'Manga only', medium)}
      </select>`)}
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

    <div class="section-head"><span class="kicker no">01</span><h2>Publishers ${info('publishers')}</h2>
      <span class="kicker aside">Every house, its lines and its full catalogue</span></div>
    <div id="houses" class="house-grid">${
      '<div class="house-tile skeleton-tile"></div>'.repeat(5)}</div>

    <div class="section-head"><span class="kicker no">02</span><h2>Events ${info('browse events')}</h2>
      <span class="kicker aside">Crossovers that run through several titles at once</span></div>
    <div id="browse-events">${skeletonRail(7)}</div>

    ${/* Eras come out of the local mirror, so this section keeps working while
          ComicVine is cooling down and the rest of the app has gone quiet. */ ''}
    <div class="section-head"><span class="kicker no">03</span><h2>Teams ${info('browse teams')}</h2>
      <span class="kicker aside">Line-ups from Wikidata, not ComicVine's guesswork</span></div>
    <div id="browse-teams">${skeletonRail(7)}</div>

    <div class="section-head"><span class="kicker no">04</span><h2>Eras ${info('eras')}</h2>
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
    <div class="section-head"><span class="kicker no">${slot.dataset.loreNo}</span><h2>Lore ${info('lore')}</h2>
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
      body: 'Characters, creators, teams and the events that cross between them. Open one to see the books ComicVine names them in.',
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
      <p>Nothing filed yet. Open a publisher and Inkwell will start learning who its
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
    <div class="section-head"><h2>${esc(group.label)} ${info(`browse ${group.label.toLowerCase()}`)}</h2>
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
        : '<div class="empty">Nothing here yet — open a book and the people it names will fill this in.</div>';
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
        <p class="sort-note kicker">Every matching publication run currently saved in Inkwell’s local catalogue. This grows as books are browsed; it is not presented as a complete history of every comic from the decade.</p>
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
      <div class="section-head"><span class="kicker no">01</span><h2>Universes &amp; imprints ${info('universes & imprints')}</h2>
        <span class="kicker aside">${info('imprint', 'right')}</span></div>
      <div class="chips">${house.lines.map((line) => `
        <button class="chip kicker" data-search="${esc(`${name} ${line}`)}">${esc(line)}</button>`).join('')}</div>` : ''}

    <div id="pub-chars-${slug}"></div>
    <div id="pub-teams-${slug}"></div>

    <div class="section-head"><span class="kicker no">04</span><h2>All titles ${info('all titles')}</h2>
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
  const select = (key, label, options, tip = '') => filterField(label, tip, (id) =>
    `<select id="${id}" data-filter="${key}">${options.map(([v, t]) =>
      `<option value="${esc(v)}"${state.filters[key] === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`);
  document.querySelector('#filters').innerHTML =
    select('medium', 'Kind', [['all', 'Comics & manga'], ['comic', 'Comics only'], ['manga', 'Manga only']], info('manga')) +
    select('format', 'Format', [['all', 'All formats'], ...editions.map((e) => [e, e])], info('collected edition')) +
    select('publisher', 'Publisher', [['all', 'All publishers'], ...publishers.map((p) => [p, p])]) +
    select('sort', 'Sort', [
      ['relevance', 'Best match'],
      ['notable', 'Most notable'],
      ['newest', 'Newest'],
      ['issues', 'Most issues'],
      ['title', 'A–Z'],
    ], info('notability')) +
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

routes.thread = async (kind, id, encodedName, pageArg) => {
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
  const page = Math.max(1, Number(pageArg) || 1);
  const nameQuery = fallbackName ? `?name=${encodeURIComponent(fallbackName)}` : '';
  const [thread] = await Promise.all([api(`/api/thread/${kind}/${id}${nameQuery}`), loadShelf().catch(() => {})]);
  // Real navigational ancestry for the volume sheet -- not a guess at which
  // character "owns" a book, which would be inventing a relationship.
  state.thread = { kind, id, name: thread.name, publisher: thread.publisher, page };
  const stat = (label, value) => value
    ? `<div><span class="kicker">${label}</span><b class="disp">${esc(value)}</b></div>` : '';
  // "Thread" is Inkwell's word for the tier, not the reader's. Say what this is.
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
        <h2>${kindLabel === 'Team' ? 'Core roster' : 'Also appears with'} ${info(kindLabel === 'Team' ? 'core roster' : 'connected books')}</h2>
        <span class="kicker aside">${kindLabel === 'Team'
          ? 'Verified relationships from Wikidata' : 'Teams and groups'}</span></div>
      ${kindLabel === 'Team' ? memberRoster(thread.teams) : `<div class="chips">${thread.teams.map(relationshipChip).join('')}</div>`}
      ${thread.lineUpSource === 'lore'
        ? '<p class="sort-note kicker">Wikidata supplies the core roster. Open a member for their own lore and the books they are named in.</p>'
        : ''}` : ''}
    ${hasHistoricMembers ? `
      <div class="section-head"><span class="kicker no">02</span><h2>Recorded members ${info('recorded members')}</h2>
        <span class="kicker aside">Across different eras</span></div>
      <p class="sort-note kicker">ComicVine’s wider, time-spanning list — useful for finding people such as Jubilee and Rogue, but not presented as one current line-up.</p>
      ${memberRoster(thread.historicMembers)}` : ''}
    ${hasLore ? `<div id="thread-lore" data-lore-no="${loreNo}"></div>` : ''}
    <div class="section-head"><span class="kicker no">${connectedNo}</span>
      <h2 id="thread-books-title">Connected books ${info(kind === 'team' ? 'team books' : 'connected books')}</h2><span class="kicker aside" id="thread-books-count">${kind === 'team'
        ? 'Series matched by name' : 'Books whose record names them'}</span></div>
    <div id="thread-books">${skeletons(12)}</div>`;

  // This is intentionally after the profile paint: Wikidata enriches a
  // character, it does not decide whether the page is usable. Its direct
  // relationships then open familiar Inkwell pages when known, or search when
  // Inkwell has not learned that person/team yet.
  if (hasLore) {
    const loreSlot = document.querySelector('#thread-lore');
    api(`/api/thread/${kind}/${id}/lore`)
      .then((lore) => { if (loreSlot) renderLore(loreSlot, lore); })
      .catch(() => { if (loreSlot?.isConnected) loreSlot.remove(); });
  }

  // Do not approximate a relationship with a title search. These are volumes
  // where the saved ComicVine detail actually credits this creator/character.
  api(`/api/thread/${kind}/${id}/volumes?page=${page}&size=${pageSize()}`)
    .then(({ items, source, total = items.length, pages = 1, capped = false, coverage }) => {
      // Say where the shelf came from, in this thread's own terms. ComicVine
      // files no credits against a team, so a team's own books can only be
      // found by its name -- a different kind of claim from a saved credit,
      // and it has to read as one. A member's books live on the member's page;
      // interleaving them here showed Essential X-Men to someone who had
      // opened Guardians of the Galaxy.
      const note = source === 'team-series'
        ? `<p class="sort-note kicker">ComicVine keeps no record of which books a team is in. These are ${total.toLocaleString()} saved publication runs whose title matches ${esc(thread.name)}; the title repeats because each run is a different series or edition. Year, publisher and issue range below distinguish them.${capped ? ' Inkwell shows the first 300 saved matches.' : ''}</p>`
        : coverage === 'observed-credits'
          ? `<p class="sort-note kicker">${total.toLocaleString()} locally verified book records name this ${esc(kindLabel.toLowerCase())}. ComicVine does not provide a complete ${esc(kindLabel.toLowerCase())}-to-series catalogue, so this is an honest saved relationship view, not a claim that no other books exist. More records appear as Inkwell learns them. Substantial runs are shown first.</p>`
          : '';
      const pager = (position) => pages > 1 ? `<div class="pager ${position}">
        ${page > 1 ? `<button class="kicker" data-thread-page="${page - 1}">← Previous</button>` : '<span></span>'}
        <span class="kicker">Page ${page.toLocaleString()} of ${pages.toLocaleString()} · ${total.toLocaleString()} verified titles</span>
        ${page < pages ? `<button class="kicker" data-thread-page="${page + 1}">Next →</button>` : '<span></span>'}
      </div>` : '';
      const shown = applyContentFilter(items);
      if (kind === 'team' && source === 'team-series') {
        const title = document.querySelector('#thread-books-title');
        const count = document.querySelector('#thread-books-count');
        if (title) title.textContent = 'Publication runs';
        if (count) count.textContent = `Page ${page.toLocaleString()} of ${pages.toLocaleString()} · ${total.toLocaleString()} saved matches`;
      } else {
        const count = document.querySelector('#thread-books-count');
        if (count) count.textContent = `${total.toLocaleString()} locally verified titles`;
      }
      const cards = kind === 'team' && source === 'team-series'
        ? shown.map((item) => volumeCard({ ...item, title: item.year ? `${item.title} (${item.year})` : item.title }))
        : shown.map(volumeCard);
      // Three states, and the filtered-empty one used to be missed: the test was
      // `items.length`, the unfiltered page, so a standing Omnibus filter drew
      // the note, the filter row, a pager, an empty grid and a second pager --
      // stacked rules around nothing, with no word about why. A filter that
      // empties a page has to say so, and say that it is only this page,
      // because the filter runs over the page the server sent, not the run.
      const filteredOut = Boolean(items.length) && !shown.length;
      const filteredEmpty = `<div class="empty">
        <p>The ${esc(contentFilter().format === 'all' ? 'current filter' : `${contentFilter().format} filter`)} hides all ${plural(items.length, 'title')} on this page.${
          page < pages ? ` There ${pages - page === 1 ? 'is' : 'are'} ${plural(pages - page, 'more page')} to look through.` : ''}</p>
        <button class="secondary" data-clear-filter>Clear filter</button>
        ${page < pages ? `<button class="secondary" data-thread-page="${page + 1}">Next page →</button>` : ''}
      </div>`;
      document.querySelector('#thread-books').innerHTML = !items.length
        ? `<div class="empty">Inkwell has not saved any books under the name ${esc(thread.name)} yet. Open a title or search for one to enrich this path; it will never guess from a keyword.</div>`
        : filteredOut
        ? `${note}${filterBar(items.length, 0)}${filteredEmpty}`
        : `${note}${filterBar(items.length, shown.length)}${pager('top')}<div class="grid">${cards.join('')}</div>${pager('bottom')}`;
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

// Mylar reports a download's state and never its byte count, so the only
// honest answer to "is this actually moving?" is how long the state has held.
// Three hours on one file is ordinary for a 4GB omnibus off a free mirror.
// Three hours with nothing downloading at all is the queue having died: its
// worker is single, and if Mylar restarts mid-transfer the row stays marked
// Downloading, nothing picks the rest up, and every later request waits behind
// it forever. That is invisible from the request list, which is why it gets a
// section of its own.
const DOWNLOAD_POLL_MS = 20_000;
const STALL_AFTER_MS = 3 * 60 * 60_000;

// "2026-09-07 15:36", written in Mylar's local time. The browser shares that
// clock; the server's container does not, which is why this is parsed here.
function mylarTime(text) {
  const parts = String(text || '').match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!parts) return null;
  const [, year, month, day, hour, minute] = parts.map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

function sinceLabel(text) {
  const at = mylarTime(text);
  if (!at) return '';
  const minutes = Math.max(0, Math.round((Date.now() - at.getTime()) / 60_000));
  if (minutes < 90) return `${minutes || 1} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hr` : `${Math.round(hours / 24)} days`;
}

function queueSummary(queue) {
  const { counts } = queue;
  if (queue.available === false) return 'Download queue unavailable';
  return `${counts.downloading ? `${counts.downloading} downloading` : 'Nothing downloading'} · ${
    counts.waiting} waiting · ${counts.done} finished`;
}

// Said once, above the list, rather than on every card that is waiting.
function queueWarning(queue) {
  const active = queue.items.filter((item) => item.state === 'Downloading');
  const waiting = queue.items.filter((item) => item.state === 'Queued');
  // Say why there is nothing to show, rather than showing nothing. A queue
  // Inkwell cannot read and a queue with nothing in it look identical here and
  // mean entirely different things.
  if (queue.available === false) return `<p class="download-warning">${esc(queue.note || 'Inkwell cannot read Mylar’s download queue.')}</p>`;
  if (!queue.items.length) return queue.note ? `<p class="sort-note kicker">${esc(queue.note)}</p>` : '';
  const held = active.map((item) => Date.now() - (mylarTime(item.changed)?.getTime() ?? Date.now()));
  const stalled = (waiting.length && !active.length) || held.some((ms) => ms > STALL_AFTER_MS);
  if (!stalled) return '';
  return `<p class="download-warning">Nothing has moved${
    active.length ? ` for ${sinceLabel(active[0].changed)}` : ' — files are waiting with none running'
    }. Mylar hands the queue to one worker at a time, and a restart of Mylar leaves it holding a file it will never finish.
    <button class="secondary" data-restart-queue>Restart the queue</button></p>`;
}

// Only the queue moves on its own, so only the queue is re-read. Cards are
// patched in place: a full re-render would collapse an unfurled parts list and
// throw away the titles ComicVine filled in after paint.
async function watchQueue(signature) {
  for (;;) {
    await new Promise((resolve) => { setTimeout(resolve, DOWNLOAD_POLL_MS); });
    const center = document.querySelector('.request-center');
    if (!center || !center.isConnected) return;
    let queue;
    try { queue = await api('/api/downloads'); } catch { return; }
    if (!center.isConnected) return;
    const entries = requestEntries({ shelf: [], activity: { items: [] }, queue });
    // A file for a title that is not on screen means the page itself is out of
    // date -- a request made on another device, say. Rebuild rather than
    // pretend, then stop: the new render starts its own watcher.
    if (entries.some((entry) => !document.querySelector(`[data-entry="${CSS.escape(entry.id)}"]`))) {
      render();
      return;
    }
    for (const slot of document.querySelectorAll('[data-download-for]')) {
      const entry = entries.find((item) => item.id === slot.dataset.downloadFor);
      slot.innerHTML = entry ? downloadLine(entry) : '';
    }
    const summary = document.querySelector('#queue-summary');
    if (summary) summary.textContent = queueSummary(queue);
    const warning = document.querySelector('#queue-warning');
    if (warning) warning.innerHTML = queueWarning(queue);
    if (!queue.counts.downloading && !queue.counts.waiting) return;
  }
}

async function restartDownloads(id, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Restarting…';
  try {
    const { message } = await api('/api/downloads/retry', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id } : {}),
    });
    toast(message || 'Mylar restarted the queue.');
    // Mylar picks the queue up a moment after answering; re-read rather than
    // leaving the card that was just restarted still reading "waiting".
    setTimeout(() => render(), 2500);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// A request that has found nothing looks exactly like one that is working:
// both say "Queued" and neither moves. The difference is whether anything has
// looked lately -- and Mylar's standing sweep runs once a day at most, so after
// a restart the next one can be two days out. Say that, and offer the search.
const relativeTime = (iso) => {
  const at = Date.parse(iso || '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.round((Date.now() - at) / 60_000);
  const ago = minutes >= 0;
  const size = Math.abs(minutes);
  const text = size < 90 ? `${size || 1} min`
    : size < 36 * 60 ? `${Math.round(size / 60)} hr`
    : `${Math.round(size / 1440)} days`;
  return ago ? `${text} ago` : `in ${text}`;
};

function searchStateHtml(activity) {
  const search = activity.search;
  // Mylar's own count of what it is still looking for, which can be larger
  // than Inkwell's list: a part queued elsewhere is still a part nothing has
  // found. Nothing honest to say when Mylar's record is not readable from here.
  const waiting = search?.waiting ?? 0;
  if (!search || !waiting) return '';
  const providers = search.providers.length;
  const next = search.sweepPaused
    ? 'Mylar’s scheduled search is paused, so nothing will look again on its own.'
    : search.nextSweep
      ? `Mylar looks again ${relativeTime(search.nextSweep)}.`
      : 'Mylar has no scheduled search on the books.';
  return `<div class="search-state">
    <div><b>${plural(waiting, 'part')} waiting on a search. ${info('still waiting')}</b>
      <p>${providers ? `${plural(providers, 'provider')} tried, most recently ${esc(relativeTime(search.lastRun))}. Nothing matched.` : 'No providers have run yet.'} ${esc(next)}</p></div>
    <button class="secondary" data-search-now>Search now</button>
  </div>`;
}

// "2026-09-07 11:58:12" from Mylar, or Inkwell's own epoch for the things Inkwell
// itself noticed. Either way it is rendered on the reader's clock.
function eventWhen(event) {
  const at = event.whenLocal ? mylarTime(event.whenLocal) : new Date(event.at);
  if (!at || Number.isNaN(at.getTime())) return '';
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// What happened while you were not looking. Deliberately short: this is a
// reassurance, not a log to be read.
function activityHtml(events) {
  if (!events?.items?.length) return '';
  return `<section class="request-activity">
    <div class="section-head"><span class="kicker no">03</span><h2>Recently ${info('recently')}</h2>
      <span class="kicker aside">${events.pushing ? 'Also pushed to your notifier' : 'Inkwell is not pushing these anywhere'}</span></div>
    <div class="event-list">${events.items.slice(0, 6).map((event) => `<div class="event-row${event.kind === 'stalled' ? ' warn' : ''}">
      ${/* Mylar's own wall clock when it has one: this browser shares that
             timezone and the server does not. */ ''}
      <span class="kicker">${esc(eventWhen(event))}</span>
      <div><b>${esc(event.title)}</b>${event.detail ? `<small>${esc(event.detail)}</small>` : ''}</div>
    </div>`).join('')}</div>
  </section>`;
}

async function searchNow(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Searching…';
  try {
    const { message } = await api('/api/requests/search', { method: 'POST' });
    toast(message || 'Mylar is searching.');
  } catch (error) { toast(error.message, 'error'); }
  button.disabled = false;
  button.textContent = original;
}

async function cancelPart(comicId, issueId, button) {
  button.disabled = true;
  button.textContent = 'Cancelling…';
  try {
    const { message } = await api(`/api/request/${encodeURIComponent(comicId)}/part/${encodeURIComponent(issueId)}/cancel`, { method: 'POST' });
    toast(message || 'Cancelled.');
    render();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Cancel';
    toast(error.message, 'error');
  }
}

// The one action here that throws work away, so it asks first. Files already
// downloaded are never touched -- the server refuses to pass a delete on.
async function stopSeries(comicId, name, button) {
  if (!window.confirm(`Stop tracking ${name}? Mylar forgets the series and its parts. Anything already downloaded stays in your library.`)) return;
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    const { message } = await api(`/api/request/${encodeURIComponent(comicId)}/stop`, { method: 'POST' });
    toast(message || 'Mylar is no longer tracking that series.');
    render();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Stop tracking';
    toast(error.message, 'error');
  }
}

async function abortDownload(id, button) {
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    const { message } = await api('/api/downloads/abort', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    toast(message || 'Mylar stopped that download.');
    setTimeout(() => render(), 1500);
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Stop';
    toast(error.message, 'error');
  }
}

// One book, one entry. This page used to be three lists of the same books --
// a text-only download queue, a covers-and-parts request list, and a shelf
// index underneath -- so a single omnibus could appear three times, twice
// without its cover, and a reader had to work out that they were the same
// thing. Everything Inkwell knows about a title now lands on one card: what
// Mylar is doing with it, which parts were asked for, and where to read it.
const requestState = (status) => ({
  Wanted: 'Waiting on a search', Snatched: 'Handed to the downloader', Downloaded: 'Downloaded',
  Archived: 'In library', Failed: 'Needs attention', Skipped: 'Not requested',
}[status] || status);

// Ordering is by what needs the reader's attention, not by name: something
// downloading now is worth more than the twelfth omnibus that arrived last week.
const ENTRY_RANK = { downloading: 0, attention: 1, waiting: 2, queued: 3, arrived: 4, library: 5, idle: 6 };

function entryStandingFrom(entry) {
  if (entry.download?.state === 'Downloading') return 'downloading';
  if (entry.parts.some((part) => part.status === 'Failed')) return 'attention';
  if (entry.parts.some((part) => part.status === 'Wanted')) return 'waiting';
  if (entry.download) return 'queued';
  if (entry.parts.some((part) => part.status === 'Snatched')) return 'arrived';
  if (entry.inLibrary) return 'library';
  return 'idle';
}

// Everything Inkwell holds about a title, keyed by the id Mylar, ComicVine and
// the download queue all happen to share.
function requestEntries({ shelf, activity, queue }) {
  const byId = new Map();
  const entry = (id, seed) => {
    if (!byId.has(id)) {
      byId.set(id, { id, title: '', publisher: null, year: null, cover: null,
        inLibrary: false, books: 0, readUrl: null, parts: [], download: null, waitingFiles: 0 });
    }
    const found = byId.get(id);
    for (const [key, value] of Object.entries(seed)) {
      if (value != null && value !== '' && (found[key] == null || found[key] === '' || found[key] === false)) found[key] = value;
    }
    return found;
  };

  for (const item of shelf) {
    entry(String(item.id), {
      title: item.title, publisher: item.publisher, year: item.year, cover: item.cover,
      inLibrary: item.inLibrary, books: item.books, readUrl: item.readUrl,
    });
  }
  for (const part of activity.items) {
    entry(String(part.comicId), {
      title: part.series, publisher: part.publisher, year: part.year, readUrl: part.readUrl,
    }).parts.push(part);
  }
  for (const file of queue?.items ?? []) {
    if (file.state === 'Completed') continue;
    const found = entry(String(file.comicId), { title: file.title });
    // The running file is the one worth naming; the rest are a count, because
    // a card listing four waiting files is a queue again.
    if (file.state === 'Downloading' && !found.download) found.download = file;
    else found.waitingFiles += 1;
  }

  const entries = [...byId.values()];
  for (const found of entries) {
    found.parts.sort((a, b) => Number(a.number) - Number(b.number));
    found.standing = entryStandingFrom(found);
  }
  return entries.sort((a, b) => (ENTRY_RANK[a.standing] - ENTRY_RANK[b.standing])
    || a.title.localeCompare(b.title));
}

// The line that says what is happening to this book right now. It is the only
// place a download appears, so it carries the file's own actions with it.
function downloadLine(entry) {
  const file = entry.download;
  const waiting = entry.waitingFiles
    ? `<span class="kicker">${plural(entry.waitingFiles, 'more file')} in the queue</span>` : '';
  if (!file) return waiting ? `<div class="entry-download">${waiting}</div>` : '';
  return `<div class="entry-download${file.state === 'Downloading' ? ' running' : ''}">
    <span class="kicker">${info('downloads')} ${esc(file.label)}${file.size ? ` · ${esc(file.size)}` : ''}${
      file.source ? ` · via ${esc(file.source)}` : ''}${
      file.changed ? ` · ${esc(sinceLabel(file.changed))} in this state` : ''}</span>
    <span class="entry-download-actions">
      <button class="secondary" data-retry-download="${esc(file.id)}">Restart</button>
      <button class="secondary quiet" data-abort-download="${esc(file.id)}">Stop</button>
    </span>${waiting}
  </div>`;
}

function requestCard(entry) {
  const stateLabel = entry.download?.state === 'Downloading' ? 'Downloading'
    : entry.parts.length ? requestState(entry.parts[0].status)
    : entry.inLibrary ? 'In library'
    : entry.download ? 'Waiting its turn' : 'Watching';
  const owned = entry.inLibrary || entry.parts.some((part) => ['Downloaded', 'Archived'].includes(part.status));
  return `<article class="request-series" data-entry="${esc(entry.id)}">
    <div class="request-series-head">
      <button class="request-series-cover" data-volume="${esc(entry.id)}" aria-label="${esc(entry.title)}">
        ${coverHtml({ id: entry.id, title: entry.title, cover: entry.cover || `/api/cover/${encodeURIComponent(entry.id)}` })}
      </button>
      <div>
        <span class="kicker state ${owned ? 'owned' : entry.standing === 'attention' ? 'attention' : ''}">${esc(stateLabel)}${
          entry.books ? ` · ${plural(entry.books, 'book')}` : ''}</span>
        <h3>${esc(entry.title)}</h3>
        <p>${esc([entry.publisher, entry.year].filter(Boolean).join(' · '))}</p>
      </div>
      <div class="request-series-actions">
        ${entry.readUrl ? `<a class="secondary" href="${esc(entry.readUrl)}" target="_blank" rel="noreferrer">Read</a>` : ''}
        <button class="secondary" data-request="${esc(entry.id)}">Manage parts</button>
        <button class="secondary quiet" data-stop-series="${esc(entry.id)}" data-series-name="${esc(entry.title)}">Stop tracking</button>
      </div>
    </div>
    <div class="entry-download-slot" data-download-for="${esc(entry.id)}">${downloadLine(entry)}</div>
    ${entry.parts.length ? `<div class="request-parts" data-parts-for="${esc(entry.id)}">${entry.parts.map((part, index) => {
      const canRetry = !['Downloaded', 'Archived', 'Snatched'].includes(part.status);
      return `<div class="request-part${index >= REQUEST_PARTS_SHOWN ? ' extra' : ''}"${index >= REQUEST_PARTS_SHOWN ? ' hidden' : ''}>
        <div><span class="kicker">${esc(part.number || '—')}</span>
          <b data-part-title="${esc(part.number || '')}">${esc(part.name || `Part ${part.number}`)}</b>
          <small data-part-blurb="${esc(part.number || '')}"></small>
          ${part.wantedSince ? `<small class="waiting-since">Asked for ${esc(part.wantedSince)}</small>` : ''}</div>
        <div class="request-part-action"><span class="kicker state ${['Downloaded', 'Archived'].includes(part.status) ? 'owned' : part.status === 'Failed' ? 'attention' : ''}">${esc(requestState(part.status))}</span>
          ${canRetry ? `<button class="secondary" data-retry-part="${esc(part.comicId)}/${esc(part.issueId)}">${part.status === 'Failed' ? 'Retry now' : 'Search again'}</button>` : ''}
          ${part.status === 'Wanted' ? `<button class="secondary quiet" data-cancel-part="${esc(part.comicId)}/${esc(part.issueId)}">Cancel</button>` : ''}</div></div>`;
    }).join('')}</div>` : ''}
    ${entry.parts.length > REQUEST_PARTS_SHOWN ? `<button class="request-unfurl kicker" data-unfurl="${esc(entry.id)}">
      Show all ${entry.parts.length} parts ↓</button>` : ''}
  </article>`;
}

routes.library = async () => {
  view.innerHTML = `<section class="lede" style="border:0"><span class="kicker" style="color:var(--accent)">Your shelf</span>
    <h1>What you asked for,<br />and what <em>arrived</em>.</h1></section>${skeletons(1, '1fr')}`;
  const [{ items, counts, komga }, activity, events, queue] = await Promise.all([
    loadShelf(), api('/api/requests'),
    api('/api/events').catch(() => ({ items: [] })),
    api('/api/downloads').catch(() => ({ items: [], counts: { downloading: 0, waiting: 0, done: 0, failed: 0 } })),
  ]);
  const entries = requestEntries({ shelf: items, activity, queue });
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
    <section class="request-activity">
      <div class="section-head"><span class="kicker no">01</span><h2>Requests ${info('requests')}</h2>
        <span class="kicker aside" id="queue-summary">${queueSummary(queue)}</span>
        <button class="secondary" data-refresh-requests>Refresh from Mylar</button></div>
      <p class="request-explainer">Everything you have asked Mylar for. A book stays here from the search, through the download, to the shelf — <em>Read</em> opens it in Komga.</p>
      ${searchStateHtml(activity)}
      <div id="queue-warning">${queueWarning(queue)}</div>
      <div class="request-center">${entries.length
        ? entries.map(requestCard).join('')
        : `<div class="empty">Choose a specific issue or volume and it will appear here with Mylar’s progress.</div>`}</div>
    </section>
    ${activityHtml(events)}
    ${komga ? '' : '<p class="kicker" style="color:var(--accent);padding-bottom:14px">Komga is not connected — every title will read as searching.</p>'}`;

  // After paint, never before it.
  const withParts = entries.filter((entry) => entry.parts.length).map((entry) => entry.id);
  if (withParts.length) hydrateRequestParts(withParts);
  watchQueue(entries.map((entry) => entry.id).join(','));
};

function shelfLibraryCard(item) {
  return `<article class="card shelf-library-card">
    <a class="cover-btn" href="${esc(item.readUrl)}" target="_blank" rel="noreferrer" aria-label="Read ${esc(item.title)} in Komga">
      ${coverHtml({ id: item.id, title: item.title, cover: item.cover })}
    </a>
    <div class="meta"><h3>${esc(item.title)}</h3>
      <span class="sub">${plural(item.books, 'book')} · ${item.unread ? `${item.unread} unread` : 'All read'}</span>
      <a class="secondary" href="${esc(item.readUrl)}" target="_blank" rel="noreferrer">Read in Komga ↗</a>
    </div>
  </article>`;
}

routes.shelf = async () => {
  view.innerHTML = `${lede('shelf', {
    kicker: 'My shelf',
    title: 'Everything you can<br /><em>read now</em>.',
    body: 'Your complete Komga library, including books imported outside Inkwell.',
  })}${skeletons(1, '1fr')}`;
  const data = await api('/api/shelf');
  const items = data.items || [];
  if (!data.komga) {
    view.innerHTML = `${lede('shelf', { kicker: 'My shelf', title: 'Your reading room<br /><em>is not connected</em>.' })}
      <div class="empty">Connect Komga in Inkwell’s configuration to see your complete library here.</div>`;
    return;
  }
  const unread = items.reduce((total, item) => total + Number(item.unread || 0), 0);
  view.innerHTML = `${lede('shelf', { kicker: 'My shelf', title: 'Everything you can<br /><em>read now</em>.' })}
    <div class="stats" style="border-top:0;margin:0 0 26px;padding-top:0">
      <div><span class="kicker">Series</span><b class="disp">${items.length}</b></div>
      <div><span class="kicker">Books</span><b class="disp">${items.reduce((total, item) => total + Number(item.books || 0), 0)}</b></div>
      <div><span class="kicker">Unread</span><b class="disp" style="color:var(--shelf)">${unread}</b></div>
    </div>
    <div class="shelf-toolbar"><input id="shelf-filter" type="search" placeholder="Search your shelf…" autocomplete="off" aria-label="Search your shelf" />
      <span class="kicker" id="shelf-filter-count"></span></div>
    <div class="grid" id="shelf-grid"></div>`;
  const grid = document.querySelector('#shelf-grid');
  const filter = document.querySelector('#shelf-filter');
  const count = document.querySelector('#shelf-filter-count');
  const paint = () => {
    const query = normaliseText(filter.value);
    const shown = query ? items.filter((item) => normaliseText(item.title).includes(query)) : items;
    grid.innerHTML = shown.length ? shown.map(shelfLibraryCard).join('')
      : '<div class="empty">Nothing on your shelf matches that search.</div>';
    count.textContent = query ? `${shown.length} of ${items.length}` : `${items.length} series`;
  };
  filter.addEventListener('input', paint);
  paint();
  const shelfCount = document.querySelector('#shelf-count');
  if (shelfCount) shelfCount.textContent = items.reduce((total, item) => total + Number(item.books || 0), 0);
};

/* ---------------- settings ---------------- */

const healthState = (available, ready, missing) => available ? ready : missing;

// Every one of these is a live service, and a page that waits on all four is
// as slow as the slowest. The settings page paints from what is known and
// fills these in when they answer.
function connectionsHtml(health) {
  if (!health) {
    return ['ComicVine', 'Mylar', 'Komga', 'Metron']
      .map((name) => `<article class="connection"><span class="kicker">&nbsp;</span><b>${name}</b>
        <p class="status muted">Checking…</p></article>`).join('');
  }
  const rate = health.comicvine?.limited
    ? `Cooling down · retry in ${Math.ceil((health.comicvine.retryInSeconds || 0) / 60)} min`
    : 'Available';
  // available means "a token is set"; reachable means the host answered. They
  // are different facts and the page used to report the first as the second.
  const metron = !health.metron?.available ? 'Not configured'
    : health.metron.reachable === true ? 'Connected'
    : health.metron.reachable === false ? `Not reachable · ${health.metron.reason || 'no answer'}`
    : 'Checking…';
  const metronState = !health.metron?.available ? 'muted'
    : health.metron.reachable === false ? 'warn' : 'good';
  const setup = health.setup;
  const setupNotice = setup?.ready ? '' : `<div class="empty" style="grid-column:1/-1;margin:0">
    <b>Inkwell is running, but setup needs attention.</b><br />
    ${setup?.discovery?.configured ? '' : 'Discovery is waiting for a ComicVine credential. '}
    ${setup?.requests?.configured ? '' : 'Requests are waiting for a Mylar API credential. '}
    Mount readable Mylar appdata or provide the corresponding server-side setting, then restart Inkwell. Komga remains optional.
  </div>`;
  return `
    ${setupNotice}
    <article class="connection"><span class="kicker">Catalogue</span><b>ComicVine</b><p class="status ${health.comicvine?.limited ? 'warn' : 'good'}">${esc(rate)}</p><small>Metadata, covers, people and series discovery.</small></article>
    <article class="connection"><span class="kicker">Requests</span><b>Mylar</b><p class="status ${health.mylar ? 'good' : 'warn'}">${health.mylar ? 'Connected' : 'Not answering'}</p><small>Watchlist and background searching.</small></article>
    <article class="connection"><span class="kicker">Library</span><b>Komga</b><p class="status ${health.komga ? 'good' : 'warn'}">${healthState(health.komga, 'Connected', 'Not connected')}</p><small>Shows what has actually arrived on your shelf.</small></article>
    <article class="connection"><span class="kicker">Supplement</span><b>Metron</b><p class="status ${metronState}">${esc(metron)}</p><small>Optional story-arc data. No token is required for Inkwell to work.</small></article>`;
}

routes.settings = async () => {
  // Local numbers are on disk and answer instantly; the connection panel is
  // the only part that depends on anything else, so it is the only part that
  // waits.
  const health = await api('/api/health').catch(() => null);
  const cache = health?.cache ?? { entries: 0 };
  const enrich = health?.enrichment ?? cache.enrichment ?? { pending: 0, done: 0 };
  const starts = [['discover', 'Discover'], ['browse', 'Browse'], ['threads', 'Characters & creators'], ['library', 'My requests']];
  view.innerHTML = `
    ${lede('settings', {
      kicker: 'Inkwell preferences',
      title: 'Make the reading room<br /><em>your own.</em>',
      body: 'These preferences only change Inkwell. Your Mylar, Komga and downloader setup stays untouched.',
    })}
    <section class="settings-section"><div class="section-head"><span class="kicker no">01</span><h2>Display</h2><span class="kicker aside">Saved on this device</span></div>
      <div class="settings-grid">
        <label class="setting"><span class="kicker">Start on</span><select data-setting="start-page">${starts.map(([value, label]) => `<option value="${value}"${setting('start-page', 'discover') === value ? ' selected' : ''}>${label}</option>`).join('')}</select><small>The page Inkwell opens to when you return.</small></label>
        <label class="setting"><span class="kicker">Poster size</span><input data-setting="poster" type="range" min="110" max="320" step="10" value="${poster.value}" /><small>${poster.value}px wide · changes every shelf and search grid.</small></label>
        <label class="setting"><span class="kicker">Results per page</span><select data-setting="page-size">${PAGE_SIZES.map((n) => `<option value="${n}"${n === pageSize() ? ' selected' : ''}>${n}</option>`).join('')}</select><small>Applies to publisher and search result pages.</small></label>
        <label class="setting toggle"><input data-setting="reduce-motion" type="checkbox"${settingOn('reduce-motion') ? ' checked' : ''} /><span><b>Reduce motion</b><small>Stops loading shimmer and other non-essential movement.</small></span></label>
      </div>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">02</span><h2>Requests</h2><span class="kicker aside">Mylar remains the request manager</span></div>
      <div class="settings-grid request-settings">
        <div class="setting"><span class="kicker">Choose before requesting</span><b>Collections open a volume picker</b><small>For a multi-volume collection, choose individual parts or request all of them. Inkwell then queues only those parts in Mylar.</small></div>
        <div class="setting"><span class="kicker">What happens next</span><b>Mylar searches in the background</b><small>Mylar, Prowlarr and your download client decide when a selected part arrives. Komga scans it after import.</small></div>
      </div>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">03</span><h2>Connections</h2><span class="kicker aside">Read-only diagnostics</span></div>
      <div class="connection-grid" id="connections">${connectionsHtml(health)}</div>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">04</span><h2>Local catalogue ${info('local catalogue')}</h2><span class="kicker aside">${(cache.volumes || 0).toLocaleString()} volumes · ${(cache.objects || 0).toLocaleString()} people & things · ${(cache.covers || 0).toLocaleString()} covers</span></div>
      <div class="cache-card"><div><b>Builds a local catalogue as you browse</b><p>Every ComicVine result Inkwell sees is kept in SQLite: volumes, characters, creators, teams, events and their known links. Repeat searches use local data first, then only ask ComicVine for information Inkwell has not learned yet.</p></div><button class="secondary" data-clear-cache>Clear response cache</button></div>
      <div class="cache-card enrichment-card"><div><b>Gentle enrichment is ${enrich.pending ? 'waiting' : 'caught up'}</b><p>${enrich.pending || 0} title${enrich.pending === 1 ? '' : 's'} queued · ${enrich.done || 0} enriched. Inkwell slowly fills in detail only for things you searched, opened, followed or requested. It pauses automatically when ComicVine rate-limits.</p></div></div>
      <p class="settings-note">Clearing response cache does not erase the local catalogue, its relationship links, requests, downloads or Mylar settings.</p>
    </section>
    <section class="settings-section"><div class="section-head"><span class="kicker no">05</span><h2>Reset</h2></div>
      <div class="cache-card"><div><b>Reset this device’s Inkwell preferences</b><p>Returns the start page, poster size, page size and request confirmation to their defaults. Server data is unaffected.</p></div><button class="secondary" data-reset-preferences>Reset preferences</button></div>
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
      <p class="sort-note kicker">ComicVine names them on the book as a whole. It is not a claim that they appear in every issue of it.</p>
      ${groups.map((group) => `<div class="related-group"><button class="chip kicker" ${threadAttrs(group)}>${esc(group.name)} · named by ComicVine →</button>
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
            <span class="kicker">Created by ${info('created by')}</span>
            <div class="chips">${item.creators.map((c) =>
              `<button class="chip kicker" ${threadAttrs({ kind: 'person', id: c.id, name: c.name })}>${esc(c.name)}</button>`).join('')}</div>
          </div>` : ''}
          ${item.characters?.length ? `<div class="credits">
            <span class="kicker">Featuring ${info('featuring')}</span>
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
            ${/* The end of the whole journey. If it is already on the shelf,
                  the most useful button on this sheet is the one that opens
                  it. */ ''}
            ${item.owned?.readUrl ? `<a class="secondary" href="${esc(item.owned.readUrl)}" target="_blank" rel="noreferrer">Read in Komga ↗</a>` : ''}
            ${externalUrl(item.url) ? `<a class="kicker" href="${esc(externalUrl(item.url))}" target="_blank" rel="noreferrer">View on ComicVine ↗</a>` : ''}
          </div>
          ${item.owned ? `<p class="picker-note owned">Already on your shelf${
            item.owned.books ? ` — ${plural(item.owned.books, 'book')}${item.owned.unread ? `, ${item.owned.unread} unread` : ''}` : ''}.</p>` : ''}
          <p class="action-scope">${info('request scope')} <b>Request</b> ${esc(requestScope)}${isCollection ? ''
            : ' <b>Follow this series</b> adds it to Mylar’s watchlist and keeps taking every future issue.'}</p>
          ${canChooseParts ? `<div id="collection-request" class="collection-request" data-part-noun="${partNoun}" data-preselect-parts="${isCollection}"></div>` : ''}
        </div>
      </div>
      ${relatedSection(item.related?.creators, 'Books that name these creators')}
      ${relatedSection(item.related?.characters, 'Books that name these characters')}`;
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
  const preselect = slot.dataset.preselectParts === 'true';
  // Two things worth knowing before choosing, neither of them a refusal: a
  // second copy is occasionally the point, and Inkwell does not get to decide.
  const owned = options.owned ? `<p class="picker-note owned">Already on your shelf in Komga${
    options.owned.books ? ` — ${plural(options.owned.books, 'book')}` : ''}. ${
    options.owned.readUrl ? `<a href="${esc(options.owned.readUrl)}" target="_blank" rel="noreferrer">Read it</a> instead, or request it again if you want another copy.` : ''}</p>` : '';
  const queued = options.queued?.length ? `<p class="picker-note">Already in the download queue: ${
    options.queued.map((item) => `${esc(item.title)}${item.size ? ` (${esc(item.size)})` : ''}`).join(', ')}.</p>` : '';
  slot.innerHTML = `<section class="part-picker">
    <div class="part-picker-head"><span class="kicker" style="color:var(--accent)">${preselect ? 'Confirm' : 'Choose'} ${esc(noun)}s</span>
      ${owned}${queued}
      <p>${preselect
        ? `All ${parts.filter((part) => part.requestable).length} selected. Uncheck anything you want to skip.`
        : `Pick the ${esc(noun)}s you want. To take every future one instead, use <b>Follow this series</b>.`}</p></div>
    <div class="part-list">${parts.map((part) => `<label class="part-row ${part.requestable ? '' : 'done'}">
      <input type="checkbox" data-part-number="${esc(part.number)}" ${part.requestable ? (preselect ? 'checked' : '') : 'disabled'} />
      <span class="part-cover" data-part-cover="${esc(part.number)}" hidden></span>
      <span class="part-copy"><b data-part-picker-title="${esc(part.number)}">${esc(partName(part, noun))}</b><small>${esc(part.status === 'Skipped' ? 'Not requested yet' : part.status)}</small></span>
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

// Covers are decoration around an already-usable Mylar picker. Fetch them after
// paint, and leave the title-only rows alone whenever ComicVine is unavailable.
async function hydratePartPicker(volumeId) {
  let items;
  try { ({ items } = await api(`/api/volume/${encodeURIComponent(volumeId)}/issues`)); }
  catch { return; }
  const picker = document.querySelector('#collection-request');
  if (!picker || !items?.length) return;
  const noun = picker.dataset.partNoun || 'part';
  const byNumber = new Map(items.map((item) => [String(item.number), item]));
  for (const input of picker.querySelectorAll('[data-part-number]')) {
    const issue = byNumber.get(input.dataset.partNumber);
    if (!issue) continue;
    const row = input.closest('.part-row');
    const title = row?.querySelector(`[data-part-picker-title="${CSS.escape(input.dataset.partNumber)}"]`);
    if (title && issue.name && !/^(?:volume|part|issue)\s*\d+$/i.test(issue.name)) {
      title.textContent = partName({ number: input.dataset.partNumber, name: issue.name }, noun);
    }
    const cover = row?.querySelector(`[data-part-cover="${CSS.escape(input.dataset.partNumber)}"]`);
    if (cover && issue.cover) {
      cover.innerHTML = `<img src="${esc(issue.cover)}" alt="Cover for ${esc(partName({ number: issue.number, name: issue.name }, noun))}" loading="lazy" />`;
      cover.hidden = false;
      row.classList.add('has-cover');
    }
  }
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
    hydratePartPicker(id);
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
    toast(result.message || (result.queued
      ? `${result.queued} selected volume${result.queued === 1 ? '' : 's'} added to Mylar.`
      : 'Those selected volumes were already being handled by Mylar.'));
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
  const testMylar = event.target.closest('[data-test-mylar]');
  if (testMylar && !testMylar.disabled) {
    const result = document.querySelector('[data-mylar-test]');
    testMylar.disabled = true;
    testMylar.textContent = 'Testing…';
    try {
      await api('/api/setup/mylar-test');
      if (result) { result.textContent = 'Mylar answered successfully.'; result.className = 'status good'; }
    } catch (error) {
      if (result) { result.textContent = error.message; result.className = 'status warn'; }
    } finally {
      testMylar.disabled = false;
      testMylar.textContent = 'Test Mylar connection';
    }
    return;
  }
  const completeSetup = event.target.closest('[data-complete-setup]');
  if (completeSetup && !completeSetup.disabled) {
    const acknowledge = document.querySelector('[data-acknowledge-trusted-lan]');
    if (acknowledge && !acknowledge.checked) {
      toast('Confirm the trusted-LAN access model before finishing setup.', 'error');
      return;
    }
    completeSetup.disabled = true;
    completeSetup.textContent = 'Finishing…';
    try {
      await api('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acknowledgeTrustedLan: Boolean(acknowledge?.checked) }),
      });
      installationSetup = null;
      go('/discover');
      toast('Inkwell is ready.');
    } catch (error) {
      completeSetup.disabled = false;
      completeSetup.textContent = 'Finish setup';
      toast(error.message, 'error');
    }
    return;
  }
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
    if (!window.confirm('Clear Inkwell’s short-lived response cache? Your local catalogue, requests and library are not affected.')) return;
    clearCacheButton.disabled = true;
    clearCacheButton.textContent = 'Clearing…';
    try { await api('/api/cache/clear', { method: 'POST' }); toast('Catalogue cache cleared.'); render(); }
    catch (error) { clearCacheButton.disabled = false; clearCacheButton.textContent = 'Clear response cache'; toast(error.message, 'error'); }
    return;
  }
  const resetPreferences = event.target.closest('[data-reset-preferences]');
  if (resetPreferences) {
    if (!window.confirm('Reset Inkwell preferences on this device?')) return;
    try {
      ['start-page', 'reduce-motion', 'confirm-requests', 'poster', 'pagesize'].forEach((key) => localStorage.removeItem(`inkwell:${key}`));
      // Resetting preferences replays the page introductions too.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('inkwell:seen:')) localStorage.removeItem(key);
      }
    } catch { /* private mode */ }
    setPoster(150); setPageSize(48); applyAccessibility(); toast('Inkwell preferences reset.'); render();
    return;
  }
  // The ⓘ is a button inside clickable cards; it explains, it does not
  // navigate. On a touch screen there is no hover to open it with, and this
  // handler used to swallow the tap and show nothing at all — so the icons
  // were decoration on the device Inkwell is mostly read on.
  const tipButton = event.target.closest('.info, .term');
  if (tipButton) {
    event.preventDefault();
    event.stopPropagation();
    const opening = !tipButton.classList.contains('open');
    closeTips();
    if (opening) { placeTip(tipButton); tipButton.classList.add('open'); }
    return;
  }
  closeTips();
  const thread = event.target.closest('[data-thread]');
  if (thread) {
    const name = thread.dataset.threadName;
    return go(`/thread/${thread.dataset.thread}${name ? `/${encodeURIComponent(name)}` : ''}`);
  }
  const collection = event.target.closest('[data-collection]');
  if (collection) return go(`/collection/${encodeURIComponent(collection.dataset.collection)}`);
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
  const threadPage = event.target.closest('[data-thread-page]');
  if (threadPage && state.thread) {
    const name = state.thread.name ? `/${encodeURIComponent(state.thread.name)}` : '';
    return go(`/thread/${state.thread.kind}/${state.thread.id}${name}/${threadPage.dataset.threadPage}`);
  }
  const collectionPage = event.target.closest('[data-collection-page]');
  if (collectionPage && state.collection) return go(`/collection/${encodeURIComponent(state.collection.id)}/${collectionPage.dataset.collectionPage}`);
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
  const searchNowButton = event.target.closest('[data-search-now]');
  if (searchNowButton && !searchNowButton.disabled) return searchNow(searchNowButton);
  const cancelPartButton = event.target.closest('[data-cancel-part]');
  if (cancelPartButton && !cancelPartButton.disabled) {
    const [comicId, issueId] = cancelPartButton.dataset.cancelPart.split('/');
    return cancelPart(comicId, issueId, cancelPartButton);
  }
  const stopSeriesButton = event.target.closest('[data-stop-series]');
  if (stopSeriesButton && !stopSeriesButton.disabled) {
    return stopSeries(stopSeriesButton.dataset.stopSeries, stopSeriesButton.dataset.seriesName, stopSeriesButton);
  }
  const abortButton = event.target.closest('[data-abort-download]');
  if (abortButton && !abortButton.disabled) return abortDownload(abortButton.dataset.abortDownload, abortButton);
  const restartQueue = event.target.closest('[data-restart-queue]');
  if (restartQueue && !restartQueue.disabled) return restartDownloads('', restartQueue);
  const retryDownload = event.target.closest('[data-retry-download]');
  if (retryDownload && !retryDownload.disabled) return restartDownloads(retryDownload.dataset.retryDownload, retryDownload);
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

// A tooltip is 290px of absolutely positioned text hanging off a 17px button.
// Anchored left it runs past the right edge on an iPad, and the page now clips
// rather than scrolls -- so the words would simply be gone. Measure once when
// the pointer or focus arrives, then remember the answer on the element: this
// is not in a pointermove path, and the result cannot change until layout does.
function placeTip(el) {
  if (!el || el.dataset.tipPlaced === String(window.innerWidth)) return;
  el.dataset.tipPlaced = String(window.innerWidth);
  const { left } = el.getBoundingClientRect();
  // 290px is the tooltip's max-width; leave a gutter so it never kisses the edge.
  el.classList.toggle('right', left + 306 > document.documentElement.clientWidth);
}
function closeTips() {
  for (const open of document.querySelectorAll('.info.open, .term.open')) open.classList.remove('open');
}
// Everything that means "I am done reading that": another tap, a key, the page
// moving under it. Scroll is passive and only fires while one is open.
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTips(); });
window.addEventListener('scroll', () => {
  if (document.querySelector('.info.open, .term.open')) closeTips();
}, { passive: true });

document.addEventListener('pointerover', (event) => {
  const tip = event.target.closest?.('.info, .term');
  if (tip) placeTip(tip);
}, { passive: true });
document.addEventListener('focusin', (event) => {
  const tip = event.target.closest?.('.info, .term');
  if (tip) placeTip(tip);
});

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
