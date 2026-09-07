const $ = (s) => document.querySelector(s);
const state = { search: [], library: [], filters: { format: 'all', publisher: 'all', year: 'all', sort: 'relevance' }, currentQuery: '' };
const esc = (value = '') => String(value).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

async function api(url, options) { const r = await fetch(url, options); const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error || 'The catalogue could not complete that request.'); return data; }
function toast(message, type = '') { const el = $('#toast'); el.textContent = message; el.className = `show ${type}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = ''; }, 4000); }
function show(view) { document.querySelectorAll('.view').forEach((el) => el.classList.toggle('active-view', el.id === view)); document.querySelectorAll('.nav[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === view)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function setImage(img, item) { if (!item.cover) { img.style.display = 'none'; return; } img.src = item.cover; img.alt = `${item.title} cover`; img.onerror = () => { img.style.display = 'none'; }; }

function railCard(item) {
  const node = $('#rail-card-template').content.cloneNode(true); const card = node.querySelector('.rail-card'); const img = node.querySelector('img');
  setImage(img, item); node.querySelector('b').textContent = item.title; node.querySelector('span').textContent = [item.publisher, item.year].filter(Boolean).join(' · ');
  card.addEventListener('click', () => details(item)); return node;
}
function renderRails(sections) {
  const root = $('#discover-rails'); root.replaceChildren();
  for (const section of sections) { const node = $('#rail-template').content.cloneNode(true); node.querySelector('h2').textContent = section.title; const rail = node.querySelector('.rail-scroll'); rail.append(...section.items.map(railCard)); node.querySelector('.see-all').addEventListener('click', () => search(section.id === 'omnibus' ? 'omnibus' : section.title, section.id === 'omnibus' ? 'Omnibus' : null)); root.append(node); }
}
async function loadDiscovery() { $('#discover-rails').innerHTML = '<div class="empty">Loading collections…</div>'; try { renderRails((await api('/api/discover')).sections); } catch (e) { $('#discover-rails').innerHTML = '<div class="empty"><b>Discovery is unavailable</b><p>Try search while ComicVine reconnects.</p></div>'; toast(e.message, 'error'); } }

function resultCard(item, library = false) {
  const node = $('#result-template').content.cloneNode(true); const img = node.querySelector('img'); const badge = node.querySelector('.badge'); const request = node.querySelector('.request');
  setImage(img, item); node.querySelector('.publisher').textContent = item.publisher || 'Unknown publisher'; node.querySelector('h3').textContent = item.title;
  node.querySelector('.meta').textContent = [item.year, item.issues ? `${item.issues} issues` : null, library ? item.status : null].filter(Boolean).join(' · '); node.querySelector('.format').textContent = item.edition || (library ? 'On your shelf' : 'Series');
  if (library || item.requested) { badge.textContent = library ? (item.status || 'Watching') : 'Requested'; request.textContent = library ? 'On watchlist' : 'Already requested'; request.disabled = true; }
  else { request.textContent = 'Request'; request.addEventListener('click', () => requestTitle(item, request)); }
  node.querySelector('.more').addEventListener('click', () => details(item)); return node;
}
function filtered() { let list = [...state.search]; const f = state.filters; if (f.format !== 'all') list = list.filter((x) => x.edition === f.format); if (f.publisher !== 'all') list = list.filter((x) => x.publisher === f.publisher); if (f.year !== 'all') list = list.filter((x) => { const y = +x.year; return f.year === 'older' ? y && y < 2000 : y >= +f.year && y < +f.year + 10; }); if (f.sort === 'newest') list.sort((a, b) => +b.year - +a.year); if (f.sort === 'issues') list.sort((a, b) => b.issues - a.issues); if (f.sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title)); return list; }
function updatePublisherFilter() { const select = $('#publisher-filter'); const names = [...new Set(state.search.map((x) => x.publisher).filter(Boolean))].sort(); select.replaceChildren(new Option('All publishers', 'all'), ...names.map((x) => new Option(x, x))); }
function renderSearch() { const grid = $('#search-results'), empty = $('#search-empty'); grid.replaceChildren(); const list = filtered(); $('#search-count').textContent = `${list.length} of ${state.search.length} results`; if (!list.length) { empty.classList.remove('hidden'); return; } empty.classList.add('hidden'); grid.append(...list.map((item) => resultCard(item))); }
async function search(query, format = null) {
  query = query.trim(); if (query.length < 2) return; state.currentQuery = query; state.filters = { format: format || 'all', publisher: 'all', year: 'all', sort: 'relevance' };
  $('#search-input').value = query; $('#format-filter').value = state.filters.format; $('#year-filter').value = 'all'; $('#sort-filter').value = 'relevance'; $('#search-title').textContent = format === 'Omnibus' ? 'Omnibuses' : `Results for “${query}”`; $('#search-results').innerHTML = '<div class="empty">Searching ComicVine…</div>'; $('#search-count').textContent = ''; show('search');
  try { const { items } = await api(`/api/search?q=${encodeURIComponent(query)}`); if (state.currentQuery !== query) return; state.search = items; updatePublisherFilter(); renderSearch(); }
  catch (e) { $('#search-results').replaceChildren(); $('#search-empty').classList.remove('hidden'); toast(e.message, 'error'); }
}
async function loadLibrary() { try { const { items } = await api('/api/library'); state.library = items; $('#library-count').textContent = items.length || ''; const grid = $('#library-grid'), empty = $('#library-empty'); grid.replaceChildren(); if (!items.length) empty.classList.remove('hidden'); else { empty.classList.add('hidden'); grid.append(...items.map((x) => resultCard(x, true))); } } catch (e) { toast(e.message, 'error'); } }
async function requestTitle(item, button) { button.disabled = true; button.textContent = 'Requesting…'; try { await api('/api/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }) }); item.requested = true; button.textContent = 'Requested'; closeDetails(); loadLibrary(); toast(`${item.title} is now on your Mylar watchlist.`, 'success'); } catch (e) { button.disabled = false; button.textContent = 'Request'; toast(e.message, 'error'); } }
function details(item) { const dialog = $('#details'); const explanation = item.edition === 'Omnibus' ? 'An omnibus is one oversized book that collects a long run of issues.' : item.edition === 'Collected edition' ? 'A collected edition groups a story arc or several individual issues into one book.' : 'This listing is a regular comic series rather than a collected book.'; $('#detail-content').innerHTML = `<div class="detail"><div class="detail-cover">${item.cover ? `<img src="${esc(item.cover)}" alt="${esc(item.title)} cover">` : '<div class="no-cover">P</div>'}</div><div><p class="eyebrow">${esc(item.edition || 'Series')}</p><h2>${esc(item.title)}</h2><p class="meta">${[item.publisher, item.year, item.issues ? `${item.issues} issues` : null].filter(Boolean).map(esc).join(' · ')}</p><p class="detail-copy">${esc(item.description || 'ComicVine does not have a description for this listing.')}</p><p class="explain"><b>In plain English:</b> ${explanation}</p><div class="detail-actions"><button id="detail-request" ${item.requested ? 'disabled' : ''}>${item.requested ? 'Already requested' : 'Request series'}</button>${item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noreferrer">View on ComicVine ↗</a>` : ''}</div></div></div>`; const button = $('#detail-request'); if (!item.requested) button.addEventListener('click', () => requestTitle(item, button)); dialog.showModal(); }
function closeDetails() { const d = $('#details'); if (d.open) d.close(); }

$('#global-search').addEventListener('submit', (e) => { e.preventDefault(); search($('#search-input').value); });
document.querySelectorAll('[data-query]').forEach((button) => button.addEventListener('click', () => search(button.dataset.query)));
document.querySelectorAll('.nav[data-view]').forEach((button) => button.addEventListener('click', () => { show(button.dataset.view); if (button.dataset.view === 'library') loadLibrary(); }));
document.querySelector('[data-action="omnibus"]').addEventListener('click', () => search('omnibus', 'Omnibus'));
document.querySelectorAll('.filters select').forEach((select) => select.addEventListener('change', () => { state.filters[select.id.replace('-filter', '')] = select.value; renderSearch(); }));
$('#close-details').addEventListener('click', closeDetails); $('#details').addEventListener('click', (e) => { if (e.target === $('#details')) closeDetails(); });
$('#theme-button').addEventListener('click', () => document.documentElement.classList.toggle('light'));
window.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#search-input').focus(); } if (e.key === 'Escape') closeDetails(); });
loadDiscovery(); loadLibrary();
