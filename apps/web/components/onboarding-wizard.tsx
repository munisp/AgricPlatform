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
import { useSession } from '@/lib/session';
import { useFormDraft } from '@/lib/drafts';
import { useT } from '@/lib/i18n';
import type { TranslationKey } from '@/lib/i18n';
import { NetworkError, TimeoutError } from '@/lib/api/errors';
import { register, upsertProfile } from '@/lib/api/endpoints';
import { ROLE_LABELS } from '@/lib/content';
import { DraftRestoredNotice, Field, QueuedNotice, Select, TextArea, TextInput } from '@/components/forms';
import { ApiErrorNotice } from '@/components/api-state';
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

const STEPS: TranslationKey[] = [
  'onboarding.stepAccount',
  'onboarding.stepLocation',
  'onboarding.stepInterests',
  'onboarding.stepFarm',
  'onboarding.stepReview'
];

const LANGUAGES: { code: LanguageCode; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ha', label: 'Hausa' },
  { code: 'yo', label: 'Yoruba' },
  { code: 'ig', label: 'Igbo' }
];

function toggle(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

/** The draft only counts as real content once a text field has been typed in. */
function isEmptyDraft(draft: OnboardingDraft): boolean {
  return (
    draft.fullName.trim() === '' &&
    draft.phone.trim() === '' &&
    draft.state === '' &&
    draft.lga.trim() === '' &&
    draft.farmingInterests.length === 0 &&
    draft.valueChains.length === 0 &&
    draft.bio.trim() === '' &&
    draft.farmSizeHectares === '' &&
    draft.yearsExperience === ''
  );
}

export function OnboardingWizard() {
  const { t } = useT();
  const { enqueue, setRole } = useAppState();
  const { signIn } = useSession();
  const [step, setStep] = useState(0);
  // IndexedDB draft persistence: autosaves on keystroke and restores after a
  // reload (Appendix F Phase-1). Cleared on successful registration.
  const { draft, setDraft, restored, clearDraft } = useFormDraft<OnboardingDraft>(
    'registration',
    EMPTY_DRAFT,
    isEmptyDraft
  );
  const [submitted, setSubmitted] = useState<'online' | 'queued' | false>(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(undefined);

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

  const profilePayload = () => ({
    location: draft.state ? { state: draft.state, lga: draft.lga } : undefined,
    farmingInterests: draft.farmingInterests,
    valueChains: draft.valueChains,
    bio: draft.bio || undefined,
    farmSizeHectares: draft.farmSizeHectares ? Number(draft.farmSizeHectares) : undefined,
    yearsExperience: draft.yearsExperience ? Number(draft.yearsExperience) : undefined
  });

  const finish = async () => {
    setSubmitting(true);
    setSubmitError(undefined);
    const registerPayload = {
      phone: draft.phone.trim(),
      fullName: draft.fullName.trim(),
      roles: [draft.role],
      preferredLanguage: draft.language
    };
    try {
      // POST /auth/register → then PUT /profiles/:userId with the wizard data.
      const res = await register(registerPayload);
      const user = res.data.user;
      // API-GAP: auth/register currently returns a non-JWT stub token that
      // the API's bearer verification would reject; the session continues
      // with the dev x-user-id identity until the OIDC sign-in flow lands.
      signIn({
        userId: user.id,
        displayName: user.fullName,
        role: user.roles[0] ?? draft.role
      });
      try {
        await upsertProfile(user.id, profilePayload());
      } catch {
        enqueue({
          kind: 'profile.updated',
          label: `Profile setup for ${user.fullName}`,
          method: 'PUT',
          path: `/profiles/${user.id}`,
          payload: profilePayload()
        });
      }
      setSubmitted('online');
      clearDraft();
    } catch (error) {
      if (error instanceof NetworkError || error instanceof TimeoutError) {
        // Offline-first: park the registration and keep the local draft.
        setRole(draft.role);
        enqueue({
          kind: 'identity.user.registered',
          label: `Onboarding for ${draft.fullName.trim() || 'new member'} (${ROLE_LABELS[draft.role]})`,
          method: 'POST',
          path: '/auth/register',
          payload: registerPayload
        });
        setSubmitted('queued');
      } else {
        setSubmitError(error);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="stack">
        <div className="notice notice-success" role="status">
          <strong>Welcome to NYFN, {draft.fullName.trim().split(' ')[0] || 'farmer'}.</strong> Your
          profile is {submitted === 'online' ? 'registered with the platform' : 'saved on this device'}{' '}
          with a {score}% completion score ({badge} badge).
        </div>
        {submitted === 'queued' ? <QueuedNotice label="Your onboarding submission" /> : null}
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
              clearDraft();
              setStep(0);
              setSubmitted(false);
              setSubmitError(undefined);
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
      {restored ? <DraftRestoredNotice onDismiss={clearDraft} /> : null}
      <ol className="steps" aria-label={t('onboarding.stepsAria')}>
        {STEPS.map((labelKey, index) => (
          <li
            key={labelKey}
            aria-current={index === step ? 'step' : undefined}
            className={index < step ? 'done' : undefined}
          >
            <span className="step-dot" aria-hidden="true">
              {index + 1}
            </span>
            {t(labelKey)}
          </li>
        ))}
      </ol>

      <ProgressBar value={((step + 1) / STEPS.length) * 100} label={t('onboarding.stepProgress', { step: step + 1, total: STEPS.length })} />

      {step === 0 ? (
        <div className="form-grid cols-2">
          <Field id="ob-name" label={t('onboarding.fullName')}>
            <TextInput
              id="ob-name"
              value={draft.fullName}
              onChange={(e) => patch({ fullName: e.target.value })}
              placeholder="e.g. Adamu Garba"
              autoComplete="name"
            />
          </Field>
          <Field id="ob-phone" label={t('onboarding.phone')} hint={t('onboarding.phoneHint')}>
            <TextInput
              id="ob-phone"
              value={draft.phone}
              onChange={(e) => patch({ phone: e.target.value })}
              placeholder="0803 000 0000"
              inputMode="tel"
              autoComplete="tel"
            />
          </Field>
          <Field id="ob-role" label={t('onboarding.role')}>
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
          <Field id="ob-lang" label={t('onboarding.language')}>
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
          <Field id="ob-state" label={t('onboarding.state')}>
            <Select id="ob-state" value={draft.state} onChange={(e) => patch({ state: e.target.value })}>
              <option value="">{t('onboarding.selectState')}</option>
              {NIGERIAN_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="ob-lga" label={t('onboarding.lga')}>
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
          <Field id="ob-interests" label={t('onboarding.interests')} hint={t('onboarding.interestsHint')}>
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
          <Field id="ob-chains" label={t('onboarding.chains')}>
            <div className="cluster" role="group" aria-label={t('onboarding.chainsAria')}>
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
          <Field id="ob-size" label={t('onboarding.farmSize')}>
            <TextInput
              id="ob-size"
              value={draft.farmSizeHectares}
              onChange={(e) => patch({ farmSizeHectares: e.target.value })}
              inputMode="decimal"
              placeholder="e.g. 2.5"
            />
          </Field>
          <Field id="ob-exp" label={t('onboarding.experience')}>
            <TextInput
              id="ob-exp"
              value={draft.yearsExperience}
              onChange={(e) => patch({ yearsExperience: e.target.value })}
              inputMode="numeric"
              placeholder="e.g. 4"
            />
          </Field>
          <Field id="ob-bio" label={t('onboarding.bio')} hint={t('onboarding.bioHint')}>
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
          {t('onboarding.back')}
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canContinue}
            onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
          >
            {t('onboarding.continue')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => void finish()}
          >
            {submitting ? t('onboarding.joining') : t('onboarding.finish')}
          </button>
        )}
      </div>

      {submitError ? (
        <ApiErrorNotice error={submitError} onRetry={() => void finish()} />
      ) : null}
    </div>
  );
}
