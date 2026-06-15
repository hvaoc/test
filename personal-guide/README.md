# Personal Guide (working name: **Cairn**)

> A privacy-first AI **personal guide** in your pocket. Not an open chatbot — a
> companion that *knows you*, remembers your life as it unfolds, and gives advice
> that's relevant to **your** situation right now.

A *cairn* is a stack of stones that marks a trail — built up one stone at a time,
it shows you the way. That's the product: a guide that gets more useful with every
conversation, because each conversation adds a stone to your profile.

**Platform:** Expo (React Native) mobile app · serverless backend · frontier LLM
(Claude) · per-user **private** memory.

---

## Status

🚧 **Phase 1 — MVP in progress.** The strategy is defined and the first working app
is in [`app/`](app/): onboarding → grounded chat → automatic memory extraction →
memory viewer, with a mock-LLM fallback so it runs without any API key.

| Path | What's in it |
| --- | --- |
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | The full product & market thesis: problem, differentiation vs ChatGPT, the memory/profile engine (the moat), privacy model, market opportunity, business model, tech architecture, MVP scope, roadmap, and risks. |
| [`app/`](app/) | The Expo (React Native) MVP — Expo Router app + serverless API routes + on-device private memory. See [`app/README.md`](app/README.md) to run it. |

## The one-paragraph pitch

People don't open ChatGPT for most of life's decisions, because a blank prompt box
that forgets you every session is the wrong shape for "help me through my life."
**Cairn** flips it: you have *one* ongoing relationship with a guide that has built
a real model of who you are — age, work, education, relationships, goals, the exam
you're studying for, the person you're dating, the move you're planning — and every
reply is grounded in that context. The memory is yours alone and never shared.
That persistent, private, life-contextual relationship is the product, and it's
something a stateless chatbot structurally can't be.

## Next phases (see roadmap in PRODUCT.md)

1. **Phase 0 — this doc.** Product & market thesis. ✅
2. **Phase 1 — MVP.** Expo app: onboarding → profile, context-aware chat, automatic
   memory extraction, private per-user storage. Demoable with a mock-LLM fallback. 🚧 *in [`app/`](app/)*
3. **Phase 2 — Depth.** Life "threads" (exam prep, a relationship, a job hunt),
   proactive check-ins, richer profile schema.
4. **Phase 3 — Trust & scale.** Encryption, export/delete, monetization.
