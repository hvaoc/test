# Cairn — Phase 1 MVP (Expo app)

A privacy-first AI **personal guide that knows you**. This is the Phase 1 MVP that
proves the core loop from [`../docs/PRODUCT.md`](../docs/PRODUCT.md):

> **ground** (retrieve your private memory) → **respond** (frontier LLM answers in
> your context) → **remember** (extract durable facts back into your profile).

## What's in this MVP

- **Onboarding → profile** — a short intake that seeds your private memory.
- **Context-aware chat** — every reply is grounded in your profile + remembered facts.
- **Automatic memory extraction** — after each exchange, new facts / goals / follow-ups
  are pulled out and saved.
- **Memory viewer** — a "what Cairn remembers" screen where you can read, and **delete**,
  anything. Nothing is hidden from you.
- **Proactive follow-ups** — open loops resurface in chat ("how did that go?").
- **Mock-LLM fallback** — runs with **zero API keys** so it's always demoable.

## Privacy model

Your memory is stored **on-device** (AsyncStorage). The serverless API routes are
**stateless** — your profile is attached to a single LLM request as transient context
and never persisted server-side. The Anthropic API key is read only inside the server
routes and is never bundled into the mobile client.

## Architecture

```
 Expo app (React Native, TypeScript)
 ├─ app/onboarding.tsx   profile intake
 ├─ app/chat.tsx         grounded chat + ground→respond→remember orchestration
 ├─ app/memory.tsx       inspect / delete what Cairn remembers
 ├─ app/api/chat+api.ts      ← serverless function: grounded reply (Claude Sonnet)
 ├─ app/api/extract+api.ts   ← serverless function: memory extraction (Claude Haiku)
 └─ lib/
    ├─ store.tsx         on-device private memory (AsyncStorage)
    ├─ api.ts            client → API routes
    ├─ prompts.ts        grounding + extraction prompts (pure)
    ├─ llm.server.ts     Anthropic fetch (server-only)
    └─ mock.server.ts    deterministic fallback (server-only)
```

Tiered models (see PRODUCT.md §11): `claude-sonnet-4-6` for chat,
`claude-haiku-4-5-20251001` for extraction.

## Run it

```bash
cd personal-guide/app
npm install            # or: npx expo install   (reconciles native versions)

# Optional — enable real frontier-LLM responses:
cp .env.example .env   # then set ANTHROPIC_API_KEY=...

npm run web            # easiest: runs app + serverless API routes together
# or: npm start        # then press i / a for iOS / Android simulators
```

Without a key, Cairn runs in **offline demo mode**: replies are deterministic and
memory still grows via keyword heuristics, so you can see the whole loop work.

> **Note on versions:** `package.json` pins an Expo SDK 52 baseline. If `npm install`
> reports a mismatch for your environment, run `npx expo install --fix` to reconcile
> native package versions, then start again.

## Try this 2-minute demo

1. Onboard with a name and "what do you want help with" = `exam in September`.
2. Chat: *"I keep procrastinating on revision."* → notice the reply is grounded.
3. Open **🧠 Memory** — see the captured fact and a follow-up ("Ask how exam prep is going").
4. Restart the app — your memory persists. Send another message — the guide remembers.

## Not in this MVP (deferred — see roadmap)

Multi-thread UI, push notifications, encryption-at-rest hardening, payments, voice,
semantic retrieval. Phase 1 deliberately proves the memory flywheel first.
