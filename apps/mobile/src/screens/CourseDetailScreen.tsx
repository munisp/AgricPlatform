import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { fetchCourse } from '../api/endpoints';
import type { Course } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted } from './ui';

export function CourseDetailScreen({ courseId }: { courseId: string }) {
  const client = useApiClient();
  const [course, setCourse] = useState<Course | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await fetchCourse(client, courseId, { signal });
        if (signal?.aborted) return;
        setCourse(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load this course');
      }
    },
    [client, courseId]
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (error) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!course) {
    return <Loading />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card>
        <CardTitle>{course.title}</CardTitle>
        <Muted>
          {course.category} · {course.level} · {course.durationMinutes} minutes ·{' '}
          {course.language.toUpperCase()}
        </Muted>
        <Muted>{course.enrolmentCount} members enrolled</Muted>
        {course.offlineAvailable ? <Muted>Available in the offline pack.</Muted> : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' }
});
