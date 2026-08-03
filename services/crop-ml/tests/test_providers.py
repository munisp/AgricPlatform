import unittest
from unittest import mock

import httpx

from app.config import Settings
from app.providers.base import ImageryProviderError
from app.providers.live import LiveImageryProvider
from app.providers.stub import StubImageryProvider, stable_seed


def live_settings(**overrides):
    base = dict(
        imagery_provider="live",
        sentinel_stats_url="https://stats.example.test",
        sentinel_stats_token="token-123",
        http_timeout_seconds=5.0,
        http_retries=1,
        circuit_fail_threshold=5,
        circuit_open_seconds=60.0,
    )
    base.update(overrides)
    return Settings(**base)


class TestStubProvider(unittest.TestCase):
    def test_deterministic_per_plot_and_season(self):
        provider = StubImageryProvider()
        a = provider.fetch_series("plot-1", "2024")
        b = provider.fetch_series("plot-1", "2024")
        self.assertEqual([s.model_dump() for s in a], [s.model_dump() for s in b])

    def test_seed_not_salted(self):
        # sha256-based seed must be stable across processes (unlike hash()).
        self.assertEqual(stable_seed("plot-1", "2024"), stable_seed("plot-1", "2024"))
        self.assertIsInstance(stable_seed("plot-1", "2024"), int)

    def test_different_plots_differ(self):
        provider = StubImageryProvider()
        a = provider.fetch_series("plot-1", "2024")
        b = provider.fetch_series("plot-2", "2024")
        self.assertNotEqual([s.model_dump() for s in a], [s.model_dump() for s in b])

    def test_series_is_long_enough_for_phenology(self):
        provider = StubImageryProvider()
        series = provider.fetch_series("plot-1", "2024")
        self.assertGreaterEqual(len(series), 6)
        dates = [s.date for s in series]
        self.assertEqual(dates, sorted(dates))

    def test_dry_season_starts_in_october(self):
        provider = StubImageryProvider()
        series = provider.fetch_series("plot-1", "2024-dry")
        self.assertEqual(series[0].date.month, 10)


class TestLiveProviderFailClosed(unittest.TestCase):
    def _provider(self, client_factory, settings=None, clock=None):
        kwargs = {}
        if clock is not None:
            kwargs["clock"] = clock
        return LiveImageryProvider(settings or live_settings(), client_factory, **kwargs)

    def test_transport_error_raises_and_never_falls_back(self):
        factory = mock.Mock()
        factory.return_value.post.side_effect = httpx.ConnectError("boom")
        provider = self._provider(factory)
        with self.assertRaises(ImageryProviderError) as ctx:
            provider.fetch_series("plot-1", "2024")
        self.assertEqual(ctx.exception.code, "IMAGERY_PROVIDER_UNAVAILABLE")
        # 1 attempt + 1 retry
        self.assertEqual(factory.return_value.post.call_count, 2)

    def test_circuit_opens_after_threshold_and_fails_fast(self):
        factory = mock.Mock()
        factory.return_value.post.side_effect = httpx.ConnectError("boom")
        now = [1000.0]
        provider = self._provider(
            factory,
            settings=live_settings(http_retries=0, circuit_fail_threshold=5),
            clock=lambda: now[0],
        )
        for _ in range(5):
            with self.assertRaises(ImageryProviderError):
                provider.fetch_series("plot-1", "2024")
        self.assertEqual(provider.circuit_state(), "open")
        calls_before = factory.return_value.post.call_count
        with self.assertRaises(ImageryProviderError) as ctx:
            provider.fetch_series("plot-1", "2024")
        self.assertEqual(ctx.exception.code, "IMAGERY_CIRCUIT_OPEN")
        # fail-fast: no further upstream call while the breaker is open
        self.assertEqual(factory.return_value.post.call_count, calls_before)

    def test_circuit_closes_after_cooldown_on_success(self):
        factory = mock.Mock()
        post = factory.return_value.post
        post.side_effect = httpx.ConnectError("boom")
        now = [1000.0]
        provider = self._provider(
            factory,
            settings=live_settings(http_retries=0, circuit_fail_threshold=2),
            clock=lambda: now[0],
        )
        for _ in range(2):
            with self.assertRaises(ImageryProviderError):
                provider.fetch_series("plot-1", "2024")
        self.assertEqual(provider.circuit_state(), "open")
        now[0] += 61.0  # cooldown elapsed -> trial call allowed
        post.side_effect = None
        post.return_value = mock.Mock(
            status_code=200,
            json=lambda: {
                "series": [
                    {"date": "2024-03-01", "red": 0.2, "nir": 0.5},
                    {"date": "2024-03-06", "red": 0.2, "nir": 0.5},
                ]
            },
        )
        series = provider.fetch_series("plot-1", "2024")
        self.assertEqual(len(series), 2)
        self.assertEqual(provider.circuit_state(), "closed")

    def test_success_path_parses_series(self):
        factory = mock.Mock()
        factory.return_value.post.return_value = mock.Mock(
            status_code=200,
            json=lambda: {
                "series": [
                    {"date": "2024-03-01", "red": 0.20, "nir": 0.50},
                    {"date": "2024-03-06", "red": 0.18, "nir": 0.52},
                ]
            },
        )
        provider = self._provider(factory)
        series = provider.fetch_series("plot-1", "2024")
        self.assertEqual(series[0].red, 0.20)
        _, kwargs = factory.call_args
        self.assertEqual(kwargs["base_url"], "https://stats.example.test")
        self.assertIn("Bearer token-123", kwargs["headers"]["Authorization"])

    def test_missing_config_raises(self):
        with self.assertRaises(ImageryProviderError):
            LiveImageryProvider(
                Settings(imagery_provider="live"), mock.Mock()
            )


if __name__ == "__main__":
    unittest.main()
