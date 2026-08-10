"""Fail-closed tests for the flood detection model wrapper.

These tests run without the heavy ML stack (torch/transformers): the module
imports lazily, and fake/missing modules are injected via sys.modules.
"""
import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

from models.flood_detection import FloodDetectionModel, ModelLoadError


def _fake_ml_stack(model_cls_side_effect=None):
    """Return (fake_torch, fake_transformers) simulating an installed stack."""
    fake_torch = mock.Mock()
    fake_torch.cuda.is_available.return_value = False
    fake_transformers = mock.Mock()
    segmenter = fake_transformers.AutoModelForImageSegmentation
    if model_cls_side_effect is not None:
        segmenter.from_pretrained.side_effect = model_cls_side_effect
    else:
        segmenter.from_pretrained.return_value = mock.Mock()
    fake_transformers.AutoImageProcessor.from_pretrained.return_value = mock.Mock()
    return fake_torch, fake_transformers


class TestFailClosedConstruction(unittest.TestCase):
    def test_construction_raises_when_ml_stack_missing(self):
        # sys.modules entry of None forces ImportError on `import torch`.
        with mock.patch.dict(sys.modules, {"torch": None, "transformers": None}):
            with self.assertRaises(ModelLoadError):
                FloodDetectionModel()

    def test_construction_raises_when_weights_fail_to_load(self):
        fake_torch, fake_transformers = _fake_ml_stack(
            model_cls_side_effect=RuntimeError("network down")
        )
        with mock.patch.dict(
            sys.modules, {"torch": fake_torch, "transformers": fake_transformers}
        ):
            with self.assertRaises(ModelLoadError) as ctx:
                FloodDetectionModel()
        self.assertIn("network down", str(ctx.exception))

    def test_construction_marks_weights_loaded_on_success(self):
        fake_torch, fake_transformers = _fake_ml_stack()
        with mock.patch.dict(
            sys.modules, {"torch": fake_torch, "transformers": fake_transformers}
        ):
            model = FloodDetectionModel()
        self.assertTrue(model.weights_loaded)

    def test_success_message_printed_only_on_actual_success(self):
        # Failure: must NOT claim success.
        buf = io.StringIO()
        with mock.patch.dict(sys.modules, {"torch": None, "transformers": None}):
            with redirect_stdout(buf):
                with self.assertRaises(ModelLoadError):
                    FloodDetectionModel()
        self.assertNotIn("loaded successfully", buf.getvalue())

        # Success: must claim success.
        fake_torch, fake_transformers = _fake_ml_stack()
        buf = io.StringIO()
        with mock.patch.dict(
            sys.modules, {"torch": fake_torch, "transformers": fake_transformers}
        ):
            with redirect_stdout(buf):
                FloodDetectionModel()
        self.assertIn("loaded successfully", buf.getvalue())


class TestNoMockPredictionPath(unittest.TestCase):
    def test_mock_prediction_helper_removed(self):
        self.assertFalse(
            hasattr(FloodDetectionModel, "_mock_prediction"),
            "_mock_prediction must not exist — fabricated predictions are banned",
        )

    def test_predict_refuses_when_weights_not_loaded(self):
        model = FloodDetectionModel.__new__(FloodDetectionModel)
        model.weights_loaded = False
        model.model = None
        with self.assertRaises(ModelLoadError):
            model.predict(np.zeros((1, 9, 4, 4), dtype=np.float32))


class TestPureHelpers(unittest.TestCase):
    def test_severity_thresholds(self):
        self.assertEqual(FloodDetectionModel.get_flood_severity(0.5), "none")
        self.assertEqual(FloodDetectionModel.get_flood_severity(3.0), "low")
        self.assertEqual(FloodDetectionModel.get_flood_severity(10.0), "moderate")
        self.assertEqual(FloodDetectionModel.get_flood_severity(20.0), "high")
        self.assertEqual(FloodDetectionModel.get_flood_severity(50.0), "severe")

    def test_create_flood_alert_without_instance(self):
        alert = FloodDetectionModel.create_flood_alert(
            {"flood_percentage": 10.0, "flood_area_km2": 2.5},
            {"latitude": 9.08, "longitude": 8.68},
        )
        self.assertEqual(alert["severity"], "moderate")
        self.assertIn("Moderate flooding", alert["message"])
        self.assertTrue(alert["recommended_actions"])


if __name__ == "__main__":
    unittest.main()
