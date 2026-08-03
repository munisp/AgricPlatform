'use client';

import { useEffect, useState } from 'react';
import { useApiMutation, useApiQuery } from '@/lib/api/hooks';
import {
  fetchVoiceAgentCase,
  respondVoiceAgentCase,
  type VoiceTurn
} from '@/lib/api/endpoints';
import { useT } from '@/lib/i18n';
import { QueryState } from '@/components/api-state';
import { Field, TextArea } from '@/components/forms';
import { StatusBadge } from '@/components/ui';

function speakerTone(speaker: VoiceTurn['speaker']) {
  if (speaker === 'farmer') return 'info' as const;
  if (speaker === 'agent') return 'success' as const;
  return 'neutral' as const;
}

/**
 * Agent-assist case detail (wave VOICE): full session transcript with the
 * RAG citations behind every grounded assistant answer, the suggested
 * retrieval answer pre-filled for review, and respond / respond+resolve
 * actions. Resolved cases are read-only.
 */
export function AgentAssistCase({ caseId }: { caseId: string }) {
  const { t } = useT();
  const detail = useApiQuery(
    `voice:agent-case:${caseId}`,
    () => fetchVoiceAgentCase(caseId).then((res) => res.data),
    { staleTimeMs: 10_000 }
  );

  const [response, setResponse] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Pre-fill the suggested retrieval answer once the detail loads.
  useEffect(() => {
    const suggested = detail.data?.agentCase.suggestedAnswer;
    if (suggested && response === '') {
      setResponse(suggested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.agentCase.suggestedAnswer]);

  const mutation = useApiMutation<{ resolve: boolean }, unknown>({
    mutationFn: ({ resolve }) => respondVoiceAgentCase(caseId, { response, resolve }),
    onSuccess: (_result, input) => {
      setNotice(input.resolve ? t('voice.resolvedNotice') : t('voice.respondedNotice'));
      detail.refresh();
    }
  });

  const agentCase = detail.data?.agentCase;
  const resolved = agentCase?.status === 'resolved';
  const canSend = !resolved && response.trim().length > 0 && mutation.status !== 'pending';

  return (
    <QueryState
      isLoading={detail.isLoading}
      error={detail.error}
      data={detail.data}
      onRetry={detail.refresh}
    >
      {detail.data && agentCase ? (
        <div className="stack">
          <div className="cluster">
            <StatusBadge tone={agentCase.status === 'resolved' ? 'success' : 'critical'}>
              {agentCase.status}
            </StatusBadge>
            <StatusBadge tone="neutral">{agentCase.channel}</StatusBadge>
            {agentCase.priority === 'high' ? (
              <StatusBadge tone="warning">{agentCase.priority}</StatusBadge>
            ) : null}
          </div>
          <p className="small soft">
            {t('voice.reasonLabel')}: {agentCase.reason} · {t('voice.phoneLabel')}: {agentCase.phone} ·{' '}
            {t('voice.slaLabel')}: {agentCase.slaDueAt.slice(0, 16).replace('T', ' ')}
          </p>
          {detail.data.session.locale !== 'en' ? (
            <p className="small muted">{t('voice.localeNote')}</p>
          ) : null}

          <section aria-labelledby="voice-transcript">
            <h2 id="voice-transcript">{t('voice.transcriptTitle')}</h2>
            <ol className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {detail.data.turns.map((turn) => {
                const grounded = turn.speaker === 'assistant' && turn.citedChunkIds.length > 0;
                const fallback = turn.speaker === 'assistant' && turn.citedChunkIds.length === 0;
                return (
                  <li key={turn.id} className="card">
                    <div className="cluster">
                      <StatusBadge tone={speakerTone(turn.speaker)}>
                        {turn.speaker === 'farmer'
                          ? t('voice.farmerLabel')
                          : turn.speaker === 'agent'
                            ? t('voice.agentLabel')
                            : t('voice.assistantLabel')}
                      </StatusBadge>
                      {grounded ? (
                        <StatusBadge tone="info">{t('voice.groundedBadge')}</StatusBadge>
                      ) : null}
                      {fallback ? (
                        <StatusBadge tone="neutral">{t('voice.fallbackBadge')}</StatusBadge>
                      ) : null}
                    </div>
                    <p>{turn.text}</p>
                    {grounded ? (
                      <p className="small soft">
                        {t('voice.citationsLabel')}: {turn.citedChunkIds.join(', ')}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </section>

          {agentCase.suggestedAnswer ? (
            <section aria-labelledby="voice-suggested">
              <h2 id="voice-suggested">{t('voice.suggestedTitle')}</h2>
              <p className="small soft">{agentCase.suggestedAnswer}</p>
            </section>
          ) : null}

          <Field id="voice-response" label={t('voice.responseLabel')}>
            <TextArea
              id="voice-response"
              rows={5}
              value={response}
              placeholder={t('voice.responsePlaceholder')}
              disabled={resolved}
              onChange={(event) => setResponse(event.target.value)}
            />
          </Field>
          <div className="cluster">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canSend}
              onClick={() => mutation.mutate({ resolve: false })}
            >
              {mutation.status === 'pending' ? t('voice.working') : t('voice.respondAction')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSend}
              onClick={() => mutation.mutate({ resolve: true })}
            >
              {mutation.status === 'pending' ? t('voice.working') : t('voice.resolveAction')}
            </button>
          </div>
          {mutation.error ? (
            <p className="small" role="alert">
              {t('voice.loadError')}
            </p>
          ) : null}
          {notice ? (
            <p className="small" role="status">
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
}
