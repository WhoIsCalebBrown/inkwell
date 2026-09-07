// Panel — a front-end for the Publisher → Line → Thread → Volume model.
// A "thread" is whatever a reader follows: a character for superhero books,
// a creator for manga and creator-owned work, a team or an event where those fit.

const view = document.querySelector('#view');
const sheet = document.querySelector('#sheet');
const sheetBody = document.querySelector('#sheet-body');
const toastEl = document.querySelector('#toast');
const searchInput = document.querySelector('#search-input');

const state = { shelf: [], filters: {}, results: [], editions: [], query: '' };

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
const perPageSelect = (id) => `<label><span class="kicker">Per page</span>
  <select data-pagesize id="${id}">${PAGE_SIZES.map((n) =>
    `<option value="${n}"${n === pageSize() ? ' selected' : ''}>${n} titles</option>`).join('')}</select></label>`;

/* ---------------- plumbing ---------------- */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const esc = (value = '') =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    ? `<img src="${esc(item.cover || item.image)}" alt="" loading="lazy"
         onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'fallback',textContent:this.alt||''}))" />`
    : `<div class="fallback">${label}</div>`;
  return `<div class="cover" style="aspect-ratio:${ratio};background:${tint}">${inner}${
    flag ? `<span class="flag">${esc(flag)}</span>` : ''}</div>`;
}

/* ---------------- routing ---------------- */

const routes = {};
function go(path) { if (location.hash !== `#${path}`) location.hash = path; else render(); }

async function render() {
  const path = (location.hash || '#/discover').slice(1);
  const [, name, ...rest] = path.split('/');
  const route = routes[name] || routes.discover;
  document.querySelectorAll('#nav button').forEach((b) => {
    const active = b.dataset.route === name
      || (['thread', 'search', 'publisher'].includes(name) && b.dataset.route === 'browse');
    b.setAttribute('aria-current', String(active));
  });
  window.scrollTo({ top: 0 });
  try {
    await route(...rest);
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

function volumeCard(item) {
  const owned = item.requested || onShelf(item.id);
  return `<article class="card">
    <button class="cover-btn" data-volume="${esc(item.id)}" style="all:unset;cursor:pointer">
      ${coverHtml(item, { flag: owned ? 'On shelf' : '' })}
    </button>
    <div class="meta">
      <span class="kicker" style="color:${item.edition === 'Omnibus' ? 'var(--accent)' : 'var(--muted)'}">${
        esc([item.medium === 'manga' ? 'Manga' : null, item.edition].filter(Boolean).join(' · '))}</span>
      <h3>${esc(item.title)}</h3>
      <span class="sub">${[item.publisher, item.year, item.issues ? plural(item.issues, 'issue') : null].filter(Boolean).map(esc).join(' · ')}</span>
      <button class="act ${owned ? 'owned' : ''}" data-request="${esc(item.id)}" ${owned ? 'disabled' : ''}>
        ${owned ? 'On your shelf' : 'Request →'}
      </button>
    </div>
  </article>`;
}

/* ---------------- discover ---------------- */

routes.discover = async () => {
  view.innerHTML = `<section class="lede">
      <span class="kicker" style="color:var(--accent)">No. 01 — Your shelf</span>
      <h1>Follow a <em>thread</em>,<br />not an issue number.</h1>
      <p>Search a character, a creator or a book. Requesting hands it to Mylar, which
         hunts it down and files it into Komga.</p>
    </section>
    <div id="shelf-section">
      <div class="section-head"><span class="kicker no">01</span><h2>On your shelf</h2></div>
      ${skeletonRail(7)}
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
        <span class="kicker no">01</span><h2>On your shelf</h2>
        <span class="kicker aside">${counts.inLibrary} in library · ${counts.searching} still searching</span>
      </div>
      ${recent.length ? `<div class="rail">${recent.map((x) => `
        <article class="card">
          ${coverHtml(x, { flag: x.inLibrary ? 'In library' : '' })}
          <div class="meta"><h3>${esc(x.title)}</h3>
          <span class="sub">${esc(x.state)}${x.books ? ` · ${plural(x.books, 'book')}` : ''}</span></div>
        </article>`).join('')}</div>`
        : '<div class="empty">Nothing requested yet.</div>'}`;
  }).catch((e) => { shelfSection.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });

  const rails = document.querySelector('#rails');
  api('/api/discover').then(({ sections }) => {
    rails.innerHTML = sections.map((section, i) => `
      <div class="section-head">
        <span class="kicker no">0${i + 2}</span><h2>${esc(section.title)}</h2>
      </div>
      <div class="rail">${section.items.map(volumeCard).join('')}</div>`).join('');
  }).catch(() => { rails.innerHTML = '<div class="empty">ComicVine is not answering right now.</div>'; });
};

