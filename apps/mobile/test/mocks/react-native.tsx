/**
 * Manual react-native mock for vitest + react-test-renderer.
 *
 * Renders RN primitives as plain host elements ('rn-view', 'rn-text', …) so
 * screen smoke tests run in Node without jest-expo / the Metro transform.
 * Only the surface the shell uses is implemented; behaviour props (onPress,
 * onChangeText, renderItem) pass through untouched.
 */
import type { ReactNode } from 'react';

type AnyProps = Record<string, unknown> & { children?: ReactNode };

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'rn-view': AnyProps;
      'rn-text': AnyProps;
      'rn-scroll-view': AnyProps;
      'rn-activity-indicator': AnyProps;
      'rn-pressable': AnyProps;
      'rn-text-input': AnyProps;
      'rn-flat-list': AnyProps;
      'rn-flatlist-item': AnyProps;
    }
  }
}

export function View(props: AnyProps) {
  return <rn-view {...props} />;
}

export function Text(props: AnyProps) {
  return <rn-text {...props} />;
}

export function ScrollView(props: AnyProps) {
  return <rn-scroll-view {...props} />;
}

export function ActivityIndicator(props: AnyProps) {
  return <rn-activity-indicator {...props} />;
}

export function Pressable(props: AnyProps) {
  return <rn-pressable {...props} />;
}

export function TextInput(props: AnyProps) {
  return <rn-text-input {...props} />;
}

interface FlatListProps<T> {
  data: T[];
  renderItem: (args: { item: T; index: number }) => ReactNode;
  keyExtractor?: (item: T, index: number) => string;
  ListEmptyComponent?: ReactNode;
  contentContainerStyle?: unknown;
}

export function FlatList<T>({ data, renderItem, keyExtractor, ListEmptyComponent }: FlatListProps<T>) {
  if (data.length === 0) {
    return <rn-flat-list>{ListEmptyComponent ?? null}</rn-flat-list>;
  }
  return (
    <rn-flat-list>
      {data.map((item, index) => (
        <rn-flatlist-item key={keyExtractor ? keyExtractor(item, index) : String(index)}>
          {renderItem({ item, index })}
        </rn-flatlist-item>
      ))}
    </rn-flat-list>
  );
}

export const StyleSheet = {
  create<T extends Record<string, unknown>>(styles: T): T {
    return styles;
  }
};

export function useColorScheme(): 'light' | 'dark' {
  return 'light';
}
