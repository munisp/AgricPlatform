import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput
} from 'react-native';
import { useApiClient } from '../api/context';
import { registerAccount, verifyOtp } from '../api/endpoints';
import type { TokenStore } from '../api/token-store';
import {
  SELF_REGISTRATION_ROLES,
  type PreferredLanguage,
  type SelfRegistrationRole,
  type User
} from '../api/types';
import { ErrorNotice, Muted, PrimaryButton } from './ui';

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

const LANGUAGES: { code: PreferredLanguage; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'ha', label: 'Hausa' },
  { code: 'yo', label: 'Yorùbá' },
  { code: 'ig', label: 'Igbo' }
];

const ROLE_LABELS: Record<SelfRegistrationRole, string> = {
  farmer: 'Farmer',
  student: 'Student',
  buyer: 'Buyer',
  supplier: 'Supplier'
};

/**
 * Self-service registration (OB-18). Posts to POST /auth/register, which
 * (per the OB-01 contract) creates an UNVERIFIED account and returns
 * `{ user, otpRequestId }` — no session tokens. Step 2 then verifies the
 * SMS code against that otpRequestId via the shared /auth/otp/verify
 * endpoint, and only then is a session stored.
 *
 * The role picker is limited to SELF_REGISTRATION_ROLES (mirror of
 * packages/shared/src/domain.ts): privileged roles are admin-granted only
 * and the API rejects them at submit.
 */
export function RegisterScreen({
  tokenStore,
  onRegistered
}: {
  tokenStore: TokenStore;
  onRegistered: (user: User) => void;
}) {
  const client = useApiClient();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<SelfRegistrationRole>('farmer');
  const [language, setLanguage] = useState<PreferredLanguage>('en');
  const [code, setCode] = useState('');
  const [otpRequestId, setOtpRequestId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formValid = fullName.trim().length > 0 && E164_PATTERN.test(phone.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await registerAccount(client, {
        phone: phone.trim(),
        fullName: fullName.trim(),
        roles: [role],
        preferredLanguage: language
      });
      // OB-01: no tokens here — drive the user into OTP verification with
      // the returned challenge id.
      setOtpRequestId(res.data.otpRequestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!otpRequestId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await verifyOtp(client, otpRequestId, code.trim());
      await tokenStore.setSession({
        token: res.data.token,
        refreshToken: res.data.refreshToken
      });
      onRegistered(res.data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Create your account</Text>

        {otpRequestId ? (
          <>
            <Muted>
              We sent a one-time code to {phone.trim()}. Enter it below to verify your number and
              sign in.
            </Muted>
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
          <>
            <Text style={styles.label}>Full name</Text>
            <TextInput
              accessibilityLabel="Full name"
              placeholder="e.g. Adamu Garba"
              value={fullName}
              onChangeText={setFullName}
              style={styles.input}
              editable={!busy}
            />
            <Text style={styles.label}>Phone number (E.164)</Text>
            <TextInput
              accessibilityLabel="Phone number"
              keyboardType="phone-pad"
              placeholder="+2348012345678"
              value={phone}
              onChangeText={setPhone}
              style={styles.input}
              editable={!busy}
            />
            <Text style={styles.label}>I am a…</Text>
            <ScrollView horizontal style={styles.chipRow} keyboardShouldPersistTaps="handled">
              {SELF_REGISTRATION_ROLES.map((option) => (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: role === option }}
                  onPress={() => setRole(option)}
                  style={[styles.chip, role === option ? styles.chipSelected : undefined]}
                >
                  <Text style={role === option ? styles.chipTextSelected : styles.chipText}>
                    {ROLE_LABELS[option]}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.label}>Preferred language</Text>
            <ScrollView horizontal style={styles.chipRow} keyboardShouldPersistTaps="handled">
              {LANGUAGES.map((option) => (
                <Pressable
                  key={option.code}
                  accessibilityRole="button"
                  accessibilityState={{ selected: language === option.code }}
                  onPress={() => setLanguage(option.code)}
                  style={[styles.chip, language === option.code ? styles.chipSelected : undefined]}
                >
                  <Text
                    style={language === option.code ? styles.chipTextSelected : styles.chipText}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <PrimaryButton
              label={busy ? 'Registering…' : 'Register'}
              onPress={() => void submit()}
              disabled={busy || !formValid}
            />
          </>
        )}

        {error ? <ErrorNotice message={error} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flexGrow: 1, padding: 24, backgroundColor: '#f7f7f5' },
  title: { fontSize: 24, fontWeight: '800', marginBottom: 8, color: '#1b5e20' },
  label: { marginTop: 16, marginBottom: 4, fontWeight: '600' },
  input: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#cfcfcf',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16
  },
  chipRow: { flexGrow: 0, marginBottom: 8 },
  chip: {
    borderWidth: 1,
    borderColor: '#cfcfcf',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 8,
    backgroundColor: '#ffffff',
    minHeight: 44,
    justifyContent: 'center'
  },
  chipSelected: { backgroundColor: '#1b5e20', borderColor: '#1b5e20' },
  chipText: { color: '#22301f', fontWeight: '600' },
  chipTextSelected: { color: '#ffffff', fontWeight: '600' }
});
