import { memo, useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { isAbortError } from '../api/client';
import { useApiClient } from '../api/context';
import { listCourses } from '../api/endpoints';
import type { Course } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

const CourseCard = memo(function CourseCard({
  course,
  onOpen
}: {
  course: Course;
  onOpen: (courseId: string) => void;
}) {
  return (
    <Card>
      <CardTitle>{course.title}</CardTitle>
      <Muted>
        {course.category} · {course.level} · {course.durationMinutes} min
        {course.offlineAvailable ? ' · offline pack' : ''}
      </Muted>
      <Text style={styles.enrolCount}>{course.enrolmentCount} enrolled</Text>
      <PrimaryButton label="View course" onPress={() => onOpen(course.id)} />
    </Card>
  );
});

function courseKey(course: Course): string {
  return course.id;
}

export function CoursesScreen({ onOpenCourse }: { onOpenCourse: (courseId: string) => void }) {
  const client = useApiClient();
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(null);
      try {
        const res = await listCourses(client, { pageSize: 50 }, { signal });
        if (signal?.aborted) return;
        setCourses(res.data);
      } catch (err) {
        if (isAbortError(err)) return;
        setError(err instanceof Error ? err.message : 'Could not load courses');
      }
    },
    [client]
  );

  // Cancel the in-flight read when the screen unmounts.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Stable across `error` flips so memoized rows skip re-renders.
  const renderItem = useCallback(
    ({ item }: { item: Course }) => <CourseCard course={item} onOpen={onOpenCourse} />,
    [onOpenCourse]
  );

  if (error) {
    return (
      <View style={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </View>
    );
  }
  if (!courses) {
    return <Loading />;
  }

  return (
    <FlatList
      contentContainerStyle={styles.container}
      data={courses}
      keyExtractor={courseKey}
      ListEmptyComponent={
        <Card>
          <CardTitle>No courses yet</CardTitle>
          <Muted>Training courses will appear here once published.</Muted>
        </Card>
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
  enrolCount: { marginVertical: 8, fontSize: 13 }
});
