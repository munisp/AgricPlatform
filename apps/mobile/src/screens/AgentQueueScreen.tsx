import { memo, useCallback, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { listMyAgentAssignments, reportAgentAssignmentProgress } from '../api/endpoints';
import type { AgentAssignment } from '../api/types';
import type { OfflineQueue } from '../offline/queue';
import { useListRefresh } from './use-list-refresh';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

const AssignmentCard = memo(function AssignmentCard({
  assignment,
  busy,
  anyBusy,
  onReport
}: {
  assignment: AgentAssignment;
  busy: boolean;
  anyBusy: boolean;
  onReport: (assignment: AgentAssignment) => void;
}) {
  return (
    <Card>
      <Text style={styles.line}>{assignment.purpose}</Text>
      <Muted>
        {assignment.state} / {assignment.lga}
        {assignment.ward ? ` / ${assignment.ward}` : ''}
        {assignment.dueAt ? ` · due ${assignment.dueAt.slice(0, 10)}` : ''}
      </Muted>
      <Muted>
        {assignment.completedCount} of {assignment.targetCount} done · {assignment.status}
      </Muted>
      <PrimaryButton
        label={busy ? 'Reporting…' : 'Report progress'}
        onPress={() => onReport(assignment)}
        disabled={anyBusy}
      />
    </Card>
  );
});

function assignmentKey(assignment: AgentAssignment): string {
  return assignment.id;
}

/**
 * Enumerator field queue (Wave AGENTS): open assignments from
 * GET /field-agents/assignments/mine with a per-card progress action.
 *
 * Offline-first: when an OfflineQueue is provided, each progress report is
 * enqueued FIRST (idempotency-keyed) and the queue is then flushed through
 * the API client — a failed flush leaves the entry parked for the next
 * reconnect instead of losing the report, and a replay cannot double-count
 * because the idempotency key is stable per logical report.
 */
export function AgentQueueScreen({ queue }: { queue?: OfflineQueue }) {
  const client = useApiClient();
  const [assignments, setAssignments] = useState<AgentAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await listMyAgentAssignments(client, { signal });
        if (signal?.aborted) return;
        setAssignments(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load your assignments');
      }
    },
    [client]
  );

  // Reload on mount + on focus, plus pull-to-refresh (audit P1-9).
  const { refreshing, refresh } = useListRefresh(load);

  const reportProgress = useCallback(
    async (assignment: AgentAssignment) => {
      setBusyId(assignment.id);
      setError(null);
      setNotice(null);
      // Stable key per logical report: a double-tap dedups to one queue entry.
      const idempotencyKey = `agent-progress:${assignment.id}:${assignment.completedCount + 1}`;
      try {
        if (queue) {
          await queue.enqueue({
            kind: 'field-agents.assignment.progress',
            method: 'POST',
            path: `/field-agents/assignments/${assignment.id}/progress`,
            payload: { count: 1 },
            idempotencyKey,
            // Progress increments on one assignment form a dependency chain:
            // a failed replay blocks later increments until the next flush.
            chainKey: `field-agents.assignment:${assignment.id}`
          });
          const result = await queue.flush((request) =>
            client.apiFetch(request.path, {
              method: request.method,
              body: request.payload,
              idempotencyKey: request.idempotencyKey
            })
          );
          if (result.failed > 0 || result.parked > 0) {
            setNotice('Saved offline — will sync when you are back online.');
          }
        } else {
          await reportAgentAssignmentProgress(client, assignment.id, 1, idempotencyKey);
        }
        await load();
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not report progress');
      } finally {
        setBusyId(null);
      }
    },
    [client, queue, load]
  );

  const renderItem = useCallback(
    ({ item }: { item: AgentAssignment }) => (
      <AssignmentCard
        assignment={item}
        busy={busyId === item.id}
        anyBusy={busyId !== null}
        onReport={reportProgress}
      />
    ),
    [busyId, reportProgress]
  );

  if (error && !assignments) {
    return (
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!assignments) {
    return <Loading />;
  }

  return (
    <FlatList
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      data={assignments}
      keyExtractor={assignmentKey}
      ListHeaderComponent={
        <>
          {error ? <ErrorNotice message={error} /> : null}
          {notice ? <Muted>{notice}</Muted> : null}
          <Card>
            <CardTitle>My field assignments ({assignments.length})</CardTitle>
            {assignments.length === 0 ? <Muted>No open assignments right now.</Muted> : null}
          </Card>
        </>
      }
      renderItem={renderItem}
      initialNumToRender={8}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  line: { fontSize: 15, fontWeight: '600', color: '#1c1c1a' }
});
