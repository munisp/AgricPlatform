/**
 * Lightweight mock of @react-navigation/native + native-stack for vitest.
 *
 * It implements just enough navigator semantics to mount App.tsx in Node:
 * - Screens and conditional Stack.Groups are collected from children.
 * - Only the top route is rendered. When the active route unregisters
 *   (e.g. the auth switch removes Login), the stack resets to the first
 *   available screen — mirroring the real navigator's behaviour.
 * - `navigate` pushes, `goBack` pops, `reset` replaces; `focus`/`blur`
 *   listeners fire on transitions so useFocusEffect-style hooks work.
 *
 * This mock deliberately does NOT emulate header/native transitions.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react';

export interface MockRoute {
  name: string;
  params?: Record<string, unknown>;
}

type Listener = () => void;

export const NavigationContext = createContext<unknown>(undefined);
export const NavigationRouteContext = createContext<MockRoute | undefined>(undefined);

interface ScreenDef {
  name: string;
  children?: unknown;
}



function isElement(node: unknown): node is ReactElement<any> {
  return (
    typeof node === 'object' &&
    node !== null &&
    'type' in (node as Record<string, unknown>) &&
    'props' in (node as Record<string, unknown>)
  );
}

export function createNativeStackNavigator() {
  function Screen(_props: any): null {
    return null;
  }
  function Group(_props: any): null {
    return null;
  }

  function collect(children: ReactNode): ScreenDef[] {
    const out: ScreenDef[] = [];
    const walk = (node: ReactNode): void => {
      if (node === null || node === undefined || typeof node === 'boolean') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!isElement(node)) return;
      const props = node.props as { name?: string; children?: ReactNode };
      if (node.type === Group) {
        walk(props.children);
        return;
      }
      if (node.type === Screen && typeof props.name === 'string') {
        out.push({ name: props.name, children: props.children });
      }
    };
    walk(children);
    return out;
  }

  function Navigator({
    initialRouteName,
    children
  }: {
    initialRouteName?: string;
    children?: ReactNode;
  }) {
    const screens = collect(children);
    const namesKey = screens.map((screen) => screen.name).join('|');

    const [stack, setStack] = useState<MockRoute[]>(() => {
      const first =
        initialRouteName && screens.some((screen) => screen.name === initialRouteName)
          ? initialRouteName
          : screens[0]?.name;
      return first ? [{ name: first }] : [];
    });

    const listeners = useRef(new Map<string, Map<string, Set<Listener>>>());
    const emit = (route: string, type: 'focus' | 'blur') => {
      for (const cb of [...(listeners.current.get(route)?.get(type) ?? [])]) cb();
    };

    const top = stack[stack.length - 1];
    const topRegistered = screens.some((screen) => screen.name === top?.name);
    const prevTop = useRef<string | undefined>(undefined);

    // Auth switch / unregistered route: fall back to the first screen.
    useEffect(() => {
      if (!topRegistered && screens.length > 0) {
        setStack([{ name: screens[0].name }]);
      }

    }, [topRegistered, namesKey]);

    // Focus/blur transitions.
    useEffect(() => {
      const current = stack[stack.length - 1]?.name;
      if (prevTop.current === current) return;
      if (prevTop.current) emit(prevTop.current, 'blur');
      if (current) emit(current, 'focus');
      prevTop.current = current;

    }, [stack]);

    const navigation = useMemo(
      () => ({
        navigate(name: string, params?: Record<string, unknown>) {
          setStack((current) => [...current, { name, params }]);
        },
        push(name: string, params?: Record<string, unknown>) {
          setStack((current) => [...current, { name, params }]);
        },
        goBack() {
          setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
        },
        reset(state: { routes: MockRoute[]; index?: number }) {
          setStack(state.routes.map((route) => ({ name: route.name, params: route.params })));
        },
        replace(name: string, params?: Record<string, unknown>) {
          setStack((current) => [...current.slice(0, -1), { name, params }]);
        },
        popTo(name: string, params?: Record<string, unknown>) {
          setStack((current) => {
            const index = current.findIndex((route) => route.name === name);
            if (index < 0) return [...current, { name, params }];
            return current.slice(0, index + 1);
          });
        },
        canGoBack() {
          return stack.length > 1;
        },
        isFocused() {
          return true;
        },
        setOptions() {},
        getParent() {
          return undefined;
        },
        dispatch() {},
        getState() {
          return { routes: stack, index: stack.length - 1, routeNames: screens.map((s) => s.name) };
        },
        addListener(type: 'focus' | 'blur', cb: Listener) {
          const route = stack[stack.length - 1]?.name ?? '';
          let byType = listeners.current.get(route);
          if (!byType) {
            byType = new Map();
            listeners.current.set(route, byType);
          }
          let set = byType.get(type);
          if (!set) {
            set = new Set();
            byType.set(type, set);
          }
          set.add(cb);
          return () => set.delete(cb);
        }
      }),

      [stack, namesKey]
    );

    if (!topRegistered) return null;
    const def = screens.find((screen) => screen.name === top.name);
    if (!def) return null;
    const route = { key: `${top.name}-mock`, name: top.name, params: top.params };

    let content: ReactNode = null;
    if (typeof def.children === 'function') {
      content = (def.children as (props: unknown) => ReactNode)({ navigation, route });
    } else if (isElement(def.children)) {
      content = def.children;
    }

    return (
      <NavigationContext.Provider value={navigation}>
        <NavigationRouteContext.Provider value={route}>{content}</NavigationRouteContext.Provider>
      </NavigationContext.Provider>
    );
  }

  return { Navigator, Screen, Group };
}

export function NavigationContainer({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function useNavigation<T = unknown>(): T {
  const navigation = useContext(NavigationContext);
  if (!navigation) throw new Error('useNavigation used outside a navigator (mock)');
  return navigation as T;
}

export function useRoute<T = unknown>(): T {
  return useContext(NavigationRouteContext) as T;
}

export function useFocusEffect(effect: () => void | (() => void)): void {
  const navigation = useContext(NavigationContext) as
    | { addListener?: (type: 'focus' | 'blur', cb: Listener) => () => void }
    | undefined;
  useEffect(() => {
    effect();
    if (!navigation?.addListener) return;
    return navigation.addListener('focus', () => {
      effect();
    });

  }, [navigation, effect]);
}

export function useIsFocused(): boolean {
  return true;
}
