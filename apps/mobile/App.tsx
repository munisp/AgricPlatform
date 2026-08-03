import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createApiClient } from './src/api/client';
import { ApiProvider } from './src/api/context';
import { fetchSession } from './src/api/endpoints';
import {
  createSecureStoreTokenStore,
  TokenStorageError,
  type TokenStore
} from './src/api/token-store';
import { API_BASE_URL } from './src/config';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { createExpoLocationService } from './src/location/location-service';
import { createOfflineQueue } from './src/offline/queue';
import { SyncProvider } from './src/sync/context';
import { useConnectivitySync } from './src/sync/connectivity';
import { SYNC_ENTITIES } from './src/sync/entities';
import type { User } from './src/api/types';
import { AgentQueueScreen } from './src/screens/AgentQueueScreen';
import { CourseDetailScreen } from './src/screens/CourseDetailScreen';
import { CoursesScreen } from './src/screens/CoursesScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ListingDetailScreen } from './src/screens/ListingDetailScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { MarketplaceScreen } from './src/screens/MarketplaceScreen';
import { LivestockScreen } from './src/screens/LivestockScreen';
import { FarmsScreen } from './src/screens/FarmsScreen';
import { PlotCaptureScreen } from './src/screens/PlotCaptureScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { OrderDetailScreen } from './src/screens/OrderDetailScreen';
import { OrdersScreen } from './src/screens/OrdersScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { Muted, PrimaryButton } from './src/screens/ui';

/**
 * NYFN mobile shell. React Navigation native-stack with AUTH-GATED screen
 * groups (audit P0-1): the Login screen is only registered while signed
 * out and the app screens only while signed in, so a login/logout/session
 * expiry switches the navigator atomically — no dead-end screens.
 *
 * Durability (audit P0-4/P1-5):
 * - Session tokens live in expo-secure-store (Keychain/Keystore) and are
 *   restored on cold start. A secure-store failure is FAIL-CLOSED: the app
 *   shows a clear error instead of degrading to plaintext storage.
 * - The record-level sync store and the shared legacy offline queue both
 *   persist to AsyncStorage, so cursors, the outbox and queued field work
 *   survive restarts. Plot captures flow through the sync outbox
 *   (W-SYNCWRITE); the legacy queue remains for the agent queue and is
 *   flushed on reconnect/foreground (P1-12).
 */

