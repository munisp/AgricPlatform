import { useMemo, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createApiClient } from './src/api/client';
import { ApiProvider } from './src/api/context';
import { createInMemoryTokenStore, type TokenStore } from './src/api/token-store';
import { API_BASE_URL } from './src/config';
import type { User } from './src/api/types';
import { AgentQueueScreen } from './src/screens/AgentQueueScreen';
import { CourseDetailScreen } from './src/screens/CourseDetailScreen';
import { CoursesScreen } from './src/screens/CoursesScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { ListingDetailScreen } from './src/screens/ListingDetailScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { MarketplaceScreen } from './src/screens/MarketplaceScreen';
import { LivestockScreen } from './src/screens/LivestockScreen';
import { NotificationsScreen } from './src/screens/NotificationsScreen';
import { OrderDetailScreen } from './src/screens/OrderDetailScreen';
import { OrdersScreen } from './src/screens/OrdersScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';

/**
 * NYFN mobile shell. React Navigation native-stack: Login → Home (dashboard)
 * → Courses / Course detail / Marketplace / Listing detail / Orders /
 * Order detail / Notifications / Livestock / Profile.
 *
 * NOTE (offline-first): the ApiClient uses the in-memory TokenStore fallback
 * until the expo-secure-store adapter lands; queued mutations live in
 * src/offline/queue.ts and flush through the same client.
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
  AgentQueue: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

// Module-scope store instance: swapped for the expo-secure-store adapter in
// a later wave without touching the screens.
const tokenStore: TokenStore = createInMemoryTokenStore();

export default function App() {
  const client = useMemo(() => createApiClient({ baseUrl: API_BASE_URL, tokenStore }), []);
  const [user, setUser] = useState<User | null>(null);

  return (
    <ApiProvider client={client}>
      <NavigationContainer>
        <Stack.Navigator initialRouteName={user ? 'Home' : 'Login'}>
          <Stack.Screen name="Login" options={{ title: 'Sign in' }}>
            {() => <LoginScreen tokenStore={tokenStore} onLoggedIn={setUser} />}
          </Stack.Screen>
          <Stack.Screen name="Home" options={{ title: 'NYFN' }}>
            {({ navigation }) => (
              <HomeScreen
                onOpenCourses={() => navigation.navigate('Courses')}
                onOpenMarketplace={() => navigation.navigate('Marketplace')}
                onOpenProfile={() => navigation.navigate('Profile')}
                onOpenOrders={() => navigation.navigate('Orders')}
                onOpenNotifications={() => navigation.navigate('Notifications')}
                onOpenLivestock={() => navigation.navigate('Livestock')}
                onOpenAgentQueue={() => navigation.navigate('AgentQueue')}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="Courses" options={{ title: 'Courses' }}>
            {({ navigation }) => (
              <CoursesScreen onOpenCourse={(courseId) => navigation.navigate('CourseDetail', { courseId })} />
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
          <Stack.Screen name="AgentQueue" options={{ title: 'My field queue' }}>
            {() => <AgentQueueScreen />}
          </Stack.Screen>
          <Stack.Screen name="Profile" options={{ title: 'Profile' }}>
            {() => <ProfileScreen tokenStore={tokenStore} onSignedOut={() => setUser(null)} />}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    </ApiProvider>
  );
}
