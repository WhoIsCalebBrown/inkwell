// Supplementing one source with another.
//
// ComicVine is the breadth source and is authoritative for identity: it is what
// the request pipeline keys on, so a supplement must never change what a book
// IS. It fills gaps and records where each addition came from.
//
// Cost shapes where this can be used. A supplement provider is slow and
// rate-limited (Metron is serialised at seconds per call), so enrichment belongs
// on detail views — one volume, one thread — and never on a list. Enriching 120
// search results would take minutes and get the host banned.

// Fields a supplement may fill when the primary source has nothing. Identity
// fields (id, title, publisher) are deliberately absent: those are ComicVine's.
const FILLABLE = ['description', 'edition', 'year', 'issues', 'cover', 'url'];

const isEmpty = (value) =>
  value === null || value === undefined || value === '' || value === 0;

/**
 * Merge supplement candidates into a primary record.
 * Earlier candidates win over later ones; the primary always wins over all.
 * Returns a new object plus a `sources` map recording what came from where.
 */
export function supplement(primary, candidates = []) {
  const merged = { ...primary };
  const sources = {};

  for (const { provider, data } of candidates) {
    if (!data) continue;
    for (const field of FILLABLE) {
      if (!isEmpty(merged[field]) || isEmpty(data[field])) continue;
      merged[field] = data[field];
      sources[field] = provider;
    }
  }

  // Only attach provenance when something was actually added, so an
  // un-supplemented record is byte-identical to what it was before.
  return Object.keys(sources).length ? { ...merged, supplementedBy: sources } : merged;
}
