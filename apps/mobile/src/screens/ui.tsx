import type { PropsWithChildren, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Mobile UI kit v2 (Wave UIUX).
 *
 * Tokens mirror the web design system in apps/web/app/globals.css — same
 * warm, low-saturation NYFN palette (field greens / sand / earth / clay),
 * same 4/8pt spacing rhythm, same 44pt minimum touch targets. Keep both
 * files in sync when tokens change; see docs/design-system.md.
 *
 * Existing exports (Card, CardTitle, Muted, Loading, ErrorNotice,
 * PrimaryButton, styles) stay backward compatible — every screen imports
 * them today.
 */

export const tokens = {
  colors: {
    green950: '#17251b',
    green900: '#1f3d2b',
    green800: '#274a34',
    green700: '#2f5d3f',
    green600: '#3c6f4d',
    green200: '#b9c8a4',
    green100: '#dde5d2',
    sand50: '#fbfaf6',
    sand100: '#f6f3ec',
    sand200: '#ece5d2',
    sand300: '#ddd2b8',
    earth600: '#6e5535',
    clay600: '#a35f3c',
    amber500: '#c99a3f',
    red600: '#a34a3c',
    ink: '#22301f',
    inkSoft: '#43503f',
    inkMute: '#5f6b58',
    line: '#d9d2bf',
    card: '#fffef9'
  },
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64 },
  radius: { s: 8, m: 14, l: 22, full: 999 },
  type: { xs: 12, sm: 13, base: 15, lg: 17, xl: 21, '2xl': 28 },
  /** Minimum interactive target (WCAG 2.5.5 / Apple HIG). */
  targetMin: 44
} as const;

export type Tone = 'success' | 'warning' | 'critical' | 'info' | 'neutral';

const toneStyles: Record<Tone, { backgroundColor: string; borderColor: string; color: string }> = {
  success: { backgroundColor: tokens.colors.green100, borderColor: tokens.colors.green200, color: tokens.colors.green800 },
  warning: { backgroundColor: '#f3ead2', borderColor: '#e2d3ab', color: '#7a5c1e' },
  critical: { backgroundColor: '#f3ded8', borderColor: '#e0bfb4', color: '#8d3f30' },
  info: { backgroundColor: tokens.colors.sand200, borderColor: tokens.colors.sand300, color: tokens.colors.earth600 },
  neutral: { backgroundColor: tokens.colors.sand100, borderColor: tokens.colors.line, color: tokens.colors.inkMute }
};

/* --------------------------- v1 primitives ------------------------------ */

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
      <ActivityIndicator color={tokens.colors.green700} />
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

/* --------------------------- v2 primitives ------------------------------ */

/**
 * SectionCard: titled section container with an optional kicker and a
 * trailing action (e.g. "See all"). The innovation screens plug their
 * content into this instead of inventing per-screen card chrome.
 */
export function SectionCard({
  kicker,
  title,
  action,
  children
}: PropsWithChildren<{
  kicker?: string;
  title: string;
  action?: ReactNode;
}>) {
  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionHead}>
        <View style={styles.sectionHeadText}>
          {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
          <Text style={styles.sectionTitle}>{title}</Text>
        </View>
        {action ? <View style={styles.sectionAction}>{action}</View> : null}
      </View>
      {children}
    </View>
  );
}

/** StatusPill: mirrors the web .badge — dot + label, tone-driven. */
export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  const colors = toneStyles[tone];
  return (
    <View
      style={[styles.pill, { backgroundColor: colors.backgroundColor, borderColor: colors.borderColor }]}
      accessibilityRole="text"
      accessibilityLabel={label}
    >
      <View style={[styles.pillDot, { backgroundColor: colors.color }]} />
      <Text style={[styles.pillLabel, { color: colors.color }]}>{label}</Text>
    </View>
  );
}

/**
 * EmptyState: honest "nothing here / not set up" placeholder with an
 * optional action. Matches the web .empty pattern.
 */
export function EmptyState({
  title,
  hint,
  actionLabel,
  onAction
}: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.empty}>
      {/* CSS-shape glyph: warm tinted tile with a leaf mark (no image assets). */}
      <View style={styles.emptyGlyph} accessibilityElementsHidden importantForAccessibility="no">
        <View style={styles.emptyGlyphMark} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
      {actionLabel && onAction ? (
        <View style={styles.emptyAction}>
          <PrimaryButton label={actionLabel} onPress={onAction} />
        </View>
      ) : null}
    </View>
  );
}

