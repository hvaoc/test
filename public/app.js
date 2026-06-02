/* ===========================================================================
   PlayMap frontend.
   - Renders real OpenStreetMap tiles via Leaflet (styled as a cartoon in CSS).
   - Streams real-time events over Socket.IO from the backend.
   - If the backend isn't reachable, falls back to a built-in simulator so the
     prototype is always alive.
   =========================================================================== */

const EVENT_TYPES = [
  { type: "party", emoji: "🎉", label: "Street party" },
  { type: "food", emoji: "🍕", label: "Food truck" },
  { type: "music", emoji: "🎵", label: "Live music" },
  { type: "sports", emoji: "⚽", label: "Pickup game" },
  { type: "market", emoji: "🛍️", label: "Pop-up market" },
  { type: "art", emoji: "🎨", label: "Street art" },
  { type: "nature", emoji: "🌳", label: "Park meetup" },
  { type: "alert", emoji: "🚧", label: "Roadworks" },
  { type: "pet", emoji: "🐶", label: "Dog walk" },
  { type: "coffee", emoji: "☕", label: "Coffee crew" },
];
const emojiFor = (t) => (EVENT_TYPES.find((e) => e.type === t) || EVENT_TYPES[0]).emoji;

const DEFAULT_CENTER = { lat: 51.505, lng: -0.09 }; // London — overridden by geolocation.
const MAX_MARKERS = 80;

