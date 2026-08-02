import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useApiClient } from '../api/context';
import { listCourses } from '../api/endpoints';
import type { Course } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

export function CoursesScreen({ onOpenCourse }: { onOpenCourse: (courseId: string) => void }) {
  const client = useApiClient();
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await listCourses(client, { pageSize: 50 });
      setCourses(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load courses');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

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
      keyExtractor={(course) => course.id}
      ListEmptyComponent={
        <Card>
          <CardTitle>No courses yet</CardTitle>
          <Muted>Training courses will appear here once published.</Muted>
        </Card>
      }
      renderItem={({ item }) => (
        <Card>
          <CardTitle>{item.title}</CardTitle>
          <Muted>
            {item.category} · {item.level} · {item.durationMinutes} min
            {item.offlineAvailable ? ' · offline pack' : ''}
          </Muted>
          <Text style={styles.enrolCount}>{item.enrolmentCount} enrolled</Text>
          <PrimaryButton label="View course" onPress={() => onOpenCourse(item.id)} />
        </Card>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  enrolCount: { marginVertical: 8, fontSize: 13 }
});
