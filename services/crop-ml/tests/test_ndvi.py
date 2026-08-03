import datetime as dt
import unittest

from app.models import BandSample
from app.ndvi import mean_ndvi, ndvi_series, ndvi_value


class TestNdviMath(unittest.TestCase):
    def test_hand_computed_value(self):
        # (0.5 - 0.1) / (0.5 + 0.1) = 0.666667 (rounded to 6 dp)
        self.assertAlmostEqual(ndvi_value(0.1, 0.5), 0.666667, places=6)

    def test_negative_ndvi(self):
        self.assertAlmostEqual(ndvi_value(0.5, 0.1), -0.666667, places=6)

    def test_zero_sum_guard(self):
        self.assertEqual(ndvi_value(0.0, 0.0), 0.0)

    def test_series_matches_values(self):
        samples = [
            BandSample(date=dt.date(2024, 3, 1), red=0.10, nir=0.50),
            BandSample(date=dt.date(2024, 3, 6), red=0.30, nir=0.30),
        ]
        values = ndvi_series(samples)
        self.assertEqual(len(values), 2)
        self.assertAlmostEqual(values[0], 0.666667, places=6)
        self.assertEqual(values[1], 0.0)

    def test_mean(self):
        self.assertAlmostEqual(mean_ndvi([0.2, 0.4, 0.6]), 0.4, places=6)

    def test_rounding_is_deterministic(self):
        a = ndvi_value(0.123456, 0.654321)
        b = ndvi_value(0.123456, 0.654321)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
