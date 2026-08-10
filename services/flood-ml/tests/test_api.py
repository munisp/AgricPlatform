"""API contract tests for the flood-ml FastAPI service.

Covers the fail-closed behaviour:
  (a) model-load failure -> /predict returns 503 and never a flood mask
  (b) the mock endpoint is labelled basis="mock" and refused in production
  (c) deliberate HTTP errors (503) surface unchanged, never masked as 500
      and never leaking internal exception text
  (d) /health derives its status from the real capability flags
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as flood_app

PAYLOAD = {"latitude": 9.08, "longitude": 8.68, "bbox_size_km": 5.0}


class FloodApiTestCase(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(flood_app.app)
        flood_app.flood_model = None

    def tearDown(self):
        flood_app.flood_model = None


class TestPredictFailClosed(FloodApiTestCase):
    """(a) model-load failure -> 503, never a mask."""

    def test_model_load_failure_returns_503_and_no_mask(self):
        with mock.patch.object(
            flood_app,
            "FloodDetectionModel",
            side_effect=flood_app.ModelLoadError("weights missing"),
        ):
            resp = self.client.post("/predict", json=PAYLOAD)
        self.assertEqual(resp.status_code, 503)
        body = resp.json()
        self.assertEqual(
            body["detail"],
            "Flood detection model unavailable: model weights failed to load",
        )
        # No inference payload fields may leak into an error response.
        self.assertNotIn("flood_percentage", body)
        self.assertNotIn("flood_area_km2", body)
        self.assertNotIn("severity", body)

    def test_fail_closed_is_per_request(self):
        """A failed load must not be cached: every request retries and 503s."""
        with mock.patch.object(
            flood_app,
            "FloodDetectionModel",
            side_effect=flood_app.ModelLoadError("weights missing"),
        ) as ctor:
            first = self.client.post("/predict", json=PAYLOAD)
            second = self.client.post("/api/flood-detection", json=PAYLOAD)
        self.assertEqual(first.status_code, 503)
        self.assertEqual(second.status_code, 503)
        self.assertEqual(ctor.call_count, 2)
        self.assertIsNone(flood_app.flood_model)


class TestHttpExceptionHandling(FloodApiTestCase):
    """(c) deliberate HTTP errors surface unchanged; 500s leak nothing."""

    def test_deliberate_503_surfaces_as_503_not_500(self):
        with mock.patch.object(
            flood_app,
            "get_flood_model",
            side_effect=HTTPException(
                status_code=503,
                detail="Flood detection model unavailable: model weights failed to load",
            ),
        ):
            resp = self.client.post("/predict", json=PAYLOAD)
        self.assertEqual(resp.status_code, 503)
        self.assertEqual(
            resp.json()["detail"],
            "Flood detection model unavailable: model weights failed to load",
        )
        self.assertNotIn("Internal server error", resp.text)

    def test_unexpected_error_is_500_without_internal_details(self):
        with mock.patch.object(
            flood_app,
            "get_flood_model",
            side_effect=RuntimeError("secret internal detail: /etc/passwd"),
        ):
            resp = self.client.post("/predict", json=PAYLOAD)
        self.assertEqual(resp.status_code, 500)
        self.assertEqual(resp.json()["detail"], "Internal server error")
        self.assertNotIn("secret internal detail", resp.text)

    def test_no_imagery_available_maps_to_503_not_400(self):
        """A missing upstream observation is not a client error (W7)."""
        stub_model = mock.Mock()
        stub_client = mock.Mock()
        stub_client.get_sentinel2_imagery.side_effect = (
            flood_app.NoImageryAvailableError(
                "No Sentinel-2 data available for the specified time range"
            )
        )
        with mock.patch.object(flood_app, "get_flood_model", return_value=stub_model), \
             mock.patch.object(flood_app, "get_sentinel_client", return_value=stub_client), \
             mock.patch.object(flood_app, "get_preprocessor", return_value=mock.Mock()):
            resp = self.client.post("/predict", json=PAYLOAD)
        self.assertEqual(resp.status_code, 503)
        self.assertIn("No Sentinel-2 data", resp.json()["detail"])


class TestLiveInferenceBasis(FloodApiTestCase):
    """Real inference responses are provenance-marked basis="live"."""

    def test_live_inference_marks_basis_live(self):
        model = mock.Mock()
        mask = np.zeros((4, 4), dtype=np.int32)
        probs = np.zeros((2, 4, 4), dtype=np.float32)
        probs[0] = 1.0
        model.predict.return_value = (mask, probs)
        model.get_flood_statistics.return_value = {
            "flood_detected": False,
            "flood_percentage": 0.0,
            "flood_area_km2": 0.0,
            "avg_confidence": 0.0,
            "max_confidence": 0.0,
            "overall_confidence": 1.0,
            "total_pixels": 16,
            "flooded_pixels": 0,
        }
        model.get_flood_severity.return_value = "none"
        model.create_flood_alert.return_value = {
            "message": "No significant flooding detected in the area.",
            "recommended_actions": ["Continue normal operations"],
        }
        with mock.patch.object(flood_app, "get_flood_model", return_value=model), \
             mock.patch.object(flood_app, "get_sentinel_client", return_value=mock.Mock()), \
             mock.patch.object(flood_app, "get_preprocessor", return_value=mock.Mock()):
            resp = self.client.post("/predict", json=PAYLOAD)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["basis"], "live")


class TestMockEndpoint(FloodApiTestCase):
    """(b) the mock endpoint is labelled and disabled in production."""

    def test_mock_response_labelled_basis_mock(self):
        resp = self.client.get(
            "/api/flood-detection/mock",
            params={"latitude": 9.08, "longitude": 8.68},
        )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["basis"], "mock")

    def test_mock_response_is_deterministic_per_coordinates(self):
        params = {"latitude": 9.08, "longitude": 8.68}
        first = self.client.get("/api/flood-detection/mock", params=params).json()
        second = self.client.get("/api/flood-detection/mock", params=params).json()
        self.assertEqual(first["flood_percentage"], second["flood_percentage"])
        self.assertEqual(first["avg_confidence"], second["avg_confidence"])

    def test_mock_refused_in_production(self):
        with mock.patch.dict(os.environ, {"FLOOD_ML_ENV": "production"}):
            resp = self.client.get(
                "/api/flood-detection/mock",
                params={"latitude": 9.08, "longitude": 8.68},
            )
        self.assertIn(resp.status_code, (403, 404))

    def test_mock_allowed_outside_production(self):
        with mock.patch.dict(os.environ, {"FLOOD_ML_ENV": "development"}):
            resp = self.client.get(
                "/api/flood-detection/mock",
                params={"latitude": 9.08, "longitude": 8.68},
            )
        self.assertEqual(resp.status_code, 200)


class TestHealth(FloodApiTestCase):
    """(d) health status derives from the real capability flags."""

    def test_health_degraded_when_model_absent(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["models_loaded"])
        self.assertFalse(body["model_weights_loaded"])

    def test_healthz_alias_reports_same_flags(self):
        body = self.client.get("/healthz").json()
        self.assertEqual(body["status"], "degraded")
        self.assertIn("model_weights_loaded", body)

    def test_health_healthy_only_when_weights_actually_loaded(self):
        # An object whose weights_loaded flag is False must NOT count.
        fake_unloaded = mock.Mock()
        fake_unloaded.weights_loaded = False
        with mock.patch.object(flood_app, "flood_model", fake_unloaded), \
             mock.patch.object(flood_app, "REDIS_AVAILABLE", True), \
             mock.patch.dict(os.environ, {
                 "SENTINEL_HUB_CLIENT_ID": "x",
                 "SENTINEL_HUB_CLIENT_SECRET": "y",
             }):
            body = self.client.get("/health").json()
        self.assertEqual(body["status"], "degraded")
        self.assertFalse(body["model_weights_loaded"])

        fake_loaded = mock.Mock()
        fake_loaded.weights_loaded = True
        with mock.patch.object(flood_app, "flood_model", fake_loaded), \
             mock.patch.object(flood_app, "REDIS_AVAILABLE", True), \
             mock.patch.dict(os.environ, {
                 "SENTINEL_HUB_CLIENT_ID": "x",
                 "SENTINEL_HUB_CLIENT_SECRET": "y",
             }):
            body = self.client.get("/health").json()
        self.assertEqual(body["status"], "healthy")
        self.assertTrue(body["model_weights_loaded"])


if __name__ == "__main__":
    unittest.main()
