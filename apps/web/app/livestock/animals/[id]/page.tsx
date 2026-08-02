import type { Metadata } from 'next';
import Link from 'next/link';
import { AnimalDetail } from '@/components/livestock-animal-detail';
import { PageHeader } from '@/components/ui';
import { T } from '@/lib/i18n';

export const metadata: Metadata = {
  title: 'Animal detail',
  description:
    'Registry detail for one animal: lineage, status, trust grade, liens and ownership-transfer history.'
};

export default async function AnimalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="container" style={{ maxWidth: 980 }}>
      <PageHeader
        kicker={<T k="livestock.detailKicker" />}
        title={<T k="livestock.detailTitle" />}
        description={<Link href="/livestock">← Back to my animals</Link>}
      />
      <AnimalDetail animalId={decodeURIComponent(id)} />
    </div>
  );
}
