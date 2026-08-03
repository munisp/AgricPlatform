import datetime as dt
import unittest

from app.ndvi import ndvi_series
from app.phenology import compute_phenology, savgol_window, smooth
from tests.helpers import synthetic_curve


class TestPhenologyOnSyntheticCurve(unittest.TestCase):
    def setUp(self):
        # Logistic curve: SOS inflection day ~45, EOS inflection day ~170.
        self.samples = synthetic_curve()
        self.dates = [s.date for s in self.samples]
        self.ndvi = ndvi_series(self.samples)
        self.phen = compute_phenology(self.dates, self.ndvi)

    def test_sos_within_known_window(self):
        # 20%-amplitude crossing of a logistic rise centred near day 45
        # lands shortly after the inflection start; allow a generous window.
        sos = self.phen.sos_date
        self.assertGreaterEqual(sos, dt.date(2024, 3, 20))
        self.assertLessEqual(sos, dt.date(2024, 5, 5))

    def test_eos_after_sos_and_in_known_window(self):
        self.assertGreater(self.phen.eos_date, self.phen.sos_date)
        self.assertGreaterEqual(self.phen.eos_date, dt.date(2024, 7, 20))
        self.assertLessEqual(self.phen.eos_date, dt.date(2024, 9, 30))

    def test_peak_between_sos_and_eos(self):
        self.assertGreaterEqual(self.phen.peak_date, self.phen.sos_date)
        self.assertLessEqual(self.phen.peak_date, self.phen.eos_date)
        self.assertGreater(self.phen.peak_value, 0.5)

    def test_amplitude_is_peak_minus_base(self):
        self.assertAlmostEqual(
            self.phen.amplitude,
            round(self.phen.peak_value - self.phen.base_value, 6),
            places=6,
        )

    def test_unsorted_input_is_sorted(self):
        shuffled = list(reversed(self.dates)), list(reversed(self.ndvi))
        phen = compute_phenology(list(shuffled[0]), list(shuffled[1]))
        self.assertEqual(phen.sos_date, self.phen.sos_date)
        self.assertEqual(phen.peak_date, self.phen.peak_date)


class TestShortSeriesAndSavgolEdges(unittest.TestCase):
    def test_rejects_fewer_than_6_acquisitions(self):
        samples = synthetic_curve(n=5)
        with self.assertRaises(ValueError):
            compute_phenology([s.date for s in samples], ndvi_series(samples))

    def test_exactly_6_acquisitions_works(self):
        samples = synthetic_curve(n=6, cadence=30)
        phen = compute_phenology([s.date for s in samples], ndvi_series(samples))
        self.assertGreaterEqual(phen.peak_value, phen.base_value)

    def test_window_never_exceeds_series(self):
        self.assertEqual(savgol_window(6), 5)
        self.assertEqual(savgol_window(7), 7)
        self.assertEqual(savgol_window(40), 11)
        self.assertEqual(savgol_window(12), 11)

    def test_smooth_preserves_length(self):
        values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
        self.assertEqual(len(smooth(values)), len(values))

    def test_mismatched_lengths_raise(self):
        with self.assertRaises(ValueError):
            compute_phenology([dt.date(2024, 1, 1)], [0.1, 0.2])


if __name__ == "__main__":
    unittest.main()
