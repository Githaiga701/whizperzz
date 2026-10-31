/**
 * "Did you mean…?" for the journey and destination filters. Small and cautious: it only suggests a word that
 * really appears on the page and is one or two letters away, so it's right far more often than it's annoying.
 */

/** Letters to change to turn `a` into `b` (Damerau–Levenshtein, adjacent swaps count as one). Stops early past `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j++) rows[i]![j] = i === 0 ? j : 0;
  }
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return rows[a.length]![b.length]!;
}

/**
 * A corrected version of `query`, fixing each word that isn't in `vocabulary` but is close to one that is.
 * Returns null when nothing needs fixing or no confident fix exists.
 */
export function suggestSpelling(query: string, vocabulary: readonly string[]): string | null {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const known = new Set(vocabulary.map((w) => w.toLowerCase()));
  let changed = false;
  const fixed = words.map((w) => {
    if (w.length < 3 || known.has(w) || [...known].some((k) => k.startsWith(w))) return w;
    // Short words get one letter of slack, longer ones two.
    const allowed = w.length <= 4 ? 1 : 2;
    let best: { word: string; d: number } | null = null;
    for (const k of known) {
      const d = editDistance(w, k, allowed);
      if (d <= allowed && (!best || d < best.d || (d === best.d && k.length < best.word.length))) best = { word: k, d };
    }
    if (!best) return w;
    changed = true;
    return best.word;
  });
  return changed ? fixed.join(' ') : null;
}
