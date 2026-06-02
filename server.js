// PlayMap — real-time local events & user activities on a kids-game-style map.
//
// The backend does two things:
//   1. Serves the static frontend in /public.
//   2. Runs a small real-time engine over Socket.IO that simulates "local
//      events" happening around each connected player and broadcasts the
//      activities players post themselves.
//
// There is no database — this is a prototype, so everything lives in memory.

import express from "express";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Event "flavours". These map onto the cartoon emoji markers on the frontend.
// ---------------------------------------------------------------------------
const EVENT_TYPES = [
  { type: "party", emoji: "🎉", label: "Street party", verbs: ["kicked off", "is buzzing", "started"] },
  { type: "food", emoji: "🍕", label: "Food truck", verbs: ["rolled in", "opened up", "is serving"] },
  { type: "music", emoji: "🎵", label: "Live music", verbs: ["started playing", "is jamming", "tuned up"] },
  { type: "sports", emoji: "⚽", label: "Pickup game", verbs: ["started", "needs players", "is on"] },
  { type: "market", emoji: "🛍️", label: "Pop-up market", verbs: ["opened", "set up shop", "is trading"] },
  { type: "art", emoji: "🎨", label: "Street art", verbs: ["appeared", "is being painted", "popped up"] },
  { type: "nature", emoji: "🌳", label: "Park meetup", verbs: ["gathered", "is hanging out", "met up"] },
  { type: "alert", emoji: "🚧", label: "Roadworks", verbs: ["started", "appeared", "is underway"] },
  { type: "pet", emoji: "🐶", label: "Dog walk", verbs: ["set off", "is rolling", "started"] },
  { type: "coffee", emoji: "☕", label: "Coffee crew", verbs: ["gathered", "is brewing", "met up"] },
];

const ADJECTIVES = ["Sunny", "Cosy", "Mega", "Tiny", "Wild", "Happy", "Sleepy", "Sparkly", "Brave", "Jolly"];
const NOUNS = ["Otter", "Fox", "Panda", "Robin", "Bumblebee", "Hedgehog", "Dolphin", "Badger", "Penguin", "Koala"];

const randItem = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randName = () => `${randItem(ADJECTIVES)} ${randItem(NOUNS)}`;

// Drop a random point within `radiusKm` of a centre coordinate.
function jitter(lat, lng, radiusKm = 1.5) {
  const r = radiusKm / 111; // ~degrees per km
  const u = Math.random();
  const v = Math.random();
  const w = r * Math.sqrt(u);
  const t = 2 * Math.PI * v;
  const dLat = w * Math.cos(t);
  const dLng = (w * Math.sin(t)) / Math.cos((lat * Math.PI) / 180);
  return { lat: lat + dLat, lng: lng + dLng };
}

let nextId = 1;
function makeEvent(center) {
  const kind = randItem(EVENT_TYPES);
  const pos = jitter(center.lat, center.lng, center.radiusKm || 1.5);
  return {
    id: nextId++,
    type: kind.type,
    emoji: kind.emoji,
    title: `${kind.label} ${randItem(kind.verbs)}`,
    author: randName(),
    lat: pos.lat,
    lng: pos.lng,
    at: Date.now(),
    simulated: true,
  };
}

io.on("connection", (socket) => {
  // Each player tells us where they are; we simulate events around them.
  let center = { lat: 51.505, lng: -0.09, radiusKm: 1.5 };
  let timer = null;

  const tick = () => {
    socket.emit("event", makeEvent(center));
    // Random cadence so it feels organic rather than metronomic.
    timer = setTimeout(tick, 2500 + Math.random() * 4500);
  };

  socket.on("setLocation", (loc) => {
    if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
      center = { lat: loc.lat, lng: loc.lng, radiusKm: loc.radiusKm || 1.5 };
    }
    if (!timer) {
      // Seed a small cluster immediately so the map isn't empty on load.
      for (let i = 0; i < 6; i++) socket.emit("event", makeEvent(center));
      tick();
    }
  });

  // A player posted their own activity — share it with everyone.
  socket.on("postActivity", (activity) => {
    if (!activity || !Number.isFinite(activity.lat) || !Number.isFinite(activity.lng)) return;
    const kind = EVENT_TYPES.find((e) => e.type === activity.type) || EVENT_TYPES[0];
    const event = {
      id: nextId++,
      type: kind.type,
      emoji: kind.emoji,
      title: (activity.title || kind.label).slice(0, 120),
      author: (activity.author || "You").slice(0, 40),
      lat: activity.lat,
      lng: activity.lng,
      at: Date.now(),
      simulated: false,
      mine: false,
    };
    socket.emit("event", { ...event, mine: true });
    socket.broadcast.emit("event", event);
  });

  socket.on("disconnect", () => clearTimeout(timer));
});

const PORT = process.env.PORT || 4173;
server.listen(PORT, () => {
  console.log(`🗺️  PlayMap running at http://localhost:${PORT}`);
});
