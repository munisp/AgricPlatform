import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { Card, CardTitle, Loading, Muted, MetricTile, PrimaryButton, SectionCard, tokens } from './ui';

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
  /** Session roles — drive hub tile ordering (best-effort). */
  roles: string[];
}

/** Orders that still need the farmer's attention. */
const ACTIVE_ORDER_STATUSES = new Set(['placed', 'deposit_paid', 'in_fulfilment', 'delivered']);

/* --------------------------- hub tile registry ---------------------------
 * The home hub is data-driven: adding a future innovation screen (voice
 * agronomist, traceability, carbon, …) is a one-line HUB_TILES entry plus
 * one callback prop — no layout changes.
 */
export interface HubTile {
  id: string;
  label: string;
}

export const HUB_TILES: HubTile[] = [
  { id: 'courses', label: 'Browse courses' },
  { id: 'marketplace', label: 'Browse marketplace' },
  { id: 'orders', label: 'My orders' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'livestock', label: 'My livestock' },
  { id: 'farms', label: 'My plots' },
  { id: 'agentQueue', label: 'My field queue' },
  { id: 'profile', label: 'View profile' }
];

/** Tiles a role uses most, surfaced first (unlisted tiles keep default order). */
const ROLE_TILE_FIRST: Record<string, string[]> = {
  enumerator: ['agentQueue', 'farms'],
  farmer: ['farms', 'livestock', 'marketplace'],
  buyer: ['marketplace', 'orders'],
  supplier: ['marketplace', 'orders'],
  student: ['courses', 'notifications'],
  chapter_lead: ['notifications', 'courses']
};

/** Role-aware tile ordering: role-priority tiles first, then the rest. */
export function orderTilesForRoles(tiles: HubTile[], roles: string[]): HubTile[] {
  const priority = roles.flatMap((role) => ROLE_TILE_FIRST[role] ?? []);
  if (priority.length === 0) return tiles;
  const rank = new Map(priority.map((id, index) => [id, index]));
  return [...tiles].sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

export interface HomeScreenProps {
  state?: string;
  onOpenCourses: () => void;
  onOpenMarketplace: () => void;
  onOpenProfile: () => void;
  onOpenOrders: () => void;
  onOpenNotifications: () => void;
  onOpenLivestock: () => void;
  /** Farms wave: plot list/capture entry (optional until all callers wire it). */
  onOpenFarms?: () => void;
  /** Wave AGENTS: enumerators jump straight to their field queue. */
  onOpenAgentQueue?: () => void;
}

/**
 * Home dashboard: training progress (from /pathway-enrolments/mine),
 * open opportunities count, weather, farm summary and a role-aware hub
 * grid of product tiles built from the UI kit v2 primitives.
 */
export function HomeScreen({
  state = 'Kano',
  onOpenCourses,
  onOpenMarketplace,
  onOpenProfile,
  onOpenOrders,
  onOpenNotifications,
  onOpenLivestock,
  onOpenFarms,
  onOpenAgentQueue
}: HomeScreenProps) {
  const client = useApiClient();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pathways, opportunities, weather, session, farm] = await Promise.all([
        listMyPathwayEnrolments(client).then((res) => res.data),
        listOpportunities(client, { pageSize: 1 }).then((res) => res.total),
        fetchWeather(client, state)
          .then((res) => res.data)
          .catch(() => null), // weather is best-effort on the dashboard
        fetchSession(client)
          .then((res) => res.data)
          .catch(() => null), // roles only order the hub — best-effort
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
              .then((res) => listMyOrders(client, res.data.user.id))
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
        activeOrders: farm.orders,
        roles: session?.user.roles ?? []
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

  // Hub tiles render only when their screen is wired for this user; the
  // order follows the session roles (enumerators see the field queue first).
  const openers: Record<string, (() => void) | undefined> = {
    courses: onOpenCourses,
    marketplace: onOpenMarketplace,
    orders: onOpenOrders,
    notifications: onOpenNotifications,
    livestock: onOpenLivestock,
    farms: onOpenFarms,
    agentQueue: onOpenAgentQueue,
    profile: onOpenProfile
  };
  const tiles = orderTilesForRoles(
    HUB_TILES.filter((tile) => typeof openers[tile.id] === 'function'),
    data.roles
  );

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <SectionCard kicker="Learning" title="Training progress">
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
      </SectionCard>

      <SectionCard kicker="Funding" title="Opportunities">
        <Text style={styles.bigNumber}>{data.opportunitiesTotal}</Text>
        <Muted>open grants, loans and programmes</Muted>
      </SectionCard>

      <SectionCard kicker="Advisory" title={`Weather — ${data.weather?.state ?? state}`}>
        {data.weather ? (
          <Muted>
            {data.weather.temperatureCelsius}°C · humidity {data.weather.humidityPercent}% · rain{' '}
            {data.weather.rainfallMm}mm — {data.weather.outlook}
          </Muted>
        ) : (
          <Muted>Weather is unavailable right now.</Muted>
        )}
      </SectionCard>

      <SectionCard kicker="My farm" title="Farm summary">
        <View style={styles.metricRow}>
          <MetricTile value={data.animalsTotal ?? '—'} label="registered animals" />
          <MetricTile
            value={data.pendingHealthTasks ?? '—'}
            label={`pending health tasks (vaccinations due${
              data.overdueHealthTasks ? ` · ${data.overdueHealthTasks} overdue` : ''
            })`}
          />
          <MetricTile value={data.activeOrders ?? '—'} label="active orders" />
        </View>
      </SectionCard>

      <SectionCard kicker="Products" title="Explore">
        <View style={styles.hubGrid}>
          {tiles.map((tile) => (
            <Pressable
              key={tile.id}
              accessibilityRole="button"
              onPress={openers[tile.id]}
              style={styles.hubTile}
            >
              <View style={styles.hubGlyph} accessibilityElementsHidden importantForAccessibility="no">
                <View style={styles.hubGlyphMark} />
              </View>
              <Text style={styles.hubLabel}>{tile.label}</Text>
            </Pressable>
          ))}
        </View>
      </SectionCard>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: tokens.colors.sand100 },
  bigNumber: { fontSize: 28, fontWeight: '800', color: tokens.colors.green700 },
  metricRow: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing[2] },
  hubGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing[2] },
  hubTile: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 96,
    backgroundColor: tokens.colors.sand50,
    borderWidth: 1,
    borderColor: tokens.colors.line,
    borderRadius: tokens.radius.m,
    padding: tokens.spacing[3],
    justifyContent: 'space-between'
  },
  hubGlyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: tokens.colors.green100,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: tokens.spacing[2]
  },
  hubGlyphMark: {
    width: 16,
    height: 16,
    backgroundColor: tokens.colors.green600,
    borderTopLeftRadius: 10,
    borderTopRightRadius: 3,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 10
  },
  hubLabel: { fontSize: tokens.type.sm, fontWeight: '700', color: tokens.colors.green900 }
});
