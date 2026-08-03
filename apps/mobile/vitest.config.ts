import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Tests run under vitest with react-test-renderer (NOT jest-expo — see
 * README.md for the rationale). `react-native` is aliased to a lightweight
 * manual mock so screens render in plain Node without the Metro transform.
 * react + react-test-renderer are pinned to the same version so components
 * and the renderer share one React instance.
 *
 * Native Expo/community modules (secure store, location, AsyncStorage,
 * NetInfo, safe-area, expo-constants) and React Navigation are aliased to
 * configurable in-memory mocks so App.tsx itself can be mounted in tests.
 */
const mock = (name: string) =>
  fileURLToPath(new URL(`./test/mocks/${name}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: 'react-native', replacement: mock('react-native.tsx') },
      { find: 'expo-constants', replacement: mock('expo-constants.ts') },
      { find: 'expo-secure-store', replacement: mock('expo-secure-store.ts') },
      { find: 'expo-location', replacement: mock('expo-location.ts') },
      {
        find: '@react-native-async-storage/async-storage',
        replacement: mock('async-storage.ts')
      },
      { find: '@react-native-community/netinfo', replacement: mock('netinfo.ts') },
      { find: 'react-native-safe-area-context', replacement: mock('safe-area-context.tsx') },
      { find: '@react-navigation/native-stack', replacement: mock('react-navigation-native-stack.ts') },
      { find: '@react-navigation/native', replacement: mock('react-navigation.tsx') }
    ]
  },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}']
  }
});
