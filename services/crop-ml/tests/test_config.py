import unittest

from app.config import ConfigError, Settings, load_settings, validate_settings


class TestConfig(unittest.TestCase):
    def test_defaults_to_stub(self):
        settings = load_settings({})
        self.assertEqual(settings.imagery_provider, "stub")
        self.assertEqual(settings.http_timeout_seconds, 5.0)
        self.assertEqual(settings.http_retries, 2)
        self.assertEqual(settings.circuit_fail_threshold, 5)
        self.assertEqual(settings.circuit_open_seconds, 60.0)

    def test_unknown_provider_rejected(self):
        with self.assertRaises(ConfigError):
            load_settings({"IMAGERY_PROVIDER": "magic"})

    def test_live_without_url_fails_validation(self):
        settings = load_settings({"IMAGERY_PROVIDER": "live", "SENTINEL_STATS_TOKEN": "t"})
        self.assertFalse(settings.live_configured)
        with self.assertRaises(ConfigError):
            validate_settings(settings)

    def test_live_fully_configured_passes(self):
        settings = load_settings(
            {
                "IMAGERY_PROVIDER": "live",
                "SENTINEL_STATS_URL": "https://stats.example.test",
                "SENTINEL_STATS_TOKEN": "t",
            }
        )
        self.assertTrue(settings.live_configured)
        validate_settings(settings)  # must not raise

    def test_stub_passes_validation_without_live_config(self):
        validate_settings(Settings())


if __name__ == "__main__":
    unittest.main()
