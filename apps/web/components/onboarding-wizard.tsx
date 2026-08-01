'use client';

import { useMemo, useState } from 'react';
import {
  NIGERIAN_STATES,
  USER_ROLES,
  VALUE_CHAINS,
  calculateProfileCompletion,
  profileBadge
} from '@agric-platform/shared';
import type { LanguageCode, UserRole } from '@agric-platform/shared';
import { useAppState } from '@/lib/app-state';
import { usePersistentState } from '@/lib/use-persistent-state';
import { ROLE_LABELS } from '@/lib/content';
import { Field, QueuedNotice, Select, TextArea, TextInput } from '@/components/forms';
import { ProgressBar, StatusBadge } from '@/components/ui';

interface OnboardingDraft {
  fullName: string;
  phone: string;
  role: UserRole;
  language: LanguageCode;
  state: string;
  lga: string;
  farmingInterests: string[];
  valueChains: string[];
  bio: string;
  farmSizeHectares: string;
  yearsExperience: string;
}

const EMPTY_DRAFT: OnboardingDraft = {
  fullName: '',
  phone: '',
  role: 'farmer',
  language: 'en',
  state: '',
  lga: '',
  farmingInterests: [],
  valueChains: [],
  bio: '',
  farmSizeHectares: '',
  yearsExperience: ''
};

const STEPS = ['Account', 'Location', 'Interests', 'Farm details', 'Review'] as const;

const LANGUAGES: { code: LanguageCode; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ha', label: 'Hausa' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ig', label: 'Igbo' }
];

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