export type RootStackParamList = {
  Login: undefined;
  Home: undefined;
  Courses: undefined;
  CourseDetail: { courseId: string };
  Marketplace: undefined;
  ListingDetail: { listingId: string };
  Orders: undefined;
  OrderDetail: { orderId: string };
  Notifications: undefined;
  Livestock: undefined;
  Farms: undefined;
  PlotCapture: undefined;
  AgentQueue: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Module-scope durable singletons: one secure token store (never a
// plaintext fallback), one AsyncStorage-backed legacy offline queue shared
// by AgentQueue + the connectivity flush, one GPS adapter.
const tokenStore: TokenStore = createSecureStoreTokenStore(SecureStore);
const offlineQueue = createOfflineQueue(AsyncStorage);
const locationService = createExpoLocationService();

/** Entities pulled by the connectivity/foreground sync (see sync/entities). */

/** Flushes the shared offline queue + pulls sync entities on reconnect/foreground. */
function ConnectivityWiring() {
  useConnectivitySync({ queue: offlineQueue, entities: SYNC_ENTITIES });
  return null;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [probeNonce, setProbeNonce] = useState(0);

  // Session expiry (audit P1-7): an unrecoverable 401 (refresh rotation
  // rejected) clears the stored session server-side; here we drop the user,
  // which unregisters the app screens and returns to Login.
  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: API_BASE_URL,
        tokenStore,
        onSessionExpired: () => setUser(null)
      }),
    []
  );

  // Cold-start session restore (audit P0-4): if a refresh token survived
  // the last run, exchange it for the current session instead of bouncing
  // the user to Login. Secure-store failures are fail-closed (P0-4).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const refreshToken = await tokenStore.getRefreshToken();
        if (refreshToken) {
          // No access token after a restart: the client rotates the stored
          // refresh token on the first 401 and retries transparently.
          const session = await fetchSession(client);
          if (!cancelled) setUser(session.data.user);
        }
      } catch (error) {
        if (!cancelled && error instanceof TokenStorageError) {
          setStorageError(error.message);
        }
        // Any other failure (offline, expired session family) simply lands
        // on the Login screen with local state intact.
      } finally {
        if (!cancelled) setSessionChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, probeNonce]);

  // ErrorBoundary recovery (audit P1-8): drop the local session and return
  // to Login without losing queued offline work (the queue is untouched).
  const resetAll = useCallback(() => {
    void tokenStore.clear().catch(() => undefined);
    setUser(null);
  }, []);

  let content;
  if (storageError) {
    // Fail-closed: no plaintext token fallback, ever.
    content = (
      <View style={styles.gate}>
        <Text style={styles.gateTitle}>Secure storage unavailable</Text>
        <Muted>{storageError}</Muted>
        <Muted>
          AgricPlatform stores your sign-in session only in the device secure store (Keychain /
          Keystore) and cannot continue safely without it. Freeing up device storage or restarting
          the phone usually restores it.
        </Muted>
        <PrimaryButton
          label="Try again"
          onPress={() => {
            setStorageError(null);
            setSessionChecked(false);
            setProbeNonce((nonce) => nonce + 1);
          }}
        />
      </View>
    );
  } else if (!sessionChecked) {
    content = (
      <View style={styles.gate}>
        <ActivityIndicator />
        <Muted>Restoring your session…</Muted>
      </View>
    );
  } else {
    content = (
      <NavigationContainer>
        <Stack.Navigator>
          {user ? (
            <Stack.Group>
              <Stack.Screen name="Home" options={{ title: 'NYFN' }}>
                {({ navigation }) => (
                  <HomeScreen
                    onOpenCourses={() => navigation.navigate('Courses')}
                    onOpenMarketplace={() => navigation.navigate('Marketplace')}
                    onOpenProfile={() => navigation.navigate('Profile')}
                    onOpenOrders={() => navigation.navigate('Orders')}
                    onOpenNotifications={() => navigation.navigate('Notifications')}
                    onOpenLivestock={() => navigation.navigate('Livestock')}
                    onOpenFarms={() => navigation.navigate('Farms')}
                    onOpenAgentQueue={() => navigation.navigate('AgentQueue')}
                  />
                )}
              </Stack.Screen>
              <Stack.Screen name="Courses" options={{ title: 'Courses' }}>
                {({ navigation }) => (
                  <CoursesScreen
                    onOpenCourse={(courseId) => navigation.navigate('CourseDetail', { courseId })}
                  />
                )}
              </Stack.Screen>
              <Stack.Screen name="CourseDetail" options={{ title: 'Course' }}>
                {({ route }) => <CourseDetailScreen courseId={route.params.courseId} />}
              </Stack.Screen>
              <Stack.Screen name="Marketplace" options={{ title: 'Marketplace' }}>
                {({ navigation }) => (
                  <MarketplaceScreen
                    onOpenListing={(listingId) => navigation.navigate('ListingDetail', { listingId })}
                  />
                )}
              </Stack.Screen>
              <Stack.Screen name="ListingDetail" options={{ title: 'Listing' }}>
                {({ route }) => <ListingDetailScreen listingId={route.params.listingId} />}
              </Stack.Screen>
              <Stack.Screen name="Orders" options={{ title: 'My orders' }}>
                {({ navigation }) => (
                  <OrdersScreen onOpenOrder={(orderId) => navigation.navigate('OrderDetail', { orderId })} />
                )}
              </Stack.Screen>
              <Stack.Screen name="OrderDetail" options={{ title: 'Order' }}>
                {({ route }) => <OrderDetailScreen orderId={route.params.orderId} />}
              </Stack.Screen>
              <Stack.Screen name="Notifications" options={{ title: 'Notifications' }}>
                {() => <NotificationsScreen />}
              </Stack.Screen>
              <Stack.Screen name="Livestock" options={{ title: 'My livestock' }}>
                {() => <LivestockScreen />}
              </Stack.Screen>
              <Stack.Screen name="Farms" options={{ title: 'My plots' }}>
                {({ navigation }) => (
                  <FarmsScreen onCapturePlot={() => navigation.navigate('PlotCapture')} />
                )}
              </Stack.Screen>
              <Stack.Screen name="PlotCapture" options={{ title: 'Capture plot' }}>
                {({ navigation }) => (
                  // Plot writes go through the shared record-level sync
                  // outbox (W-SYNCWRITE) — the SyncProvider store below.
                  <PlotCaptureScreen
                    locationService={locationService}
                    onSaved={() => navigation.goBack()}
                  />
                )}
              </Stack.Screen>
              <Stack.Screen name="AgentQueue" options={{ title: 'My field queue' }}>
                {() => <AgentQueueScreen queue={offlineQueue} />}
              </Stack.Screen>
              <Stack.Screen name="Profile" options={{ title: 'Profile' }}>
                {() => <ProfileScreen tokenStore={tokenStore} onSignedOut={() => setUser(null)} />}
              </Stack.Screen>
            </Stack.Group>
          ) : (
            <Stack.Group>
              <Stack.Screen name="Login" options={{ title: 'Sign in' }}>
                {() => <LoginScreen tokenStore={tokenStore} onLoggedIn={setUser} />}
              </Stack.Screen>
            </Stack.Group>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <ErrorBoundary onReset={resetAll}>
      <SafeAreaProvider>
        <ApiProvider client={client}>
          {/* One shared record-level sync store, persisted to AsyncStorage
              so cursors/outbox/conflict-log survive restarts (P0-4). */}
          <SyncProvider storage={AsyncStorage}>
            <ConnectivityWiring />
            {content}
          </SyncProvider>
        </ApiProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  gate: {
    flex: 1,
    padding: 24,
    gap: 12,
    alignItems: 'flex-start',
    justifyContent: 'center',
    backgroundColor: '#f7f7f5'
  },
  gateTitle: { fontSize: 20, fontWeight: '800', color: '#1b5e20' }
});