/* ---------------- browse ---------------- */

routes.browse = async () => {
  // Browse is a choice of axis, not a publisher list: publisher is only one of
  // the ways in, and leading with it hid formats and kinds entirely.
  view.innerHTML = `<section class="lede" style="border:0;padding-bottom:30px">
      <span class="kicker" style="color:var(--accent)">Browse</span>
      <h1>Find it the way<br />you already <em>think</em> about it.</h1>
      <p>By the house that published it, the shape of the book, or who made it.</p>
    </section>

    <div class="section-head"><span class="kicker no">01</span><h2>By format</h2>
      <span class="kicker aside">The shape of the book</span></div>
    <div class="chips">${
      ['Omnibus', 'Compendium', 'Absolute', 'Epic Collection', 'Masterworks',
       'Deluxe edition', 'Library edition', 'Hardcover', 'Collected edition']
        .map((f) => `<button class="chip kicker" data-format="${esc(f)}">${esc(f)}</button>`).join('')}</div>

    <div class="section-head"><span class="kicker no">02</span><h2>By kind</h2></div>
    <div class="chips">
      <button class="chip kicker" data-kind="comic">Comics</button>
      <button class="chip kicker" data-kind="manga">Manga</button>
    </div>

    <div class="section-head"><span class="kicker no">03</span><h2>By publisher</h2>
      <span class="kicker aside">Characters, imprints and the full catalogue</span></div>
    <div id="houses">${skeletons(5, 'repeat(auto-fill,minmax(160px,1fr))')}</div>`;

  const { items } = await api('/api/publishers');
  document.querySelector('#houses').innerHTML = `<div class="house-grid">${
    items.map((house) => `
      <button class="house-tile" data-publisher="${esc(house.name)}">
        <span class="house-logo">${house.logo
          ? `<img src="${esc(house.logo)}" alt="" loading="lazy" />`
          : `<span class="disp" style="font-size:22px">${esc(house.name.slice(0, 2))}</span>`}</span>
        <span class="disp house-name">${esc(house.name)}</span>
        <span class="kicker">${house.lines.length} imprints</span>
      </button>`).join('')}</div>`;
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
      <div class="section-head"><span class="kicker no">01</span><h2>Universes &amp; imprints</h2></div>
      <div class="chips">${house.lines.map((line) => `
        <button class="chip kicker" data-search="${esc(`${name} ${line}`)}">${esc(line)}</button>`).join('')}</div>` : ''}

    <div id="pub-chars-${slug}"></div>
    <div id="pub-teams-${slug}"></div>

    <div class="section-head"><span class="kicker no">04</span><h2>All titles</h2>
      <div class="aside filters" style="border:0;padding:0;grid-template-columns:auto">${perPageSelect('pub-size')}</div></div>
    ${pager('top')}
    <div class="grid">${data.items.map(volumeCard).join('')}</div>
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
              <button data-thread="${esc(t.kind)}/${esc(t.id)}" style="all:unset;cursor:pointer">
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
        `/api/publisher/${encodeURIComponent(name)}/characters`, '1 / 1');
  strip(document.querySelector(`#pub-teams-${slug}`), '03', 'Teams', 'Groups and line-ups',
        `/api/publisher/${encodeURIComponent(name)}/teams`, '1 / 1');
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
          <button data-thread="${esc(t.kind)}/${esc(t.id)}" style="all:unset;cursor:pointer">
            ${coverHtml({ id: t.id, name: t.name, image: t.image }, { ratio: '1 / 1' })}
          </button>
          <div class="meta"><h3>${esc(t.name)}</h3>
            <span class="sub">${esc(t.publisher || group.label)}</span></div>
        </article>`).join('')}</div>`).join('');
  }).catch(() => {});

  const books = document.querySelector('#books');
  try {
    await loadShelf().catch(() => {});
    state.query = query;
    state.filters = { format: 'all', medium: 'all', publisher: 'all', sort: 'relevance', ...(state.pendingFilters ?? {}) };
    state.pendingFilters = null;
    books.innerHTML = `<div class="section-head"><h2>Books</h2>
        <span class="kicker aside" id="count"></span></div>
      <div class="filters" id="filters"></div>
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
    select('medium', 'Kind', [['all', 'Comics & manga'], ['comic', 'Comics only'], ['manga', 'Manga only']]) +
    select('format', 'Format', [['all', 'All formats'], ...editions.map((e) => [e, e])]) +
    select('publisher', 'Publisher', [['all', 'All publishers'], ...publishers.map((p) => [p, p])]) +
    select('sort', 'Sort', [
      ['relevance', 'Best match'],
      ['notable', 'Most notable'],
      ['newest', 'Newest'],
      ['issues', 'Most issues'],
      ['title', 'A–Z'],
    ]) +
    perPageSelect('search-size');
}

function renderResults() {
  const { publisher, sort } = state.filters;
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

routes.thread = async (kind, id) => {
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
  const [thread] = await Promise.all([api(`/api/thread/${kind}/${id}`), loadShelf().catch(() => {})]);
  const stat = (label, value) => value
    ? `<div><span class="kicker">${label}</span><b class="disp">${esc(value)}</b></div>` : '';

  view.innerHTML = `
    <div class="chips" style="padding:26px 0 4px">
      ${[thread.publisher, thread.kind === 'person' ? 'Creator' : thread.kind === 'story_arc' ? 'Event'
         : thread.kind === 'team' ? 'Team' : 'Character'].filter(Boolean)
        .map((x) => `<span class="kicker">${esc(x)}</span>`).join('<span class="kicker" style="color:var(--faint)">/</span>')}
    </div>
    <section class="thread">
      <div>${coverHtml({ id: thread.id, name: thread.name, image: thread.image }, { ratio: '3 / 4' })}</div>
      <div>
        <span class="kicker" style="color:var(--accent)">The thread</span>
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
    ${thread.teams?.length ? `
      <div class="section-head"><span class="kicker no">01</span><h2>Also appears with</h2>
        <span class="kicker aside">Teams and groups</span></div>
      <div class="chips">${thread.teams.map((t) =>
        `<button class="chip kicker" data-thread="${esc(t.kind)}/${esc(t.id)}">${esc(t.name)}</button>`).join('')}</div>` : ''}
    <div class="section-head"><span class="kicker no">${thread.teams?.length ? '02' : '01'}</span>
      <h2>Books</h2><span class="kicker aside">Oldest first</span></div>
    <div id="thread-books">${skeletons(12)}</div>`;

  // ComicVine cannot list a character's volumes (volume_credits is unreliable
  // and issue_credits runs to five figures), so this is a title search on the
  // thread's name — ordered by year to read as a run rather than a ranking.
  api(`/api/search?q=${encodeURIComponent(thread.name)}`)
    .then(({ items }) => {
      const ordered = [...items].sort((a, b) => (a.year || 9999) - (b.year || 9999));
      document.querySelector('#thread-books').innerHTML = ordered.length
        ? `<div class="grid">${ordered.map(volumeCard).join('')}</div>`
        : '<div class="empty">No books found for this thread.</div>';
    })
    .catch(() => { document.querySelector('#thread-books').innerHTML = '<div class="empty">Could not load books.</div>'; });
};

/* ---------------- library ---------------- */

routes.library = async () => {
  view.innerHTML = `<section class="lede" style="border:0"><span class="kicker" style="color:var(--accent)">Your shelf</span>
    <h1>What you asked for,<br />and what <em>arrived</em>.</h1></section>${skeletons(1, '1fr')}`;
  const { items, counts, komga } = await loadShelf();
  view.innerHTML = `
    <section class="lede" style="border:0;padding-bottom:26px">
      <span class="kicker" style="color:var(--accent)">Your shelf</span>
      <h1>What you asked for,<br />and what <em>arrived</em>.</h1>
    </section>
    <div class="stats" style="border-top:0;margin:0 0 26px;padding-top:0">
      <div><span class="kicker">Requested</span><b class="disp">${counts.watching}</b></div>
      <div><span class="kicker">In library</span><b class="disp" style="color:var(--shelf)">${counts.inLibrary}</b></div>
      <div><span class="kicker">Still searching</span><b class="disp" style="color:var(--accent)">${counts.searching}</b></div>
    </div>
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
    const explain = item.edition === 'Omnibus'
      ? 'An omnibus is one oversized book collecting a long run of issues — the whole story in a single volume.'
      : item.edition === 'Collected edition'
        ? 'A collected edition gathers a story arc or a handful of issues into one book.'
        : 'A regular series, collected issue by issue rather than as one book.';
    sheetBody.innerHTML = `
      <div class="sheet-top">
        <span class="kicker" style="color:var(--accent)">${esc(item.edition)}</span>
        <button id="close-sheet" aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <path d="M6 6l12 12M18 6L6 18"></path></svg>
        </button>
      </div>
      <div class="sheet-body">
        <div>${coverHtml(item, { flag: owned ? 'On shelf' : '' })}</div>
        <div>
          <h2>${esc(item.title)}</h2>
          <div class="stats" style="border-top:0;margin-top:18px;padding-top:0">
            ${item.publisher ? `<div><span class="kicker">Publisher</span><b class="disp">${esc(item.publisher)}</b></div>` : ''}
            ${item.year ? `<div><span class="kicker">Started</span><b class="disp">${esc(item.year)}</b></div>` : ''}
            ${item.issues ? `<div><span class="kicker">Issues</span><b class="disp">${esc(item.issues)}</b></div>` : ''}
          </div>
          <p class="copy">${esc(item.description || 'ComicVine has no description for this listing.')}</p>
          <div class="plain"><span class="kicker" style="color:var(--accent)">In plain English</span>
            <p style="margin:6px 0 0;color:var(--body);line-height:1.6">${esc(explain)}</p></div>
          ${item.creators?.length ? `<div class="credits">
            <span class="kicker">Created by</span>
            <div class="chips">${item.creators.map((c) =>
              `<button class="chip kicker" data-thread="person/${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>
          </div>` : ''}
          ${item.characters?.length ? `<div class="credits">
            <span class="kicker">Featuring</span>
            <div class="chips">${item.characters.map((c) =>
              `<button class="chip kicker" data-thread="character/${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>
          </div>` : ''}
          <div class="actions">
            <button class="primary" data-request="${esc(item.id)}" ${owned ? 'disabled' : ''}>
              ${owned ? 'Already on your shelf' : 'Request this volume'}
            </button>
            ${item.url ? `<a class="kicker" href="${esc(item.url)}" target="_blank" rel="noreferrer">View on ComicVine ↗</a>` : ''}
          </div>
        </div>
      </div>`;
  } catch (error) {
    sheetBody.innerHTML = `<div class="sheet-top"><span class="kicker">${esc(error.message)}</span></div>`;
  }
}

async function request(id, button) {
  const original = button.textContent.trim();
  button.disabled = true;
  button.textContent = 'Requesting…';
  try {
    await api('/api/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    button.textContent = 'Requested';
    button.classList.add('owned');
    // Mylar searches every provider with a delay between each, so the shelf
    // will not update for minutes — say so rather than implying it is done.
    toast('Added to Mylar. It searches GetComics and your Prowlarr indexers in the background.');
    loadShelf().catch(() => {});
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error.message, 'error');
  }
}

/* ---------------- events ---------------- */

document.addEventListener('click', (event) => {
  const thread = event.target.closest('[data-thread]');
  if (thread) return go(`/thread/${thread.dataset.thread}`);
  const search = event.target.closest('[data-search]');
  if (search) {
    const scope = search.dataset.publisher ? `/${encodeURIComponent(search.dataset.publisher)}` : '';
    return go(`/search/${encodeURIComponent(search.dataset.search)}${scope}`);
  }
  const house = event.target.closest('[data-publisher]');
  if (house) return go(`/publisher/${encodeURIComponent(house.dataset.publisher)}`);
  const fmt = event.target.closest('[data-format]');
  if (fmt) {
    state.pendingFilters = { format: fmt.dataset.format };
    return go(`/search/${encodeURIComponent(fmt.dataset.format.toLowerCase())}`);
  }
  const kind = event.target.closest('[data-kind]');
  if (kind) {
    state.pendingFilters = { medium: kind.dataset.kind };
    return go(`/search/${encodeURIComponent(kind.dataset.kind === 'manga' ? 'manga' : 'comics')}`);
  }
  const pageBtn = event.target.closest('[data-page]');
  if (pageBtn && state.publisher) {
    return go(`/publisher/${encodeURIComponent(state.publisher.name)}/${pageBtn.dataset.page}`);
  }
  const volume = event.target.closest('[data-volume]');
  if (volume) return openVolume(volume.dataset.volume);
  const req = event.target.closest('[data-request]');
  if (req && !req.disabled) return request(req.dataset.request, req);
  if (event.target.closest('#close-sheet')) return sheet.close();
  const nav = event.target.closest('#nav button');
  if (nav) return go(`/${nav.dataset.route}`);
});

document.addEventListener('change', (event) => {
  const filter = event.target.closest('[data-filter]');
  if (!filter) return;
  state.filters[filter.dataset.filter] = filter.value;
  if (filter.dataset.filter === 'format' || filter.dataset.filter === 'medium') loadBooks();
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