// ---------------------------------------------------------------------------
// Map setup — genuine OSM tiles, cartoonified by style.css.
// ---------------------------------------------------------------------------
const map = L.map("map", { zoomControl: true, attributionControl: true }).setView(
  [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
  15
);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '🗺️ PlayMap · map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

let center = { ...DEFAULT_CENTER };
let meMarker = null;
const markers = new Map(); // id -> { marker, at }

function makeIcon(emoji, opts = {}) {
  const cls = ["pin", opts.mine ? "pin--mine" : "", opts.fresh ? "pin--fresh" : ""].join(" ").trim();
  return L.divIcon({
    className: "pin-wrap",
    html: `<div class="${cls}"><span>${emoji}</span></div>`,
    iconSize: [46, 46],
    iconAnchor: [23, 46],
    popupAnchor: [0, -44],
  });
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// Adding events to the map + feed
// ---------------------------------------------------------------------------
const feedList = document.getElementById("feed-list");

function addEvent(ev, { fresh = true } = {}) {
  if (markers.has(ev.id)) return;

  const marker = L.marker([ev.lat, ev.lng], {
    icon: makeIcon(ev.emoji, { mine: ev.mine, fresh }),
  }).addTo(map);

  marker.bindPopup(
    `<div class="pop-title">${ev.emoji} ${escapeHtml(ev.title)}</div>` +
      `<div class="pop-meta">by ${escapeHtml(ev.author)} · <span data-ago="${ev.at}">${timeAgo(ev.at)}</span></div>`
  );

  markers.set(ev.id, { marker, at: ev.at });
  pruneMarkers();
  addToFeed(ev);
}

function addToFeed(ev) {
  const li = document.createElement("li");
  li.className = "feed__item" + (ev.mine ? " mine" : "");
  li.innerHTML =
    `<span class="feed__emoji">${ev.emoji}</span>` +
    `<span class="feed__text"><b>${escapeHtml(ev.title)}</b>` +
    `<small>${escapeHtml(ev.author)} · ${timeAgo(ev.at)}</small></span>`;
  li.addEventListener("click", () => {
    map.flyTo([ev.lat, ev.lng], 17, { duration: 0.6 });
    const m = markers.get(ev.id);
    if (m) m.marker.openPopup();
  });
  feedList.prepend(li);
  while (feedList.children.length > 30) feedList.lastChild.remove();
}

function pruneMarkers() {
  if (markers.size <= MAX_MARKERS) return;
  // Drop the oldest markers first.
  const sorted = [...markers.entries()].sort((a, b) => a[1].at - b[1].at);
  const toRemove = sorted.slice(0, markers.size - MAX_MARKERS);
  for (const [id, { marker }] of toRemove) {
    map.removeLayer(marker);
    markers.delete(id);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Keep "Xs ago" labels ticking.
setInterval(() => {
  document.querySelectorAll("[data-ago]").forEach((el) => {
    el.textContent = timeAgo(Number(el.dataset.ago));
  });
  // Feed timestamps are static text; cheap enough to leave as-is.
}, 15000);

// ---------------------------------------------------------------------------
// Transport: Socket.IO if available, otherwise a local simulator.
// ---------------------------------------------------------------------------
const statusEl = document.getElementById("status");
let transport = null;

function setStatus(text, live) {
  statusEl.textContent = text;
  statusEl.classList.toggle("status--live", live);
  statusEl.classList.toggle("status--demo", !live);
}

function connect() {
  if (window.__noSocket || typeof io === "undefined") {
    startSimulator();
    return;
  }
  const socket = io({ reconnectionAttempts: 3, timeout: 4000 });
  let connected = false;

  socket.on("connect", () => {
    connected = true;
    setStatus("● live", true);
    socket.emit("setLocation", { lat: center.lat, lng: center.lng, radiusKm: 1.5 });
  });
  socket.on("event", (ev) => addEvent(ev));
  socket.on("disconnect", () => setStatus("reconnecting…", false));
  socket.io.on("reconnect_failed", () => {
    if (!connected) startSimulator();
  });

  // If the socket never connects, fall back after a moment.
  setTimeout(() => {
    if (!connected) {
      socket.close();
      startSimulator();
    }
  }, 4500);

  transport = {
    post: (activity) => socket.emit("postActivity", activity),
    setLocation: (loc) => socket.emit("setLocation", loc),
  };
}

// Built-in client-side simulator (used when there's no backend).
function startSimulator() {
  setStatus("● demo mode", false);
  let nextId = -1; // negative ids never collide with server ids
  const NAMES_A = ["Sunny", "Cosy", "Mega", "Wild", "Happy", "Sparkly", "Brave", "Jolly"];
  const NAMES_B = ["Otter", "Fox", "Panda", "Robin", "Bee", "Hedgehog", "Dolphin", "Koala"];
  const VERBS = ["kicked off", "is buzzing", "rolled in", "started", "popped up", "is on"];
  const rand = (a) => a[Math.floor(Math.random() * a.length)];

  function spawn() {
    const kind = rand(EVENT_TYPES);
    const r = 1.5 / 111;
    const w = r * Math.sqrt(Math.random());
    const t = 2 * Math.PI * Math.random();
    addEvent({
      id: nextId--,
      type: kind.type,
      emoji: kind.emoji,
      title: `${kind.label} ${rand(VERBS)}`,
      author: `${rand(NAMES_A)} ${rand(NAMES_B)}`,
      lat: center.lat + w * Math.cos(t),
      lng: center.lng + (w * Math.sin(t)) / Math.cos((center.lat * Math.PI) / 180),
      at: Date.now(),
    });
    setTimeout(spawn, 2500 + Math.random() * 4500);
  }
  for (let i = 0; i < 6; i++) spawn.call(null);
  setTimeout(spawn, 1500);

  transport = {
    post: (activity) => addEvent({ ...activity, id: nextId--, emoji: emojiFor(activity.type), at: Date.now(), mine: true }),
    setLocation: () => {},
  };
}

// ---------------------------------------------------------------------------
// Geolocation: centre on the player, then start the stream.
// ---------------------------------------------------------------------------
function placeMe() {
  if (meMarker) meMarker.setLatLng([center.lat, center.lng]);
  else meMarker = L.marker([center.lat, center.lng], { icon: L.divIcon({ className: "me-wrap", html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map);
}

function init() {
  placeMe();
  connect();
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([center.lat, center.lng], 16);
        placeMe();
        if (transport) transport.setLocation({ lat: center.lat, lng: center.lng, radiusKm: 1.5 });
      },
      () => {}, // denied / unavailable — stick with the default city
      { enableHighAccuracy: true, timeout: 6000 }
    );
  }
}
init();

// ---------------------------------------------------------------------------
// "Post an activity" flow
// ---------------------------------------------------------------------------
const composer = document.getElementById("composer");
const typesEl = document.getElementById("composer-types");
const titleInput = document.getElementById("composer-title");
const authorInput = document.getElementById("composer-author");
let selectedType = EVENT_TYPES[0].type;
let placing = false;
let placeBanner = null;

// Build the emoji type picker.
EVENT_TYPES.forEach((t, i) => {
  const chip = document.createElement("button");
  chip.className = "type-chip" + (i === 0 ? " selected" : "");
  chip.title = t.label;
  chip.textContent = t.emoji;
  chip.addEventListener("click", () => {
    selectedType = t.type;
    typesEl.querySelectorAll(".type-chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
  });
  typesEl.appendChild(chip);
});

document.getElementById("post-btn").addEventListener("click", () => {
  composer.hidden = false;
  composer.classList.remove("is-placing");
});
document.getElementById("composer-cancel").addEventListener("click", closeComposer);

document.getElementById("composer-place").addEventListener("click", () => {
  // Enter "placing" mode: hide the card and wait for a map tap.
  placing = true;
  composer.classList.add("is-placing");
  placeBanner = document.createElement("div");
  placeBanner.className = "place-banner";
  placeBanner.textContent = `${emojiFor(selectedType)} Tap the map to drop it!`;
  document.body.appendChild(placeBanner);
});

map.on("click", (e) => {
  if (!placing) return;
  placing = false;
  if (placeBanner) { placeBanner.remove(); placeBanner = null; }

  const activity = {
    type: selectedType,
    title: titleInput.value.trim() || (EVENT_TYPES.find((t) => t.type === selectedType) || {}).label,
    author: authorInput.value.trim() || "You",
    lat: e.latlng.lat,
    lng: e.latlng.lng,
  };
  if (transport) transport.post(activity);
  map.flyTo([activity.lat, activity.lng], 17, { duration: 0.5 });
  closeComposer();
});

function closeComposer() {
  composer.hidden = true;
  composer.classList.remove("is-placing");
  placing = false;
  if (placeBanner) { placeBanner.remove(); placeBanner = null; }
  titleInput.value = "";
}

// Recentre button
document.getElementById("locate-btn").addEventListener("click", () => {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.flyTo([center.lat, center.lng], 16, { duration: 0.6 });
        placeMe();
        if (transport) transport.setLocation({ lat: center.lat, lng: center.lng, radiusKm: 1.5 });
      },
      () => map.flyTo([center.lat, center.lng], 16)
    );
  } else {
    map.flyTo([center.lat, center.lng], 16);
  }
});

// Feed collapse toggle
const feedPanel = document.getElementById("feed-panel");
document.getElementById("feed-toggle").addEventListener("click", () => {
  feedPanel.classList.toggle("is-collapsed");
});
