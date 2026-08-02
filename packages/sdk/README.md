# @agric-platform/sdk

Public TypeScript SDK for the AgricPlatform (NYFN) partner API. fetch-based;
runs on Node 18+ and in browsers. Zero runtime dependencies.

```bash
npm install @agric-platform/sdk
```

## Environments and authentication

The client defaults to the **sandbox** environment
(`https://api.sandbox.agricplatform.ng/api/v1`). Pass
`baseUrl: LIVE_BASE_URL` for production.

```ts
import { AgricClient, LIVE_BASE_URL } from '@agric-platform/sdk';

// 1. Developer API key (issued once from the developer portal, /developers/sandbox)
const client = new AgricClient({ auth: { apiKey: 'ak_sandbox_...' } });

// 2. End-user OIDC token (marketplace mutations on behalf of a member)
const userClient = new AgricClient({ auth: { userToken: '<oidc-jwt>' } });

// 3. Machine-to-machine client credentials (partner backend jobs)
const m2m = new AgricClient({
  baseUrl: LIVE_BASE_URL,
  auth: { clientId: 'pc_...', clientSecret: 'pcs_...' }
});
```

Client-credentials tokens are fetched and cached automatically until expiry.
Mutations automatically send an `Idempotency-Key` header (override per call),
and 429/5xx/network failures are retried with exponential backoff
(`maxRetries`, default 3).

## Surface

| Resource | Method | Endpoint |
| --- | --- | --- |
| `client.members.getProfile(userId)` | Consented member profile | `GET /partner/members/:userId/profile` |
| `client.advisory.getCropCalendar({state, crop})` | Crop calendar read | `GET /advisory?kind=crop_calendar` |
| `client.opportunities.list({type, state})` | Opportunity listing | `GET /opportunities` |
| `client.marketplace.createListing(input)` | Marketplace item creation | `POST /listings` |
| `client.farm.pushFarmData(input)` | farmOS-compatible push | `POST /partner/farm-data` |
| `client.webhooks.create/list/delete` | Webhook subscriptions | `/partner/webhooks` |
| `client.partner.getParticipation/getImpact/getApplicationCount` | Programme metrics | `/partner/participation|impact|applications/count` |
| `client.partner.recordDisbursement/recordEnrolment` | Write hooks | `/partner/disbursements|enrolments` |

Member-level reads are consent-gated: the API returns 403 unless the member
holds an active `partner_data_sharing` consent.

## Example 1 — DFI impact pull

A development-finance institution pulls aggregate impact metrics nightly and
receives disbursement confirmations by webhook.

```ts
import { AgricClient } from '@agric-platform/sdk';

const dfi = new AgricClient({
  auth: { clientId: process.env.AGRIC_CLIENT_ID!, clientSecret: process.env.AGRIC_CLIENT_SECRET! }
});

// Aggregate metrics only — never member PII.
const impact = await dfi.partner.getImpact('partner-boborex');
console.log(`${impact.participants} participants, ${impact.completedTrainings} trainings completed`);

// One-off: subscribe to signed disbursement events.
await dfi.webhooks.create({
  eventTypes: ['disbursement.recorded'],
  targetUrl: 'https://dfi.example.org/agric/webhook',
  secret: process.env.WEBHOOK_SECRET! // verify X-Agric-Signature: sha256=<hmac>
});
```

## Example 2 — Lender credit check

A lender checks a loan applicant's platform footprint — only when the member
granted data-sharing consent during onboarding.

```ts
const lender = new AgricClient({ auth: { apiKey: process.env.AGRIC_API_KEY! } });

try {
  const { user, profile, enrolments } = await lender.members.getProfile(application.userId);
  const completed = enrolments.filter((e) => e.status === 'completed').length;
  score += completed * 5;
  console.log(`KYC tier: ${user.kycTier}, state: ${profile.location?.state}`);
} catch (error) {
  if (error instanceof AgricApiError && error.status === 403) {
    // Member has not consented — fall back to manual verification.
  }
  throw error;
}
```

## Example 3 — NGO enrolment push

An NGO records programme enrolments and pushes field-level farm data collected
offline (farmOS-compatible payload), safe to retry after network outages.

```ts
const ngo = new AgricClient({ auth: { clientId, clientSecret } });

await ngo.partner.recordEnrolment(
  { partnerId: 'partner-ngo', userId: memberId, programmeId: 'opp-agroforestry-2026', cohortLabel: 'Kano C' },
  { idempotencyKey: `enrol-${memberId}-agroforestry-2026` } // stable key: replays dedupe
);

await ngo.farm.pushFarmData({
  userId: memberId,
  assets: [{ type: 'asset--land', name: 'North field', area: { value: 1.8, unit: 'ha' } }],
  logs: [{ type: 'log--input', name: 'NPK 15-15-15 applied', timestamp: '2026-03-01' }]
});
```

## Error handling

All non-2xx responses throw `AgricApiError` with `status` and the parsed error
body. 401 = bad credentials, 403 = missing scope or missing consent,
429 = partner rate bucket exhausted (default 1000 requests/minute).
