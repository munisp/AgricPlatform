/** Root error boundary tests (audit P1-8): never a white screen. */
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { Text } from 'react-native';

function flattenText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return flattenText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

function screenText(root: ReactTestInstance): string {
  return root
    .findAllByType('rn-text' as never)
    .map((node) => flattenText((node as { props: { children?: unknown } }).props.children))
    .join('\n');
}

function pressByLabel(root: ReactTestInstance, label: string): void {
  const target = root
    .findAllByType('rn-pressable' as never)
    .find((node) => flattenText(node).includes(label));
  if (!target) throw new Error(`No pressable labelled "${label}"`);
  (target.props as { onPress?: () => void }).onPress?.();
}

let shouldThrow = false;
function MaybeCrashing() {
  if (shouldThrow) throw new Error('boom: corrupt render');
  return <Text>healthy tree</Text>;
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', async () => {
    shouldThrow = false;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ErrorBoundary>
          <MaybeCrashing />
        </ErrorBoundary>
      );
    });
    expect(screenText(renderer!.root)).toContain('healthy tree');
  });

  it('shows the recovery UI (with the error message) instead of a white screen', async () => {
    shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ErrorBoundary>
          <MaybeCrashing />
        </ErrorBoundary>
      );
    });
    const text = screenText(renderer!.root);
    expect(text).toContain('Something went wrong');
    expect(text).toContain('boom: corrupt render');
    expect(text).toContain('Try again');
    vi.restoreAllMocks();
  });

  it('Try again re-renders the tree once the fault is gone', async () => {
    shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ErrorBoundary>
          <MaybeCrashing />
        </ErrorBoundary>
      );
    });
    expect(screenText(renderer!.root)).toContain('Something went wrong');

    shouldThrow = false;
    await act(async () => {
      pressByLabel(renderer!.root, 'Try again');
    });
    expect(screenText(renderer!.root)).toContain('healthy tree');
    vi.restoreAllMocks();
  });

  it('Sign out and restart invokes the reset hook (session/nav reset)', async () => {
    shouldThrow = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let resets = 0;
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <ErrorBoundary onReset={() => (resets += 1)}>
          <MaybeCrashing />
        </ErrorBoundary>
      );
    });
    await act(async () => {
      pressByLabel(renderer!.root, 'Sign out and restart');
    });
    expect(resets).toBe(1);
    shouldThrow = false;
    vi.restoreAllMocks();
  });
});
