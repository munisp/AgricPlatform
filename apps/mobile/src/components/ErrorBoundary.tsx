import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, CardTitle, Muted, PrimaryButton } from '../screens/ui';

/**
 * Root error boundary (audit P1-8): a render crash anywhere in the tree
 * must never white-screen the app. The fallback is an honest recovery UI —
 * it shows what happened, offers "Try again" (re-render the tree), and
 * "Sign out and restart" (drop the local session and reset navigation)
 * for crashes that keep recurring because of corrupt local state.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    /** Optional full reset hook (clears session + returns to Login). */
    onReset?: () => void;
  },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No crash-reporting SDK is wired yet — log so the failure is at least
    // visible in device logs / `adb logcat` during QA.
    console.error('[ErrorBoundary] render crash', error, info.componentStack);
  }

  private tryAgain = () => {
    this.setState({ error: null });
  };

  private reset = () => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ScrollView contentContainerStyle={styles.container}>
        <Card>
          <CardTitle>Something went wrong</CardTitle>
          <Muted>
            The app hit an unexpected error. Your queued offline work is stored on the device and
            is not lost.
          </Muted>
          <View style={styles.detailBox}>
            <Text style={styles.detail}>{error.message}</Text>
          </View>
          <PrimaryButton label="Try again" onPress={this.tryAgain} />
          {this.props.onReset ? (
            <>
              <View style={styles.gap} />
              <PrimaryButton label="Sign out and restart" onPress={this.reset} />
            </>
          ) : null}
        </Card>
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 16, backgroundColor: '#f7f7f5', justifyContent: 'center' },
  detailBox: { marginVertical: 12, padding: 10, backgroundColor: '#f0f0ee', borderRadius: 8 },
  detail: { fontSize: 12, color: '#4a4a4a' },
  gap: { height: 8 }
});
