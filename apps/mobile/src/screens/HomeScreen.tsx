import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { useApiClient } from '../api/context';
import {
  fetchSession,
  fetchWeather,
  listDueVaccinations,
  listMyAnimals,
  listMyOrders,
  listMyPathwayEnrolments,
  listOpportunities
} from '../api/endpoints';
import type { MyPathwayEnrolmentSummary, WeatherSnapshot } from '../api/types';
import { Card, CardTitle, Loading, Muted, PrimaryButton } from './ui';

interface DashboardData {
  pathways: MyPathwayEnrolmentSummary[];
  opportunitiesTotal: number;
  weather: WeatherSnapshot | null;
  /** Farmer summary cards (best-effort, mirror the web dashboard sources). */
  animalsTotal: number | null;
  /** Vaccinations due or overdue (from /livestock-health/vaccinations/due). */
  pendingHealthTasks: number | null;
  overdueHealthTasks: number | null;
  activeOrders: number | null;
}

/** Orders that still need the farmer's attention. */
const ACTIVE_ORDER_STATUSES = new Set(['placed', 'deposit_paid', 'in_fulfilment', 'delivered']);

/**
 * Home dashboard: training progress (from /pathway-enrolments/mine),
 * open opportunities count, and a weather card for the member's state.
 */
export function HomeScreen({
  state = 'Kano',
  onOpenCourses,
  onOpenMarketplace,
  onOpenProfile,
  onOpenOrders,
  onOpenNotifications,
  onOpenLivestock,
  onOpenFarms
}: {
  state?: string;
  onOpenCourses: () => void;
  onOpenMarketplace: () => void;
  onOpenProfile: () => void;
  onOpenOrders: () => void;
  onOpenNotifications: () => void;
  onOpenLivestock: () => void;
  /** Farms wave: plot list/capture entry (optional until all callers wire it). */
  onOpenFarms?: () => void;
}) {
  const client = useApiClient();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pathways, opportunities, weather, farm] = await Promise.all([
        listMyPathwayEnrolments(client).then((res) => res.data),
        listOpportunities(client, { pageSize: 1 }).then((res) => res.total),
        fetchWeather(client, state)
          .then((res) => res.data)
          .catch(() => null), // weather is best-effort on the dashboard
        // Farmer summary (animals, pending health tasks, active orders) is
        // best-effort: each source falls back to null independently.
        (async () => {
          const [animals, health, orders] = await Promise.all([
            listMyAnimals(client)
              .then((res) => res.data.length)
              .catch(() => null),
            // Pending health tasks = vaccinations due or overdue (the recalls
            // list is regulator/admin-only and was never a valid proxy).
            listDueVaccinations(client)
              .then((res) => {
                const pending = res.data.filter((item) => item.status !== 'upcoming');
                return {
                  pending: pending.length,
                  overdue: pending.filter((item) => item.status === 'overdue').length
                };
              })
              .catch(() => null),
            fetchSession(client)
              .then((session) => listMyOrders(client, session.data.user.id))
              .then((res) => res.data.filter((order) => ACTIVE_ORDER_STATUSES.has(order.status)).length)
              .catch(() => null)
          ]);
          return { animals, health, orders };
        })()
      ]);
      setData({
        pathways,
        opportunitiesTotal: opportunities,
        weather,
        animalsTotal: farm.animals,
        pendingHealthTasks: farm.health?.pending ?? null,
        overdueHealthTasks: farm.health?.overdue ?? null,
        activeOrders: farm.orders
      });
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
        <CardTitle>Farm summary</CardTitle>
        <Text style={styles.bigNumber}>{data.animalsTotal ?? '—'}</Text>
        <Muted>registered animals</Muted>
        <Text style={styles.bigNumber}>{data.pendingHealthTasks ?? '—'}</Text>
        <Muted>
          pending health tasks (vaccinations due
          {data.overdueHealthTasks ? ` · ${data.overdueHealthTasks} overdue` : ''})
        </Muted>
        <Text style={styles.bigNumber}>{data.activeOrders ?? '—'}</Text>
        <Muted>active orders</Muted>
      </Card>

      <Card>
        <CardTitle>Explore</CardTitle>
        <PrimaryButton label="Browse courses" onPress={onOpenCourses} />
        <PrimaryButton label="Browse marketplace" onPress={onOpenMarketplace} />
        <PrimaryButton label="My orders" onPress={onOpenOrders} />
        <PrimaryButton label="Notifications" onPress={onOpenNotifications} />
        <PrimaryButton label="My livestock" onPress={onOpenLivestock} />
        {onOpenFarms ? <PrimaryButton label="My plots" onPress={onOpenFarms} /> : null}
        <PrimaryButton label="View profile" onPress={onOpenProfile} />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' },
  bigNumber: { fontSize: 28, fontWeight: '800', color: '#1b5e20' }
});