export function OnboardingWizard() {
  const { enqueue, setRole } = useAppState();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = usePersistentState<OnboardingDraft>('agric.onboarding-draft', EMPTY_DRAFT);
  const [submitted, setSubmitted] = useState(false);

  const patch = (partial: Partial<OnboardingDraft>) =>
    setDraft((current) => ({ ...current, ...partial }));

  const score = useMemo(
    () =>
      calculateProfileCompletion({
        location: draft.state ? { state: draft.state, lga: draft.lga } : undefined,
        farmingInterests: draft.farmingInterests,
        valueChains: draft.valueChains,
        bio: draft.bio,
        farmSizeHectares: draft.farmSizeHectares ? Number(draft.farmSizeHectares) : undefined,
        yearsExperience: draft.yearsExperience ? Number(draft.yearsExperience) : undefined
      }),
    [draft]
  );
  const badge = profileBadge(score);

  const canContinue =
    step === 0
      ? draft.fullName.trim().length >= 3 && draft.phone.trim().length >= 7
      : step === 1
        ? draft.state !== '' && draft.lga.trim().length >= 2
        : true;

  const finish = () => {
    setRole(draft.role);
    enqueue(
      'identity.user.registered',
      `Onboarding for ${draft.fullName.trim() || 'new member'} (${ROLE_LABELS[draft.role]})`
    );
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="stack">
        <div className="notice notice-success" role="status">
          <strong>Welcome to NYFN, {draft.fullName.trim().split(' ')[0] || 'farmer'}.</strong> Your
          profile is saved on this device with a {score}% completion score ({badge} badge).
        </div>
        <QueuedNotice label="Your onboarding submission" />
        <div className="card">
          <ProgressBar value={score} label="Profile completion" />
          <p className="small muted" style={{ marginTop: '0.75rem' }}>
            Complete more profile sections later to unlock lender matching and partner programmes.
          </p>
        </div>
        <div className="cluster">
          <a className="btn btn-primary" href="/dashboard">
            Go to your dashboard
          </a>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setStep(0);
              setSubmitted(false);
            }}
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <ol className="steps" aria-label="Onboarding progress">
        {STEPS.map((label, index) => (
          <li
            key={label}
            aria-current={index === step ? 'step' : undefined}
            className={index < step ? 'done' : undefined}
          >
            <span className="step-dot" aria-hidden="true">
              {index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>

      <ProgressBar value={((step + 1) / STEPS.length) * 100} label={`Step ${step + 1} of ${STEPS.length}`} />

      {step === 0 ? (
        <div className="form-grid cols-2">
          <Field id="ob-name" label="Full name">
            <TextInput
              id="ob-name"
              value={draft.fullName}
              onChange={(e) => patch({ fullName: e.target.value })}
              placeholder="e.g. Adamu Garba"
              autoComplete="name"
            />
          </Field>
          <Field id="ob-phone" label="Phone number" hint="Used for OTP sign-in and SMS alerts.">
            <TextInput
              id="ob-phone"
              value={draft.phone}
              onChange={(e) => patch({ phone: e.target.value })}
              placeholder="0803 000 0000"
              inputMode="tel"
              autoComplete="tel"
            />
          </Field>
          <Field id="ob-role" label="I am joining as">
            <Select
              id="ob-role"
              value={draft.role}
              onChange={(e) => patch({ role: e.target.value as UserRole })}
            >
              {USER_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ob-lang" label="Preferred language">
            <Select
              id="ob-lang"
              value={draft.language}
              onChange={(e) => patch({ language: e.target.value as LanguageCode })}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}

      {step === 1 ? (
        <div className="form-grid cols-2">
          <Field id="ob-state" label="State">
            <Select id="ob-state" value={draft.state} onChange={(e) => patch({ state: e.target.value })}>
              <option value="">Select state…</option>
              {NIGERIAN_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ob-lga" label="Local government area (LGA)">
            <TextInput
              id="ob-lga"
              value={draft.lga}
              onChange={(e) => patch({ lga: e.target.value })}
              placeholder="e.g. Zaria"
            />
          </Field>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="stack">
          <Field id="ob-interests" label="Farming interests" hint="Choose all that apply.">
            <div className="cluster" role="group" aria-labelledby="ob-interests">
              {VALUE_CHAINS.slice(0, 10).map((chain) => (
                <button
                  key={chain}
                  type="button"
                  className="chip"
                  aria-pressed={draft.farmingInterests.includes(chain)}
                  onClick={() => patch({ farmingInterests: toggle(draft.farmingInterests, chain) })}
                >
                  {chain}
                </button>
              ))}
            </div>
          </Field>
          <Field id="ob-chains" label="Value chains you work in">
            <div className="cluster" role="group" aria-label="Value chains">
              {VALUE_CHAINS.map((chain) => (
                <button
                  key={chain}
                  type="button"
                  className="chip"
                  aria-pressed={draft.valueChains.includes(chain)}
                  onClick={() => patch({ valueChains: toggle(draft.valueChains, chain) })}
                >
                  {chain}
                </button>
              ))}
            </div>
          </Field>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="form-grid cols-2">
          <Field id="ob-size" label="Farm size (hectares)">
            <TextInput
              id="ob-size"
              value={draft.farmSizeHectares}
              onChange={(e) => patch({ farmSizeHectares: e.target.value })}
              inputMode="decimal"
              placeholder="e.g. 2.5"
            />
          </Field>
          <Field id="ob-exp" label="Years of experience">
            <TextInput
              id="ob-exp"
              value={draft.yearsExperience}
              onChange={(e) => patch({ yearsExperience: e.target.value })}
              inputMode="numeric"
              placeholder="e.g. 4"
            />
          </Field>
          <Field id="ob-bio" label="Short bio" hint="At least 20 characters — it raises your profile score.">
            <TextArea
              id="ob-bio"
              value={draft.bio}
              onChange={(e) => patch({ bio: e.target.value })}
              placeholder="Tell other members what you grow and what you are working towards."
            />
          </Field>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="stack">
          <div className="card">
            <h3>{draft.fullName.trim() || 'Unnamed member'}</h3>
            <p className="small muted">
              {ROLE_LABELS[draft.role]} · {LANGUAGES.find((l) => l.code === draft.language)?.label} ·{' '}
              {draft.state || 'No state'}
              {draft.lga ? `, ${draft.lga}` : ''}
            </p>
            <div className="cluster">
              <StatusBadge tone={score >= 60 ? 'success' : 'warning'}>{badge} profile</StatusBadge>
              <span className="small muted">
                {draft.valueChains.length} value chain{draft.valueChains.length === 1 ? '' : 's'} selected
              </span>
            </div>
            <div style={{ marginTop: '0.9rem' }}>
              <ProgressBar value={score} label="Profile completion" />
            </div>
          </div>
          <p className="small muted">
            By continuing you agree to essential service processing under NDPR/NDPA. You can manage all
            other consents any time on the privacy page.
          </p>
        </div>
      ) : null}

      <div className="cluster" style={{ justifyContent: 'space-between' }}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
          >
            Continue
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={finish}>
            Finish and join
          </button>
        )}
      </div>
    </div>
  );
}
