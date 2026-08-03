import copy
import unittest

from app.anomaly import classify_season, health_score
from app.ndvi import mean_ndvi, ndvi_series
from app.phenology import compute_phenology
from tests.helpers import synthetic_curve


def analyze(samples):
    dates = [s.date for s in samples]
    values = ndvi_series(samples)
    return compute_phenology(dates, values), mean_ndvi(values)


def stressed_curve():
    """Mid-season stress: crush NIR (and thus NDVI) across the peak plateau."""
    samples = copy.deepcopy(synthetic_curve())
    for i in range(10, 30):  # days 50..145, the whole high-NDVI plateau
        s = samples[i]
        samples[i] = s.model_copy(update={"nir": round(s.nir * 0.30, 6)})
    return samples


class TestClassification(unittest.TestCase):
    def setUp(self):
        self.healthy = synthetic_curve()
        self.reference = synthetic_curve()
        self.h_phen, self.h_mean = analyze(self.healthy)
        self.r_phen, self.r_mean = analyze(self.reference)

    def test_healthy_curve_is_normal(self):
        cls = classify_season(self.h_phen, self.h_mean, self.r_phen, self.r_mean)
        self.assertEqual(cls.label, "normal")
        self.assertEqual(cls.reason_codes, [])

    def test_low_absolute_peak_is_stressed(self):
        weak, weak_mean = analyze(synthetic_curve(amp=0.12))
        cls = classify_season(weak, weak_mean)
        self.assertEqual(cls.label, "stressed")
        self.assertIn("PEAK_NDVI_LOW", cls.reason_codes)

    def test_peak_deficit_vs_reference_is_stressed(self):
        weak, weak_mean = analyze(synthetic_curve(amp=0.32))
        cls = classify_season(weak, weak_mean, self.r_phen, self.r_mean)
        self.assertEqual(cls.label, "stressed")
        self.assertIn("PEAK_NDVI_DEFICIT_VS_REFERENCE", cls.reason_codes)

    def test_delayed_sos_is_delayed(self):
        # Whole season shifted +40 days (same shape, same mean): a pure delay.
        late, late_mean = analyze(synthetic_curve(n=48, sos_day=85.0, eos_day=210.0))
        cls = classify_season(late, late_mean, self.r_phen, self.r_mean)
        self.assertEqual(cls.label, "delayed")
        self.assertIn("SOS_DELAYED", cls.reason_codes)


class TestHealthScore(unittest.TestCase):
    def setUp(self):
        self.baseline = synthetic_curve()
        self.b_phen, self.b_mean = analyze(self.baseline)

    def test_identical_curve_scores_100(self):
        phen, mean_v = analyze(synthetic_curve())
        score, drivers = health_score(phen, mean_v, self.b_phen, self.b_mean)
        self.assertEqual(score, 100.0)
        self.assertEqual(drivers, [])

    def test_monotonicity_healthier_scores_higher(self):
        good, _ = analyze(synthetic_curve(amp=0.55))
        mild, _ = analyze(synthetic_curve(amp=0.45))
        bad, _ = analyze(synthetic_curve(amp=0.30))
        s_good, _ = health_score(*analyze(synthetic_curve(amp=0.55)), self.b_phen, self.b_mean)
        s_mild, _ = health_score(mild, mean_ndvi(ndvi_series(synthetic_curve(amp=0.45))),
                                 self.b_phen, self.b_mean)
        s_bad, _ = health_score(bad, mean_ndvi(ndvi_series(synthetic_curve(amp=0.30))),
                                self.b_phen, self.b_mean)
        self.assertGreater(s_good, s_mild)
        self.assertGreater(s_mild, s_bad)

    def test_midseason_stress_lowers_score_and_names_driver(self):
        stressed = stressed_curve()
        phen, mean_v = analyze(stressed)
        healthy_score, _ = health_score(self.b_phen, self.b_mean, self.b_phen, self.b_mean)
        score, drivers = health_score(phen, mean_v, self.b_phen, self.b_mean)
        self.assertLess(score, healthy_score)
        self.assertGreater(len(drivers), 0)
        self.assertEqual(drivers[0].code, "peak_ndvi_deficit")

    def test_drivers_sorted_by_impact_desc(self):
        phen, mean_v = analyze(stressed_curve())
        _, drivers = health_score(phen, mean_v, self.b_phen, self.b_mean)
        impacts = [d.impact for d in drivers]
        self.assertEqual(impacts, sorted(impacts, reverse=True))

    def test_late_sos_driver(self):
        late, late_mean = analyze(synthetic_curve(sos_day=80.0))
        _, drivers = health_score(late, late_mean, self.b_phen, self.b_mean)
        codes = {d.code for d in drivers}
        self.assertIn("late_sos", codes)

    def test_score_never_below_zero(self):
        dead, dead_mean = analyze(synthetic_curve(amp=0.01, sos_day=150.0, eos_day=60.0))
        score, _ = health_score(dead, dead_mean, self.b_phen, self.b_mean)
        self.assertGreaterEqual(score, 0.0)
        self.assertLessEqual(score, 100.0)


if __name__ == "__main__":
    unittest.main()
