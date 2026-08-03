/**
 * Vitest setup: tell React the tests run inside act()-aware renderers so
 * react-test-renderer updates wrapped in act() do not warn (P2-16).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
