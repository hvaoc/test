// Tiny event bus so any component can open the (app-level) auth modal, keeping
// Login / Sign Up as a first-class flow instead of something buried in Settings.
let opener = null;

// The AuthSheet registers itself here; returns an unregister function.
export function registerAuthOpener(fn) {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

// Open the auth modal. mode: 'login' | 'signup'. Optional opts, e.g. { reason }.
export function openAuth(mode = 'login', opts = {}) {
  if (opener) opener(mode, opts);
}
