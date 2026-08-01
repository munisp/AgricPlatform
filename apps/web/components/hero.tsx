import Link from 'next/link';

export function Hero() {
  return (
    <div className="hero">
      <div className="hero-shapes" aria-hidden="true">
        <span className="s1" />
        <span className="s2" />
        <span className="s3" />
        <span className="s4" />
      </div>
      <div className="container hero-inner">
        <span className="kicker">Nigeria Young Farmers Network</span>
        <h1>One platform for every young farmer in Nigeria.</h1>
        <p>
          Learn new skills, find funding and markets, run your chapter, and get field-ready advisory —
          online or offline, in English, Hausa, Yoruba or Igbo.
        </p>
        <div className="cluster" style={{ marginTop: '1.25rem' }}>
          <Link href="/onboarding" className="btn btn-secondary">
            Join NYFN — it&apos;s free
          </Link>
          <Link href="/dashboard" className="btn btn-ghost" style={{ color: '#fff', borderColor: 'rgba(255,255,255,0.4)' }}>
            Explore the platform
          </Link>
        </div>
      </div>
    </div>
  );
}
