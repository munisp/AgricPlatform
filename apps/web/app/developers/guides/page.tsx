import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Integration guides',
  description:
    'Three worked AgricPlatform integrations: DFI impact pull, lender credit check and NGO enrolment push.'
};

const dfiSnippet = `import { AgricClient } from '@agric-platform/sdk';

const dfi = new AgricClient({
  auth: { clientId: process.env.AGRIC_CLIENT_ID!,
          clientSecret: process.env.AGRIC_CLIENT_SECRET! }
});

// Aggregate metrics only — never member PII.
const impact = await dfi.partner.getImpact('partner-boborex');
console.log(\`\${impact.participants} participants, \${impact.completedTrainings} trainings\`);

// Signed disbursement confirmations straight to your systems.
await dfi.webhooks.create({
  eventTypes: ['disbursement.recorded'],
  targetUrl: 'https://dfi.example.org/agric/webhook',
  secret: process.env.WEBHOOK_SECRET!
});`;

const lenderSnippet = `import { AgricApiError, AgricClient } from '@agric-platform/sdk';

const lender = new AgricClient({ auth: { apiKey: process.env.AGRIC_API_KEY! } });

try {
  const { user, profile, enrolments } = await lender.members.getProfile(applicantId);
  const completed = enrolments.filter((e) => e.status === 'completed').length;
  score += completed * 5; // training history as a thin-file signal
} catch (error) {
  if (error instanceof AgricApiError && error.status === 403) {
    // Member has not consented — fall back to manual verification.
  }
  throw error;
}`;

const ngoSnippet = `import { AgricClient } from '@agric-platform/sdk';

const ngo = new AgricClient({ auth: { clientId, clientSecret } });

// Stable idempotency key: safe to retry after field connectivity drops.
await ngo.partner.recordEnrolment(
  { partnerId: 'partner-ngo', userId: memberId,
    programmeId: 'opp-agroforestry-2026', cohortLabel: 'Kano C' },
  { idempotencyKey: \`enrol-\${memberId}-agroforestry-2026\` }
);

// farmOS-compatible field data collected offline.
await ngo.farm.pushFarmData({
  userId: memberId,
  assets: [{ type: 'asset--land', name: 'North field',
             area: { value: 1.8, unit: 'ha' } }],
  logs: [{ type: 'log--input', name: 'NPK 15-15-15 applied' }]
});`;

const GUIDES = [
  {
    id: 'dfi-impact-pull',
    title: 'DFI impact pull',
    audience: 'Development finance institutions',
    summary:
      'Pull aggregate programme impact nightly and receive HMAC-signed disbursement ' +
      'confirmations by webhook. Requires the impact:read and webhooks:manage scopes on an ' +
      'M2M client. Verify X-Agric-Signature (sha256=<hmac>) against your subscription secret.',
    snippet: dfiSnippet
  },
  {
    id: 'lender-credit-check',
    title: 'Lender credit check',
    audience: 'Lenders and MFBs',
    summary:
      'Look up a loan applicant’s platform footprint — KYC tier, location, completed ' +
      'agronomy training — as a thin-file credit signal. Member data only flows with an ' +
      'active partner_data_sharing consent; the API answers 403 otherwise.',
    snippet: lenderSnippet
  },
  {
    id: 'ngo-enrolment-push',
    title: 'NGO enrolment push',
    audience: 'NGOs and extension providers',
    summary:
      'Record programme enrolments and push farmOS-compatible field data collected ' +
      'offline. Stable idempotency keys make retries after connectivity drops safe. ' +
      'Requires enrolments:write and farm_data:write scopes.',
    snippet: ngoSnippet
  }
];

export default function IntegrationGuidesPage() {
  return (
    <div className="container">
      <header className="page-header">
        <span className="kicker">Developers</span>
        <h1>Integration guides</h1>
        <p className="muted">
          Three worked integrations using <code>@agric-platform/sdk</code>. The same examples ship
          in the SDK README.
        </p>
      </header>
      {GUIDES.map((guide) => (
        <section key={guide.id} id={guide.id} className="section-tight">
          <h2>{guide.title}</h2>
          <p>
            <strong>{guide.audience}.</strong> {guide.summary}
          </p>
          <pre>
            <code>{guide.snippet}</code>
          </pre>
        </section>
      ))}
    </div>
  );
}
