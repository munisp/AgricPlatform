'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api/client';

interface IssuedKey {
  id: string;
  prefix: string;
  scopes: string[];
  sandbox: boolean;
  createdAt: string;
  /** Plaintext key — returned exactly once. */
  key: string;
}

const SANDBOX_SCOPES = ['profile:read', 'impact:read', 'applications:read', 'programmes:read'];

/**
 * Sandbox key request flow: one click issues a developer API key via
 * POST /partner/developer-keys and displays the plaintext once.
 */
export function SandboxKeyRequest() {
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  async function requestKey() {
    setPending(true);
    setError(null);
    try {
      const envelope = await apiFetch<{ data: IssuedKey }>('/partner/developer-keys', {
        method: 'POST',
        body: { scopes: SANDBOX_SCOPES }
      });
      setIssued(envelope.data);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not issue a key — are you signed in?'
      );
    } finally {
      setPending(false);
    }
  }

  async function copyKey() {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.key);
    setCopied(true);
  }

  if (issued) {
    return (
      <div className="notice" role="status">
        <p>
          <strong>Your sandbox key (shown once):</strong>
        </p>
        <p>
          <code data-testid="sandbox-key">{issued.key}</code>
        </p>
        <div className="cluster">
          <button type="button" className="btn btn-primary" onClick={copyKey}>
            {copied ? 'Copied' : 'Copy key'}
          </button>
        </div>
        <p className="muted">
          Scopes: {issued.scopes.join(', ')}. Store it in a secrets manager — we cannot show it
          again, only revoke and re-issue.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p>
        Requests the <code>profile:read</code>, <code>impact:read</code>,{' '}
        <code>applications:read</code> and <code>programmes:read</code> scopes — everything the
        example integrations need.
      </p>
      <button type="button" className="btn btn-primary" onClick={requestKey} disabled={pending}>
        {pending ? 'Issuing…' : 'Issue sandbox key'}
      </button>
      {error ? (
        <p role="alert" className="muted">
          {error}
        </p>
      ) : null}
    </div>
  );
}
