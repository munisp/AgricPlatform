import type { PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

/** Small shared primitives so every screen renders English copy consistently. */

export function Card({ children }: PropsWithChildren) {
  return <View style={styles.card}>{children}</View>;
}

export function CardTitle({ children }: PropsWithChildren) {
  return <Text style={styles.cardTitle}>{children}</Text>;
}

export function Muted({ children }: PropsWithChildren) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={styles.center}>
      <ActivityIndicator />
      <Muted>Loading…</Muted>
    </View>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.noticeText}>Something went wrong — {message}</Text>
      {onRetry ? <PrimaryButton label="Retry" onPress={onRetry} /> : null}
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      onPress={disabled ? undefined : onPress}
      style={[styles.button, disabled ? styles.buttonDisabled : null]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4, color: '#1b1b1b' },
  muted: { fontSize: 13, color: '#5f5f5f' },
  center: { alignItems: 'center', padding: 24 },
  notice: { padding: 16, backgroundColor: '#fff4e5', borderRadius: 8, marginBottom: 12 },
  noticeText: { color: '#7a4a00', marginBottom: 8 },
  button: {
    backgroundColor: '#1b5e20',
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: 'center',
    alignSelf: 'flex-start'
  },
  buttonDisabled: { backgroundColor: '#9e9e9e' },
  buttonLabel: { color: '#ffffff', fontWeight: '600' }
});
