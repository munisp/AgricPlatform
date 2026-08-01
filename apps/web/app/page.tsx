import Link from 'next/link';
import { platformMetrics, seedAdvisory } from '@agric-platform/shared';
import { Hero } from '@/components/hero';
import { MetricsGrid, ModuleCard, Section, StatusBadge, Timeline, Card } from '@/components/ui';
import { MODULES, ROLE_SUMMARIES, ROLE_LABELS } from '@/lib/content';
import { USER_ROLES } from '@agric-platform/shared';

const JOURNEY = [
  {
    id: 'j1',
    title: 'Register and choose your role',
    date: 'Step 1',
    description: 'Phone-first onboarding with OTP-ready verification and language choice.'
  },
  {
    id: 'j2',
    title: 'Build a progressive profile',
    date: 'Step 2',
    description: 'State, LGA, value chains and farm details raise your completion score.'
  },
  {
    id: 'j3',
    title: 'Learn and get matched',
    date: 'Step 3',
    description: 'Courses and certificates unlock opportunity matches in your state.'
  },
  {
    id: 'j4',
    title: 'Apply, trade and grow',
    date: 'Step 4',
    description: 'Submit applications, list produce, and build your credit-ready record.',
    tone: 'warning' as const
  }
];

export default function HomePage() {
  return (
    <>
      <Hero />

      <Section
        kicker="Platform at a glance"
        title="Growing with Nigeria's young farmers"
        description="Live platform indicators from the reference dataset."
      >
        <MetricsGrid metrics={platformMetrics} />
      </Section>

      <Section
        kicker="Modules"
        title="Everything in one operating system"
        description="Each module is designed mobile-first, low-bandwidth and offline-tolerant."
      >
        <div className="grid grid-3">
          {MODULES.map((mod) => (
            <ModuleCard
              key={mod.href}
              href={mod.href}
              title={mod.title}
              description={mod.description}
              tag={mod.tag}
            />
          ))}
        </div>
      </Section>

      <Section
        kicker="How it works"
        title="From registration to your first opportunity"
      >
        <div className="grid grid-2">
          <Card>
            <Timeline items={JOURNEY} />
            <Link href="/onboarding" className="btn btn-primary">
              Start onboarding
            </Link>
          </Card>
          <Card title="Today's advisory">
            <ul className="row-list">
              {seedAdvisory.map((item) => (
                <li className="row-item" key={item.id}>
                  <div className="row-main">
                    <div className="row-title">{item.title}</div>
                    <div className="small muted">
                      {[item.state, item.crop].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <StatusBadge tone={item.severity === 'warning' ? 'warning' : 'info'}>
                    {item.kind.replace(/_/g, ' ')}
                  </StatusBadge>
                </li>
              ))}
            </ul>
            <p style={{ marginTop: '1rem' }}>
              <Link href="/advisory">See all advisory →</Link>
            </p>
          </Card>
        </div>
      </Section>

      <Section
        kicker="Built for every stakeholder"
        title="One platform, seven role experiences"
      >
        <div className="grid grid-4">
          {USER_ROLES.map((role) => (
            <Card key={role} title={ROLE_LABELS[role]}>
              <p className="small muted">{ROLE_SUMMARIES[role]}</p>
            </Card>
          ))}
        </div>
      </Section>
    </>
  );
}
