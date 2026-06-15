# Cairn — Product & Market Thesis

*Working name. A personal AI guide that builds a private, evolving model of you and
helps you navigate real life: dating and relationships, exams, careers, money, and
major life events.*

Status: **Phase 0 (definition).** This document is the source of truth for what we
build in Phase 1 and why it's worth building.

---

## 1. The one-liner

**A private AI guide that remembers your whole life and gives advice that actually
fits your situation — the opposite of a blank, forgetful chat box.**

"Facebook × ChatGPT" is the shorthand the founder used, but the sharper framing is:
**ChatGPT gives you answers; Cairn gives you *your* answer**, because it knows the
context a stranger-chatbot never will.

---

## 2. The problem

Generative chat is incredibly capable but structurally mis-shaped for being a life
companion:

1. **It forgets.** Every session starts from zero. You re-explain who you are, what
   you're working on, what you already tried. For one-off questions that's fine; for
   *"help me through my life"* it's exhausting and the advice stays generic.
2. **It's a blank box.** A blinking cursor is a high-effort, high-intimidation
   interface. Most people don't know what to ask, so they don't open it for the
   decisions that matter most (relationships, career moves, health, money).
3. **Advice without context is shallow.** "How do I reply to this message I got on a
   dating app?" has a completely different answer for a shy 19-year-old student vs a
   recently-divorced 45-year-old. A stateless model has to guess; it usually defaults
   to bland, safe, lowest-common-denominator advice.
4. **No continuity, no follow-through.** Real guidance is longitudinal — *"how did
   that interview go?"*, *"you said you'd talk to her this weekend"*. A tool that
   can't follow up can't actually guide.

**The gap:** there is no trusted, private, *persistent* companion that accumulates
context about a single person and uses it to help them act. People paper over this
with notes apps, group chats, therapists, and forgetful chatbots.

---

## 3. Why now

- **Frontier LLMs are finally good enough** to hold a nuanced, empathetic, multi-turn
  conversation and to do reliable *information extraction* (turning messy chat into
  structured profile facts) cheaply.
- **Memory is the 2025–2026 frontier** of consumer AI. The incumbents are bolting
  shallow "memory" onto general assistants; a product built *memory-first* for a
  single high-value job (your life) can go far deeper.
- **Costs collapsed.** A tiered model strategy (cheap models for extraction, mid for
  chat, top-tier for hard reasoning) makes a per-user persistent companion economically
  viable at consumer price points.
- **Trust is up for grabs.** Privacy fatigue is high. A product that credibly promises
  *"your memory is yours, never shared, never sold"* is differentiated by default.

---

## 4. Who it's for

Cairn is horizontal in capability but we win by going deep on **personas in a life
transition**, where context compounds fastest and the pain is acute:

| Persona | The life context | What Cairn does that ChatGPT won't |
| --- | --- | --- |
| **The student under pressure** | Studying for a specific exam / degree | Remembers the syllabus, weak topics, exam date; builds a plan; quizzes them; checks in. |
| **The dater** | Navigating dating apps & early relationships | Remembers who they're talking to, their own patterns/insecurities, past advice; coaches in-the-moment without re-explaining. |
| **The career mover** | Job hunting / promotion / switch | Knows their CV, salary, target roles, interview history; tailors prep and negotiation. |
| **The life-event planner** | Wedding, baby, move, loss, illness | Holds the whole evolving situation; reduces overwhelm into next steps. |
| **The newcomer** | New country / city / culture | Remembers their background and goals; gives advice grounded in *their* starting point. |

These are not separate products — they're **threads** inside one guide that already
knows the person. That's the unlock.

---

## 5. The core idea: a **Life Context Engine**

The product is not the chat. The chat is the *interface*. The product is the
**accumulating, private model of the user** that makes every chat good.

Three loops run continuously:

```
            ┌─────────────────────────────────────────────┐
            │                                             │
   You talk ─┴─►  GROUND  ──►  RESPOND  ──►  REMEMBER  ──┘
            (retrieve relevant   (frontier LLM    (extract new facts,
             profile + threads)   answers in your   update profile,
                                  full context)     schedule follow-ups)
```

