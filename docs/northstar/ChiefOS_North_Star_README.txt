CHIEFOS NORTH STAR DOCUMENTS
README.txt

This folder contains the authoritative product and system vision for ChiefOS.

These files are contracts, not suggestions.
They define what ChiefOS is, what it will become, and what it must never drift into.

If behavior, architecture, or product decisions conflict with these documents,
the documents are correct and the system is wrong.

---

FILES

1. ChiefOS_MVP_North_Star_v2.txt

Purpose:
- Canonical MVP execution guide
- Defines exactly what must be built for the MVP
- Loaded directly into the Chief reasoning system prompt
- Used by AI agents to stay aligned with product intent

Key Concepts:
- Exactly ONE reasoning seat (“Chief”) per business
- Many ingestion inputs (WhatsApp numbers, future apps)
- Chief reasons; ingestion records reality
- Trust-first answers grounded only in real data

Rules:
- Must not drift without a version bump
- Any change here affects AI behavior immediately
- Keep concise, deterministic, and enforceable
- Treat violations as production bugs

---

2. ChiefOS_Finished_Product_North_Star_v2.txt

Purpose:
- Long-term, finished-product vision
- Defines the end-state of ChiefOS as an operating system
- Used for strategy, architecture, and investor alignment

Key Concepts:
- One business, one mind, many senses
- ChiefOS as a persistent business memory and reasoning layer
- Ingestion scales; reasoning remains centralized
- Trust, explainability, and humility are non-negotiable

Rules:
- NOT loaded into AI prompts
- May be more descriptive and conceptual
- Used to guide roadmap and long-term decisions
- Must remain consistent with MVP North Star direction

---

TERMINOLOGY CLARIFICATION

Chief:
- The single reasoning interface
- One seat per business
- Used by the owner or primary operator
- Lives on web (and future app)

Ingestion Layer (formerly PocketCFO):
- The sensing / recording system
- WhatsApp-first in MVP
- Used by employees, contractors, and operators
- Captures time, receipts, jobs, revenue, documents, photos, and voice notes
- Does NOT reason or answer questions

PocketCFO is no longer a standalone product name.
It is an internal lineage for the ingestion pipeline only.

---

ENGINEERING RULES

- Never merge the MVP and Finished Product North Stars
- Only ONE North Star may be active in prompts at any time
- Always bump version numbers when changing the MVP North Star
- Treat North Star violations as bugs, not differences of opinion
- Architecture must support one reasoning seat and many ingestion inputs by default

---

WHY THIS EXISTS

ChiefOS is AI-native.

AI systems drift unless anchored.
Humans drift unless constrained.
Roadmaps drift unless grounded.

This folder is the anchor.
