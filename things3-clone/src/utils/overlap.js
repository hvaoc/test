// Lay out overlapping timed items side by side (like a calendar): items that
// overlap in time form a cluster and are split into equal-width columns.
// Returns a Map of task.id -> { col, count }.
const DEFAULT_DUR = 60;

export function layoutOverlaps(timed) {
  const items = timed
    .map((t) => ({ id: t.id, s: t.startMinutes, e: t.startMinutes + (t.durationMinutes || DEFAULT_DUR) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out = new Map();
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const count = cluster.reduce((m, c) => Math.max(m, c.col + 1), 1);
    cluster.forEach((c) => out.set(c.id, { col: c.col, count }));
    cluster = [];
    clusterEnd = -1;
  };
  items.forEach((it) => {
    if (cluster.length && it.s >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.e > it.s).map((c) => c.col));
    let col = 0;
    while (used.has(col)) col += 1;
    cluster.push({ id: it.id, e: it.e, col });
    clusterEnd = Math.max(clusterEnd, it.e);
  });
  if (cluster.length) flush();
  return out;
}