1. **Ground.** Before answering, retrieve the slices of the user's profile and active
   life-threads relevant to this message.
2. **Respond.** A frontier model answers *as a guide who knows them*, in their context.
3. **Remember.** After the exchange, a cheap extraction pass identifies what's worth
   keeping — new facts, changed facts, open loops, things to follow up on — and writes
   them back to the private profile.

Over weeks, the profile gets richer, retrieval gets sharper, and the advice gets
visibly more personal. **The product gets better the more you use it** — a flywheel a
stateless chatbot cannot have, and a switching cost competitors can't copy: your
memory lives here.

---

## 6. The memory & profile system (the moat)

This is where the engineering and the defensibility live. Memory is **structured**,
not just a transcript.

**Profile (slow-changing core):**
- Identity & demographics: age, location, languages, education, occupation.
- Stable traits: hobbies, interests, values, communication style, stated goals.
- Relationships: key people and roles (with the user's framing of them).

**Threads (active life situations):**
- A bounded, evolving topic: *"Final actuarial exam — Sept"*, *"Dating — Priya"*,
  *"Job switch to product"*. Each has state, history, and **open loops**.

**Episodic memory (events over time):**
- Time-stamped facts and moments: *"bombed mock exam on probability (Jun 3)"*,
  *"first date went well, nervous about texting first"*.

**Follow-ups (proactive layer):**
- Commitments and check-ins the guide should resurface: *"ask how Monday's interview
  went"*. This is what turns a reactive tool into a *guide*.

Design principles:
- **Extraction is explicit and inspectable.** The user can see, edit, and delete
  anything Cairn remembers. Memory you can't audit isn't trustworthy.
- **Confidence + provenance.** Each memory records where it came from and how sure we
  are, so we can avoid confidently acting on a misread.
- **Forgetting is a feature.** Stale or corrected facts decay or get superseded.

---

## 7. Privacy & trust model (a feature, not a footnote)

The promise: **your memory is yours. Per-user isolation, never shared, never sold.**

- **Per-user data isolation** — one user's profile/memory is never mixed into another's
  context, and never used to train shared models.
- **User-owned controls** — full view / edit / export / delete of memory. A "what do you
  know about me?" screen.
- **Sensitive-topic guardrails** — Cairn handles dating, health, money, and grief. It is
  a *guide*, explicitly not a doctor/lawyer/therapist, with safe-handling and escalation
  for crisis content.
- **Data minimization** — we keep structured facts needed to help, not everything.

Trust is the product. The moment users doubt where their most personal context goes, the
flywheel breaks. We treat privacy as a core feature with marketing and UX weight.

---

## 8. What makes it *immediately* more valuable than ChatGPT

Differentiation must be felt in the first session *and* compound over months:

| | Generic chatbot (ChatGPT etc.) | **Cairn** |
| --- | --- | --- |
| Memory | Shallow / opt-in / general | **Structured, life-deep, the core product** |
| Interface | Blank prompt box | **Guided** — suggests what to talk about based on *your* life |
| Relevance | Generic until you over-explain | **Grounded in your real context from message one** |
| Continuity | None across sessions | **Threads + proactive follow-ups** |
| Privacy stance | Ambiguous, general-purpose | **Per-user private memory as a headline promise** |
| Shape | A tool you summon | **A relationship that checks in on you** |

**Three "wow" moments to nail in the MVP:**
1. *"It remembered."* — references something you told it days ago, unprompted and right.
2. *"It knew what I needed without me explaining."* — grounded advice from a one-line message.
3. *"It followed up."* — a proactive, well-timed check-in on an open loop.

---

## 9. Market opportunity — is it worth buying / building?

**Why it's a venture-scale opportunity:**
- **Category tailwind.** Consumer AI companions and "AI for life/coaching" is one of the
  fastest-growing app categories; AI character/companion apps already show people *want*
  an ongoing relationship with an AI, and willingness to pay subscriptions is proven.
- **High-frequency, high-emotion, high-retention.** Life doesn't stop. A guide tied to
  ongoing life events is used often and is hard to churn from once it holds your context.
- **Durable moat via switching cost.** The accumulated private profile is the lock-in.
  Unlike a thin GPT wrapper, the value lives in *your* data graph, not the model.
- **Premium willingness to pay.** "Help with the most important decisions in my life,
  privately" supports subscription pricing well above a utility chatbot.

**Sizing (directional, to be validated):** the serviceable market is the overlap of
(a) people who pay for AI subscriptions, (b) people who pay for coaching/tutoring/dating/
self-improvement apps, and (c) the privacy-conscious. Each of those is already a
multi-billion-dollar consumer market; the wedge is the **persona-in-transition** segments
in §4, expanding outward as the profile generalizes.

**Competition & how we win:**
- *Horizontal assistants (ChatGPT, Gemini, Meta AI):* broad but memory-shallow and
  trust-ambiguous. We win on depth + privacy + guidance shape, not raw capability.
- *Companion apps (Replika, Character.ai):* great at relationship/engagement, weak at
  being genuinely *useful* for real-life decisions. We win on practical outcomes.
- *Vertical point tools (tutoring, dating coaches, career apps):* deep but siloed and
  context-blind across your life. We win by being the one guide that holds *all* of it.

**The defensible center:** *deep private memory* + *guidance shape* + *trust*. No single
incumbent sits there, and a thin wrapper can't get there.

---

## 10. Business model ("worth buying")

- **Freemium → subscription.** Generous free tier to seed the memory flywheel; paid tier
  for unlimited deep conversations, proactive guidance, top-tier model access, and richer
  threads. Pricing positioned against coaching/tutoring/therapy value, not against a
  commodity chatbot.
- **Privacy as paid value, never the catch.** We monetize the *service*, not the data.
  No ad targeting on personal memory — that's the whole brand promise.
- **Possible later:** family/relationship plans, opt-in human-expert hand-offs
  (therapist/coach/tutor referrals), B2B2C via universities/employers for the relevant
  persona — all *without* compromising per-user privacy.

**Unit-economics lever:** tiered model routing keeps cost-per-active-user low — cheap
models for extraction and routing, mid-tier for everyday chat, top-tier only for hard
reasoning — so gross margins hold at consumer price points.

---

## 11. Technical architecture (Phase 1 target)

Per the chosen stack: **Expo mobile app + serverless functions + frontier LLM.**

```
 ┌───────────────┐     ┌──────────────────────────┐     ┌───────────────────┐
 │  Expo app      │ ──► │  Serverless functions     │ ──► │  Frontier LLM      │
 │ (React Native) │     │  /chat  /extract  /profile│     │  (Claude family)   │
 │  onboarding,   │ ◄── │  - ground (retrieve)      │ ◄── │                   │
 │  chat, memory  │     │  - respond (LLM)          │     └───────────────────┘
 │  viewer        │     │  - remember (extract)     │            ▲
 └───────────────┘     └──────────┬───────────────┘            │
                                   ▼                  tiered routing:
                        ┌────────────────────┐        - Haiku  → extraction/routing
                        │ Per-user private    │        - Sonnet → default chat
                        │ memory store        │        - Opus   → deep reasoning
                        │ (profile/threads/   │
                        │  episodic/followups)│
                        └────────────────────┘
```

- **Frontend:** Expo / React Native. Onboarding flow → chat → a "what Cairn remembers"
  memory viewer/editor. Local-first niceties (offline view of profile, optimistic UI).
- **Backend:** serverless functions exposing `/chat`, `/extract`, `/profile`. The API key
  stays server-side; the device never holds it.
- **LLM — Claude, tiered:** route by task to control cost/quality.
  - `claude-haiku-4-5-20251001` — high-volume memory extraction, retrieval/routing.
  - `claude-sonnet-4-6` — default conversational guide.
  - `claude-opus-4-8` — hard reasoning (planning, sensitive/high-stakes advice).
  - (Exact pricing/limits to be confirmed against current Anthropic docs before launch.)
- **Memory store:** per-user isolated records (profile / threads / episodic / follow-ups),
  designed for retrieval at ground-time. Start simple (structured records + embeddings for
  semantic recall); evolve as scale demands.
- **Demo resilience:** ship a **mock-LLM fallback** so the app is always demoable without
  network/keys — same principle that kept the team's earlier prototype always-demoable.
- **Privacy engineering:** per-user isolation at the data layer; export/delete endpoints;
  no shared-model training on user memory.

---

## 12. MVP scope (Phase 1) — smallest thing that proves the thesis

**In:**
1. **Onboarding → profile.** A short, warm conversational intake (age, work, education,
   interests, what they want help with) that seeds the profile.
2. **Context-aware chat.** Every reply grounded in the retrieved profile.
3. **Automatic memory extraction.** After each exchange, extract & persist new facts.
4. **Memory viewer.** "Here's what I remember about you" — view, edit, delete.
5. **One proactive moment.** A single well-timed follow-up to demonstrate "it follows up."
6. **Mock-LLM fallback** for always-on demoability.

**Out (deliberately deferred):** social/Facebook-style features, multi-thread UI,
encryption-at-rest hardening, payments, voice. Prove the *memory-makes-it-better* loop first.

**MVP success = the three wow moments in §8 reliably happen in a 10-minute demo.**

---

## 13. Roadmap

| Phase | Goal | Headline deliverables |
| --- | --- | --- |
| **0 — Definition** ✅ | Know what & why | This doc |
| **1 — MVP** | Prove the memory flywheel | Expo app: onboarding, grounded chat, extraction, memory viewer, mock fallback |
| **2 — Depth** | Make it a *guide* | Life-threads UI, proactive check-ins, richer profile schema, semantic retrieval |
| **3 — Trust & scale** | Make it safe & a business | Encryption, export/delete UX, sensitive-topic guardrails, subscription/paywall |
| **4 — Distribution** | Grow | Persona-specific onboarding funnels (student/dater/career), referral, app-store launch |

---

## 14. Key risks & how we address them

| Risk | Mitigation |
| --- | --- |
| **Trust/privacy breach perception** | Privacy-first architecture + UX; user-owned, inspectable memory; clear "never shared/sold" promise; treat as core feature. |
| **Memory feels creepy or wrong** | Inspectable & editable memory; confidence/provenance; conservative surfacing; easy correction/forgetting. |
| **"Just a GPT wrapper"** | The moat is the *private profile graph* + guidance shape, not the model. Switching cost lives in user data. |
| **Incumbents add deep memory** | Win on focus + trust + persona depth; move faster on the single job of "your life." |
| **Sensitive-topic harm** (dating/health/grief) | Explicit non-professional stance, safe-handling, crisis escalation, human-expert hand-off later. |
| **Cost per active user** | Tiered model routing; cache profile context; extract cheaply. |
| **Retention/engagement** | Proactive follow-ups and threads make it a relationship, not a tool you forget to open. |

---

## 15. How we'll know it's working (early metrics)

- **Memory density** — facts retained per active user (the flywheel turning).
- **Grounded-relevance** — % of replies that correctly use a remembered fact (sampled).
- **"It remembered" moments** per user per week.
- **Retention** — W1/W4 return rate; proactive-check-in open rate.
- **Willingness to pay** — free→paid conversion once paywall ships.

---

## 16. Open questions for the founder

1. **Lead persona for the MVP demo** — student / dater / career-mover? (Pick one to make
   the onboarding and wow-moments concrete.)
2. **How proactive?** Push-notification check-ins from day one, or in-app only first?
3. **Social layer** — is "Facebook" literally on the roadmap (connecting users), or just
   the *relationship/feed* feel of a guide that knows you? This materially changes scope
   and privacy design.
4. **Brand & name** — keep *Cairn* or explore alternatives?
5. **Data residency / regulation** — any target market (EU/UK GDPR, etc.) that should
   shape the privacy architecture from the start?

---

*Next step: lock the lead persona (Q1) and greenlight Phase 1 — the Expo MVP that makes
the memory flywheel real and demoable.*
