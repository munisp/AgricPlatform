import unittest
from unittest import mock

import httpx
from fastapi.testclient import TestClient

from app.config import ConfigError, Settings
from app.main import create_app
from app.providers.live import LiveImageryProvider
from tests.helpers import reference_curve, synthetic_curve


def series_payload(samples):
    return [
        {"date": s.date.isoformat(), "red": s.red, "nir": s.nir} for s in samples
    ]


class TestSeasonalityApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app(settings=Settings()))

    def test_contract_happy_path(self):
        resp = self.client.post(
            "/v1/crop/seasonality",
            json={
                "plot_id": "plot-1",
                "series": series_payload(synthetic_curve()),
                "reference": series_payload(reference_curve()),
            },
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["plot_id"], "plot-1")
        self.assertEqual(body["acquisitions"], 40)
        self.assertEqual(len(body["ndvi"]), 40)
        for key in ("sos_date", "eos_date", "peak_date", "peak_value", "amplitude"):
            self.assertIn(key, body["phenology"])
        self.assertIn(body["classification"]["label"], ("normal", "delayed", "stressed"))

    def test_short_series_rejected_422(self):
        resp = self.client.post(
            "/v1/crop/seasonality",
            json={"plot_id": "plot-1", "series": series_payload(synthetic_curve(n=5))},
        )
        self.assertEqual(resp.status_code, 422)

    def test_negative_reflectance_rejected_422(self):
        payload = series_payload(synthetic_curve(n=6))
        payload[0]["red"] = -0.1
        resp = self.client.post(
            "/v1/crop/seasonality", json={"plot_id": "plot-1", "series": payload}
        )
        self.assertEqual(resp.status_code, 422)

    def test_duplicate_dates_rejected_422(self):
        payload = series_payload(synthetic_curve(n=6))
        payload[1]["date"] = payload[0]["date"]
        resp = self.client.post(
            "/v1/crop/seasonality", json={"plot_id": "plot-1", "series": payload}
        )
        self.assertEqual(resp.status_code, 422)

    def test_missing_field_rejected_422(self):
        resp = self.client.post("/v1/crop/seasonality", json={"plot_id": "plot-1"})
        self.assertEqual(resp.status_code, 422)

    def test_byte_identical_repeat_response(self):
        payload = {"plot_id": "plot-1", "series": series_payload(synthetic_curve())}
        a = self.client.post("/v1/crop/seasonality", json=payload)
        b = self.client.post("/v1/crop/seasonality", json=payload)
        self.assertEqual(a.status_code, 200)
        self.assertEqual(a.content, b.content)


class TestHealthScoreApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app(settings=Settings()))

    def test_contract_happy_path(self):
        resp = self.client.post(
            "/v1/crop/health-score",
            json={
                "plot_id": "plot-1",
                "current": series_payload(synthetic_curve()),
                "baseline": series_payload(reference_curve()),
            },
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertGreaterEqual(body["score"], 0.0)
        self.assertLessEqual(body["score"], 100.0)
        self.assertIsInstance(body["drivers"], list)

    def test_score_bounds_and_driver_shape(self):
        resp = self.client.post(
            "/v1/crop/health-score",
            json={
                "plot_id": "plot-1",
                "current": series_payload(synthetic_curve(amp=0.30)),
                "baseline": series_payload(reference_curve()),
            },
        )
        body = resp.json()
        self.assertLess(body["score"], 100.0)
        self.assertGreater(len(body["drivers"]), 0)
        for key in ("code", "impact", "detail"):
            self.assertIn(key, body["drivers"][0])


class TestAssessPlotApi(unittest.TestCase):
    def test_stub_mode_end_to_end(self):
        client = TestClient(create_app(settings=Settings()))
        resp = client.post(
            "/v1/crop/assess-plot",
            json={"plot_id": "plot-9", "season": "2024"},
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["provider"], "stub")
        self.assertEqual(body["season"], "2024")
        self.assertEqual(body["seasonality"]["acquisitions"], 45)
        self.assertGreaterEqual(body["health"]["score"], 0.0)

    def test_stub_assess_is_byte_identical(self):
        client = TestClient(create_app(settings=Settings()))
        payload = {"plot_id": "plot-9", "season": "2024"}
        a = client.post("/v1/crop/assess-plot", json=payload)
        b = client.post("/v1/crop/assess-plot", json=payload)
        self.assertEqual(a.content, b.content)

    def test_bad_season_format_rejected_422(self):
        client = TestClient(create_app(settings=Settings()))
        resp = client.post(
            "/v1/crop/assess-plot", json={"plot_id": "p", "season": "summer-24"}
        )
        self.assertEqual(resp.status_code, 422)

    def test_live_mode_fail_closed_503(self):
        factory = mock.Mock()
        factory.return_value.post.side_effect = httpx.ConnectError("down")
        settings = Settings(
            imagery_provider="live",
            sentinel_stats_url="https://stats.example.test",
            sentinel_stats_token="token-123",
            http_retries=0,
        )
        provider = LiveImageryProvider(settings, factory)
        client = TestClient(create_app(settings=settings, provider=provider))
        resp = client.post(
            "/v1/crop/assess-plot", json={"plot_id": "plot-9", "season": "2024"}
        )
        self.assertEqual(resp.status_code, 503)
        detail = resp.json()["detail"]
        self.assertEqual(detail["code"], "IMAGERY_PROVIDER_UNAVAILABLE")

    def test_live_mode_missing_config_raises_at_startup(self):
        with self.assertRaises(ConfigError):
            create_app(settings=Settings(imagery_provider="live"))

    def test_readyz_reports_misconfigured_when_provider_missing(self):
        app = create_app(
            settings=Settings(imagery_provider="live"), validate_config=False
        )
        client = TestClient(app)
        resp = client.get("/readyz")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "misconfigured")
        self.assertEqual(body["provider"]["mode"], "live")
        resp = client.post(
            "/v1/crop/assess-plot", json={"plot_id": "p", "season": "2024"}
        )
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(resp.json()["detail"]["code"], "IMAGERY_MISCONFIGURED")


class TestHealthEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app(settings=Settings()))

    def test_healthz(self):
        resp = self.client.get("/healthz")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "ok")

    def test_readyz_stub_mode(self):
        resp = self.client.get("/readyz")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["provider"]["mode"], "stub")


if __name__ == "__main__":
    unittest.main()
