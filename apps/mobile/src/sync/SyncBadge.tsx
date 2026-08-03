import { StyleSheet, Text, View } from 'react-native';
import type { SyncStoreStatus } from './store';

/**
 * Honest sync status line: only states the store can prove. Shows the most
 * important truth first — failures and pending work before "synced".
 */
export function SyncBadge({ status }: { status: SyncStoreStatus }) {
  const parts: string[] = [];
  if (status.syncing) {
    parts.push('Syncing…');
  } else {
    if (status.lastError) parts.push('Sync failed — will retry');
    if (status.pending > 0) parts.push(`Pending ${status.pending}`);
    if (status.conflictsResolved > 0) {
      parts.push(`Conflicts resolved ${status.conflictsResolved}`);
    }
    if (!status.lastError && status.pending === 0 && status.lastSyncAt) {
      parts.unshift('Synced');
    }
    if (parts.length === 0) {
      parts.push('Not synced yet');
    }
  }
  return (
    <View style={styles.container} accessibilityRole="text">
      <Text style={[styles.text, status.lastError ? styles.error : null]}>{parts.join(' · ')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 12 },
  text: { fontSize: 12, color: '#5f5f5f' },
  error: { color: '#7a4a00' }
});