/** MetricTile: big number + label (+ optional trend), tabular feel. */
export function MetricTile({
  value,
  label,
  trend,
  trendDown
}: {
  value: string | number;
  label: string;
  trend?: string;
  trendDown?: boolean;
}) {
  return (
    <View style={styles.metricTile}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
      {trend ? (
        <Text style={[styles.metricTrend, trendDown ? styles.metricTrendDown : null]}>
          {trendDown ? '▼' : '▲'} {trend}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * FormField: label + control + hint/error wrapper. The error replaces the
 * hint and is announced politely; low-literacy rule — hints say what to do,
 * errors say how to fix.
 */
export function FormField({
  label,
  hint,
  error,
  children
}: PropsWithChildren<{
  label: string;
  hint?: string;
  error?: string;
}>) {
  return (
    <View style={styles.formField}>
      <Text style={styles.formLabel}>{label}</Text>
      {children}
      {error ? (
        <Text style={styles.formError} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text style={styles.formHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

/**
 * ListItem: tappable row with title, optional subtitle and a chevron.
 * 44pt+ touch target; the whole row is the hit area.
 */
export function ListItem({
  title,
  subtitle,
  onPress,
  right,
  style
}: {
  title: string;
  subtitle?: string;
  onPress?: () => void;
  /** Overrides the chevron (e.g. a StatusPill). */
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const trailing = right ?? (onPress ? <Text style={styles.chevron}>›</Text> : null);
  const inner = (
    <>
      <View style={styles.listItemText}>
        <Text style={styles.listItemTitle}>{title}</Text>
        {subtitle ? <Text style={styles.listItemSubtitle}>{subtitle}</Text> : null}
      </View>
      {trailing}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        onPress={onPress}
        style={[styles.listItem, style]}
      >
        {inner}
      </Pressable>
    );
  }
  return <View style={[styles.listItem, style]}>{inner}</View>;
}

/* -------------------------------- styles -------------------------------- */

export const styles = StyleSheet.create({
  card: {
    backgroundColor: tokens.colors.card,
    borderRadius: tokens.radius.m,
    padding: tokens.spacing[4],
    marginBottom: tokens.spacing[3],
    borderWidth: 1,
    borderColor: tokens.colors.line
  },
  cardTitle: { fontSize: tokens.type.lg, fontWeight: '700', marginBottom: 4, color: tokens.colors.green950 },
  muted: { fontSize: tokens.type.sm, color: tokens.colors.inkMute },
  center: { alignItems: 'center', padding: tokens.spacing[5] },
  notice: { padding: tokens.spacing[4], backgroundColor: '#faf3df', borderRadius: tokens.radius.m, marginBottom: tokens.spacing[3], borderWidth: 1, borderColor: tokens.colors.amber500 },
  noticeText: { color: '#6b531f', marginBottom: tokens.spacing[2] },
  button: {
    backgroundColor: tokens.colors.green700,
    borderRadius: tokens.radius.s,
    paddingVertical: 10,
    paddingHorizontal: tokens.spacing[4],
    minHeight: tokens.targetMin,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'flex-start'
  },
  buttonDisabled: { backgroundColor: tokens.colors.sand300 },
  buttonLabel: { color: '#ffffff', fontWeight: '600' },

  /* v2 */
  sectionCard: {
    backgroundColor: tokens.colors.card,
    borderRadius: tokens.radius.m,
    padding: tokens.spacing[4],
    marginBottom: tokens.spacing[3],
    borderWidth: 1,
    borderColor: tokens.colors.line
  },
  sectionHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: tokens.spacing[2] },
  sectionHeadText: { flex: 1 },
  sectionAction: { marginLeft: tokens.spacing[3], justifyContent: 'center' },
  kicker: {
    fontSize: tokens.type.xs,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: tokens.colors.earth600,
    marginBottom: 2
  },
  sectionTitle: { fontSize: tokens.type.lg, fontWeight: '700', color: tokens.colors.green950 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: tokens.radius.full,
    borderWidth: 1
  },
  pillDot: { width: 7, height: 7, borderRadius: 4 },
  pillLabel: { fontSize: tokens.type.xs, fontWeight: '600' },
  empty: {
    alignItems: 'center',
    padding: tokens.spacing[5],
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: tokens.colors.line,
    borderRadius: tokens.radius.m,
    backgroundColor: tokens.colors.sand50
  },
  emptyGlyph: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: tokens.colors.green100,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: tokens.spacing[3]
  },
  emptyGlyphMark: {
    width: 20,
    height: 20,
    backgroundColor: tokens.colors.green600,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 3,
    borderBottomLeftRadius: 3,
    borderBottomRightRadius: 12
  },
  emptyTitle: { fontSize: tokens.type.base, fontWeight: '700', color: tokens.colors.green950, textAlign: 'center' },
  emptyHint: { fontSize: tokens.type.sm, color: tokens.colors.inkMute, textAlign: 'center', marginTop: 4 },
  emptyAction: { marginTop: tokens.spacing[3] },
  metricTile: {
    backgroundColor: tokens.colors.card,
    borderRadius: tokens.radius.m,
    padding: tokens.spacing[4],
    borderWidth: 1,
    borderColor: tokens.colors.line,
    flexGrow: 1,
    flexBasis: 100
  },
  metricValue: { fontSize: tokens.type['2xl'], fontWeight: '800', color: tokens.colors.green900 },
  metricLabel: { fontSize: tokens.type.sm, color: tokens.colors.inkMute, marginTop: 2 },
  metricTrend: { fontSize: tokens.type.xs, fontWeight: '700', color: tokens.colors.green700, marginTop: 4 },
  metricTrendDown: { color: tokens.colors.clay600 },
  formField: { marginBottom: tokens.spacing[3] },
  formLabel: { fontSize: tokens.type.sm, fontWeight: '600', color: tokens.colors.green950, marginBottom: 4 },
  formHint: { fontSize: tokens.type.xs, color: tokens.colors.inkMute, marginTop: 4 },
  formError: { fontSize: tokens.type.xs, color: tokens.colors.red600, marginTop: 4 },
  listItem: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: tokens.spacing[2],
    paddingHorizontal: tokens.spacing[3],
    backgroundColor: tokens.colors.card,
    borderRadius: tokens.radius.s,
    borderWidth: 1,
    borderColor: tokens.colors.line,
    marginBottom: tokens.spacing[2]
  },
  listItemText: { flex: 1 },
  listItemTitle: { fontSize: tokens.type.base, fontWeight: '600', color: tokens.colors.green950 },
  listItemSubtitle: { fontSize: tokens.type.sm, color: tokens.colors.inkMute, marginTop: 1 },
  chevron: { fontSize: 22, color: tokens.colors.inkMute, marginLeft: tokens.spacing[2] }
});
