import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApiClient } from '../api/context';
import { fetchWeather, listMyPathwayEnrolments, listOpportunities } from '../api/endpoints';
import type { MyPathwayEnrolmentSummary, WeatherSnapshot } from '../api/types';
import { Card, CardTitle, Loading, Muted, PrimaryButton } from './ui';

interface DashboardData {
  pathways: MyPathwayEnrolmentSummary[];
  opportunitiesTotal: number;
  weather: WeatherSnapshot | null;
}

/**
 * Home dashboard: training progress (from /pathway-enrolments/mine),
 * open opportunities count, and a weather card for the member's state.
 */
export function HomeScreen({
  state = 'Kano',
  onOpenCourses,
  onOpenMarketplace,
  onOpenProfile
}: {
  state?: string;
  onOpenCourses: () => void;
  onOpenMarketplace: () => void;
  onOpenProfile: () => void;
}) {
  const client = useApiClient();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pathways, opportunities, weather] = await Promise.all([
        listMyPathwayEnrolments(client).then((res) => res.data),
        listOpportunities(client, { pageSize: 1 }).then((res) => res.total),
        fetchWeather(client, state)
          .then((res) => res.data)
          .catch(() => null) // weather is best-effort on the dashboard
      ]);
      setData({ pathways, opportunitiesTotal: opportunities, weather });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your dashboard');
    }
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <CardTitle>Dashboard unavailable</CardTitle>
          <Muted>{error}</Muted>
          <PrimaryButton label="Retry" onPress={() => void load()} />
        </Card>
      </ScrollView>
    );
  }

  if (!data) {
    return <Loading />;
  }

  const stagesTotal = data.pathways.reduce((sum, entry) => sum + entry.stagesTotal, 0);
  const stagesCompleted = data.pathways.reduce((sum, entry) => sum + entry.stagesCompleted, 0);
  const progressPercent = stagesTotal > 0 ? Math.round((stagesCompleted / stagesTotal) * 100) : 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card>
        <CardTitle>Training progress</CardTitle>
        {data.pathways.length === 0 ? (
          <Muted>No pathway enrolments yet — enrol from the courses tab to get started.</Muted>
        ) : (
          <>
            <Text style={styles.bigNumber}>{progressPercent}%</Text>
            <Muted>
              {stagesCompleted} of {stagesTotal} stages complete across {data.pathways.length}{' '}
              pathway(s)
            </Muted>
          </>
        )}
      </Card>

      <Card>
        <CardTitle>Opportunities</CardTitle>
        <Text style={styles.bigNumber}>{data.opportunitiesTotal}</Text>
        <Muted>open grants, loans and programmes</Muted>
      </Card>

      <Card>
        <CardTitle>Weather — {data.weather?.state ?? state}</CardTitle>
        {data.weather ? (
          <Muted>
            {data.weather.temperatureCelsius}°C · humidity {data.weather.humidityPercent}% · rain{' '}
            {data.weather.rainfallMm}mm — {data.weather.outlook}
          </Muted>
        ) : (
          <Muted>Weather is unavailable right now.</Muted>
        )}
      </Card>

      <Card>
        <CardTitle>Explore</CardTitle>
        <PrimaryButton label="Browse courses" onPress={onOpenCourses} />
        <PrimaryButton label="Browse marketplace" onPress={onOpenMarketplace} />
        <PrimaryButton label="View profile" onPress={onOpenProfile} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  bigNumber: { fontSize: 28, fontWeight: '800', color: '#1b5e20' }
});
