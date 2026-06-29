// Lightweight unique id generator. We avoid pulling in a uuid dependency for a
// prototype; collision risk is negligible for a single-device todo app.
export function uid(prefix = 'id') {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}${rand}`;
}
