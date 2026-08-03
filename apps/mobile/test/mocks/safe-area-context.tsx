/** Mock of react-native-safe-area-context for vitest: zero insets. */
import { createContext, type ReactNode } from 'react';
import { View } from 'react-native';

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

export const SafeAreaInsetsContext = createContext(ZERO_INSETS);
export const SafeAreaFrameContext = createContext({ x: 0, y: 0, width: 390, height: 844 });
export const initialWindowMetrics = {
  insets: ZERO_INSETS,
  frame: { x: 0, y: 0, width: 390, height: 844 }
};

export function SafeAreaProvider({ children }: { children?: ReactNode }) {
  return (
    <SafeAreaInsetsContext.Provider value={ZERO_INSETS}>
      <View style={{ flex: 1 }}>{children}</View>
    </SafeAreaInsetsContext.Provider>
  );
}

export function SafeAreaView({ children }: { children?: ReactNode }) {
  return <View>{children}</View>;
}

export function useSafeAreaInsets() {
  return ZERO_INSETS;
}

export function useSafeAreaFrame() {
  return { x: 0, y: 0, width: 390, height: 844 };
}
