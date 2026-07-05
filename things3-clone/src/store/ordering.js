// Fractional ordering for drag-to-reorder.
//
// The old reorder wrote every sibling's `order` to its index (0,1,2,…). Under the
// CRDT that means a reorder rewrites *all* siblings, so two people reordering the
// same list concurrently clobber each other — one device's entire ordering wins
// (last-writer-wins per field), and interleaved ops can even scramble the list.
//
// Instead we keep `order` a number and, on reorder, rewrite ONLY the items that
// actually moved out of position, giving each a fractional key strictly between
// its neighbours. Concurrent reorders that touch different items no longer
// collide; if two devices move the *same* item, LWW on that one field decides
// deterministically — nothing else is disturbed. This is the fractional-indexing
// technique (the right sequence-CRDT primitive for our whole-state snapshot
// bridge, where the engine sees resulting order, not granular move ops); a real
// Y.Array would need move events we don't have at that layer.
//
// `order` stays numeric, so every existing sort (selectors.byOrder, query.js, …)
// and all existing data keep working with no migration.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// relabel(items) — items are {id, order} in their desired visual order. Returns a
// Map id -> newOrder containing ONLY the items whose order must change to make the
// sequence strictly increasing. Items already in increasing order keep their key.
export function relabel(items) {
  const changes = new Map();
  let prev = -Infinity;
  for (let i = 0; i < items.length; i++) {
    const cur = num(items[i].order);
    if (cur !== null && cur > prev) {
      prev = cur; // already ordered correctly — leave it untouched
      continue;
    }
    // Find the next item that already sits above `prev`; insert between them.
    let next = Infinity;
    for (let j = i + 1; j < items.length; j++) {
      const o = num(items[j].order);
      if (o !== null && o > prev) {
        next = o;
        break;
      }
    }
    let key;
    if (prev === -Infinity) key = next === Infinity ? 0 : next - 1;
    else if (next === Infinity) key = prev + 1;
    else key = (prev + next) / 2;

    // Float exhaustion guard: if a gap gets too tight to subdivide, fall back to
    // nudging past prev (still strictly increasing; keys can be rebalanced later).
    if (!(key > prev)) key = prev + 1;

    changes.set(items[i].id, key);
    prev = key;
  }
  return changes;
}

// orderedItems(ids, byId) — build the {id, order} list `relabel` expects from an
// ordered id list and a lookup (Map or object) of the current entities.
export function orderedItems(ids, lookup) {
  const get = lookup instanceof Map ? (id) => lookup.get(id) : (id) => lookup[id];
  return ids.map((id) => ({ id, order: (get(id) || {}).order }));
}
