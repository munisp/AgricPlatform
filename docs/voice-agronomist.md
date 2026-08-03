# Voice Agronomist (wave VOICE)

IVR/USSD-first AI agronomy advisory with human escalation. Farmers reach
grounded agronomy answers from a feature phone (USSD menus or an IVR voice
call) or an assisted channel; anything the retrieval layer cannot ground in
the platform's own content is handed to a human agronomist through the
agent-assist console — the AI never improvises agronomy.

## Architecture

```
farmer (USSD / IVR / assisted)
   │  POST /voice/sessions            → VoiceSession (intake)
   │  POST /voice/sessions/:id/turns  → state machine + RAG + ASR/TTS ports
   │  POST /voice/sessions/:id/escalate
   ▼
VoiceService (apps/api/src/modules/voice)
   ├─ voice-session.ts        pure state machine: intake → triage → advisory
   │                          → (escalated | resolved)
   ├─ ussd-agronomy.ts        pure USSD menu engine (crop → symptom → query),
   │                          CON/END screens ≤ 182 chars, key 9 = agent
   ├─ agronomy-rag.service.ts BM25-ish retrieval over the repo corpus
   │                          (advisory items, knowledge resources, course
   │                          catalogue) — no vector DB, no external LLM
   ├─ speech.drivers.ts       ASR port (stub default / live env-gated)
   ├─ tts.driver.ts           TTS port (stub default / live env-gated)
   └─ voice-menu-state.store  USSD menu state: in-memory default, Redis when
                              REDIS_URL is set (mirrors redis-throttler)
escalation
   │  AgentCase (open → assigned → responded → resolved, SLA deadline)
   ▼
agent-assist console (apps/web/app/agent-assist, agronomist/admin role)
```

Persistence: `infra/postgres/027_voice.sql` (schema `voice`) —
`voice_sessions`, `voice_turns`, `agent_cases`. In-memory repositories are
the default for local dev/CI; the pg implementations are selected by
`DatabaseModule` when `PG_POOL` is configured, identical to prior waves.
`updated_at` is maintained by application code (no triggers), per repo
convention.

## The grounding contract

1. Every agronomy answer is COMPOSED from retrieved corpus chunks and cites
   their chunk ids (`{source}:{recordId}:{chunkIndex}`); the same ids appear
   in the answer text ("Sources: …") and on the stored transcript turn.
2. Retrieval scores chunks with a deterministic BM25-ish term weighting
   (idf + tf saturation, naive plural stemming, chunk-id tie-break). Same
   query + same corpus + same locale ⇒ same answer.
3. Confidence is the matched-query-term share of the top chunk. Below
   `RAG_ANSWER_THRESHOLD` (0.5) the service returns NO answer:
   - `no_grounding` (no chunk matched) → safe fallback + auto-escalation,
     case priority `high`;
   - `low_confidence` (weak match) → safe fallback + auto-escalation with a
     `suggestedAnswer` draft for the human agent.
4. ASR transcriptions below `ASR_MIN_CONFIDENCE` (0.35) are not trusted;
   the session escalates instead of guessing.

## API

| Route | Role | Purpose |
| --- | --- | --- |
| `POST /voice/sessions` | any authenticated | Start a session (`channel`: `ivr`/`ussd`/`assisted`, `phone`, optional `ninRef`, `locale`) |
| `POST /voice/sessions/:id/turns` | session owner or agent | Submit `{ text \| audioUrl \| ussdInput }`, receive the reply (answer + citations, or safe fallback) |
| `GET /voice/sessions/:id` | session owner or agent | Session detail + full transcript |
| `POST /voice/sessions/:id/escalate` | session owner or agent | Manual escalation (idempotent per session) |
| `GET /voice/agent-cases` | `agronomist`/`admin` | Queue, SLA-deadline order; `?status=` `?overdue=true` |
| `GET /voice/agent-cases/:id` | `agronomist`/`admin` | Case + session + transcript (citations shown to the agent) |
| `POST /voice/agent-cases/:id/respond` | `agronomist`/`admin` | Agent response; self-assigns when open; `resolve: true` closes case + session |

