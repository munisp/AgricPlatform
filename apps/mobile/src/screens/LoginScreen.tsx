import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useApiClient } from '../api/context';
import { requestOtp, verifyOtp } from '../api/endpoints';
import type { TokenStore } from '../api/token-store';
import type { User } from '../api/types';
import { ErrorNotice, PrimaryButton, styles as ui } from './ui';

/**
 * Phone + OTP login against the same /api/v1/auth endpoints the web app uses.
 * Step 1 requests the OTP challenge; step 2 verifies it and stores the
 * session token in the TokenStore (secure-store adapter in production).
 */
export function LoginScreen({
  tokenStore,
  onLoggedIn
}: {
  tokenStore: TokenStore;
  onLoggedIn: (user: User) => void;
}) {
  const client = useApiClient();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneValid = /^\+?\d{7,15}$/.test(phone.trim());

  async function sendCode() {
    setBusy(true);
    setError(null);
    try {
      const res = await requestOtp(client, phone.trim());
      setRequestId(res.data.requestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!requestId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await verifyOtp(client, requestId, code.trim());
      // Wave P sessions: keep both halves — the client rotates the refresh
      // token on a 401 and revokes it on sign-out.
      await tokenStore.setSession({ token: res.data.token, refreshToken: res.data.refreshToken });
      onLoggedIn(res.data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to NYFN</Text>
      <Text style={ui.muted}>Sign in with your phone number. We send a one-time code by SMS.</Text>

      <Text style={styles.label} accessibilityRole="text">
        Phone number
      </Text>
      <TextInput
        accessibilityLabel="Phone number"
        keyboardType="phone-pad"
        placeholder="+2348012345678"
        value={phone}
        onChangeText={setPhone}
        style={styles.input}
        editable={!busy}
      />

      {requestId ? (
        <>
          <Text style={styles.label}>One-time code</Text>
          <TextInput
            accessibilityLabel="One-time code"
            keyboardType="number-pad"
            placeholder="6-digit code"
            value={code}
            onChangeText={setCode}
            style={styles.input}
            editable={!busy}
          />
          <PrimaryButton
            label={busy ? 'Verifying…' : 'Verify and sign in'}
            onPress={() => void verify()}
            disabled={busy || code.trim().length < 4}
          />
        </>
      ) : (
        <PrimaryButton
          label={busy ? 'Sending…' : 'Send code'}
          onPress={() => void sendCode()}
          disabled={busy || !phoneValid}
        />
      )}

      {error ? <ErrorNotice message={error} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, backgroundColor: '#f7f7f5' },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 8, color: '#1b5e20' },
  label: { marginTop: 16, marginBottom: 4, fontWeight: '600' },
  input: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cfcfcf',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16
  }
});
