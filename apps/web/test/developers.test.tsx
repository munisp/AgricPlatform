import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DevelopersLandingPage from '@/app/developers/page';
import DeveloperDocsPage from '@/app/developers/docs/page';
import IntegrationGuidesPage from '@/app/developers/guides/page';
import WidgetsPage from '@/app/widgets/page';

describe('developer portal pages', () => {
  it('landing links to the sandbox key CTA, docs and widgets', () => {
    render(<DevelopersLandingPage />);
    expect(screen.getByRole('heading', { name: /build on agricplatform/i })).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /get a sandbox key/i }).getAttribute('href')
    ).toBe('/developers/sandbox');
    expect(
      screen.getByRole('link', { name: /read the api docs/i }).getAttribute('href')
    ).toBe('/developers/docs');
    expect(screen.getByRole('link', { name: /embed a widget/i }).getAttribute('href')).toBe(
      '/widgets'
    );
  });

  it('docs page renders every catalogue section and the token endpoint', () => {
    render(<DeveloperDocsPage />);
    for (const title of ['Authentication', 'Consented reads', 'Writes', 'Webhooks', 'Public embed feeds']) {
      expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    }
    expect(screen.getAllByText(/partner\/oauth\/token/).length).toBeGreaterThan(0);
  });

  it('guides page renders the three integration guides matching the SDK README', () => {
    render(<IntegrationGuidesPage />);
    expect(screen.getByRole('heading', { name: 'DFI impact pull' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Lender credit check' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'NGO enrolment push' })).toBeTruthy();
  });

  it('widgets page documents all four embeds with copy-paste snippets', () => {
    render(<WidgetsPage />);
    expect(screen.getByRole('heading', { name: 'Opportunity directory' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Commodity price ticker' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Course catalogue' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Register as NYFN Member button/ })).toBeTruthy();
    expect(screen.getAllByText(/widgets\/opportunities\.js/).length).toBeGreaterThan(0);
  });
});