Farmer identity resolves through the existing user directory
(`UsersService.findByPhone`). Unknown phones still get a session (USSD/IVR
callers are often unregistered) but stay honestly unlinked. The new
`agronomist` role in `USER_ROLES` gates the agent console alongside
`admin`.

Domain events (EventBus port, stub-friendly): `voice.session.started`,
`voice.session.escalated`, `voice.session.resolved`,
`voice.agent_case.created`, `voice.agent_case.responded`.

## Environment variables

| Variable | Default | Semantics |
| --- | --- | --- |
| `ASR_DRIVER` | `stub` | `http` selects the live speech-to-text provider |
| `ASR_PROVIDER_URL` | — | REQUIRED when `ASR_DRIVER=http`; boot/config check fails closed (`ProviderConfigError` → 503) |
| `ASR_API_KEY` | — | Optional bearer credential for the ASR provider |
| `TTS_DRIVER` | `stub` | `http` selects the live speech-synthesis provider |
| `TTS_PROVIDER_URL` | — | REQUIRED when `TTS_DRIVER=http` (same fail-closed rule) |
| `TTS_API_KEY` | — | Optional bearer credential for the TTS provider |
| `VOICE_CASE_SLA_HOURS` | `24` | SLA deadline for agent first response |
| `REDIS_URL` | — | When set, USSD menu state is shared via Redis; otherwise in-memory (single instance) |

### Stub/live semantics (fail-closed doctrine)

- **Stub ASR** (default): passes supplied `text` through unchanged
  (labelled `stub-text-passthrough` — no audio decoding). Audio-only input
  returns a clearly-labelled SIMULATED transcript at 0.2 confidence, which
  by design routes to a human.
- **Live ASR** (`ASR_DRIVER=http`): POSTs `{audio_url, text, locale}` to
  `{ASR_PROVIDER_URL}/transcribe` with a 5s timeout and a circuit breaker
  (3 consecutive failures → 30s open). Misconfigured or unreachable ⇒ the
  turn answers **503**. It NEVER silently degrades to the stub — that
  would fabricate a transcript.
- **Stub TTS** (default): returns SSML wrapping the reply text for the IVR
  provider to speak (`stub-ssml` — no audio synthesized).
- **Live TTS** (`TTS_DRIVER=http`): POSTs to
  `{TTS_PROVIDER_URL}/synthesize`; same timeout/circuit-breaker/503
  semantics.

## Honest limits

- **No live telephony or ASR/TTS has been verified against a real
  provider.** The live drivers are fetch adapters with fail-closed
  semantics; connecting a real provider needs a provider account and
  credentials (external gate). Telephony webhooks (Africa's Talking etc.)
  are out of scope for this wave — the session/turn API is the integration
  surface.
- **Responses are English-only.** Session locale (en/ha/yo/ig) is captured
  and stored, and non-en sessions carry an explicit "English-only pending
  professional translation" note; translated voice responses are deferred
  until professional review.
- **The RAG corpus is limited to repo content** — advisory items, knowledge
  resources and the course catalogue. Thin coverage means more
  `no_grounding` escalations; that is the intended safe behaviour, not a
  defect. No external LLM is called anywhere in the flow.
- **NIN ref is stored unverified** (dictated over IVR/USSD); it is context
  for the agent, not KYC verification.
- **USSD answers are compressed to one 182-char screen**; the full answer
  and citations remain on the transcript for the agent console.

## Tests

- `apps/api/src/modules/voice/*.spec.ts` — state machine, RAG grounding
  contract (no answer without citations; below-threshold refusal), stub
  determinism, fail-closed ASR/TTS (503 + circuit breaker), USSD menu flow,
  service orchestration, auth metadata.
- `apps/api/src/database/repositories/voice.repository.spec.ts` —
  in-memory repository behaviour (queue order, filters).
- `apps/api/test/pg/voice.pg.spec.ts` — migration 027 + pg repositories
  (skipped unless `DATABASE_URL` is set, matching the existing pg suites).
- `apps/web/test/agent-assist.test.tsx` — queue rendering/filters/empty/
  error states, SLA-age labelling, transcript + citation display, suggested
  answer pre-fill, respond/resolve, read-only resolved cases.
