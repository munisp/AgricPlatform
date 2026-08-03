import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useApiClient } from '../api/context';
import { fetchSession, logoutSession } from '../api/endpoints';
import type { TokenStore } from '../api/token-store';
import type { User } from '../api/types';
import { Card, CardTitle, ErrorNotice, Loading, Muted, PrimaryButton } from './ui';

const LANGUAGE_LABELS: Record<User['preferredLanguage'], string> = {
  en: 'English',
  ha: 'Hausa',
  yo: 'Yoruba',
  ig: 'Igbo'
};

export function ProfileScreen({
  tokenStore,
  onSignedOut
}: {
  tokenStore: TokenStore;
  onSignedOut: () => void;
}) {
  const client = useApiClient();
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetchSession(client);
      setUser(res.data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your profile');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    // Revoke the refresh-token session server-side (best-effort: sign-out
    // must still complete offline), then drop local credentials.
    const refreshToken = await tokenStore.getRefreshToken();
    if (refreshToken) {
      try {
        await logoutSession(client, refreshToken);
      } catch {
        // Offline or already revoked — /auth/logout is idempotent.
      }
    }
    await tokenStore.clear();
    onSignedOut();
  }

  if (error) {
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <ErrorNotice message={error} onRetry={() => void load()} />
      </ScrollView>
    );
  }
  if (!user) {
    return <Loading />;
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Card>
        <CardTitle>{user.fullName}</CardTitle>
        <Muted>{user.phone}</Muted>
        <Muted>Roles: {user.roles.join(', ')}</Muted>
        <Muted>Language: {LANGUAGE_LABELS[user.preferredLanguage] ?? user.preferredLanguage}</Muted>
      </Card>
      <PrimaryButton label="Sign out" onPress={() => void signOut()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, backgroundColor: '#f7f7f5' }
});
