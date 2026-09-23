import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NavigationContext } from '@react-navigation/native';

/**
 * Stale-list fix (audit P1-9): one hook that gives a list screen
 * 1. a load on mount,
 * 2. a reload every time the screen regains focus (e.g. after a
 *    PlotCapture `onSaved` → goBack, the new plot must appear), and
 * 3. a `refreshing` flag + `refresh` callback for a RefreshControl
 *    pull-to-refresh.
 *
 * NavigationContext (not useFocusEffect) is read directly so the hook also
 * works when a screen is rendered WITHOUT a navigation container — unit
 * tests and previews then get the mount-load only.
 *
 * Cancellation: the hook owns one AbortController per mounted lifetime and
 * passes its signal to `load`; on unmount the signal aborts so in-flight
 * GETs are cancelled instead of setState-ing a dead tree.
 */
interface FocusListenerNavigation {
  addListener?: (type: 'focus', callback: () => void) => () => void;
}

export function useListRefresh(load: (signal?: AbortSignal) => Promise<void> | void): {
  refreshing: boolean;
  refresh: () => Promise<void>;
} {
  const navigation = useContext(NavigationContext) as FocusListenerNavigation | undefined;
  const [refreshing, setRefreshing] = useState(false);
  const signalRef = useRef<AbortSignal | undefined>(undefined);

  // Initial load (also covers screens mounted outside a navigator).
  useEffect(() => {
    const controller = new AbortController();
    signalRef.current = controller.signal;
    void load(controller.signal);
    return () => {
      controller.abort();
      signalRef.current = undefined;
    };
  }, [load]);

  // Refetch whenever the screen comes back into focus.
  useEffect(() => {
    if (!navigation || typeof navigation.addListener !== 'function') return undefined;
    return navigation.addListener('focus', () => void load(signalRef.current));
  }, [navigation, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load(signalRef.current);
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return { refreshing, refresh };
}
