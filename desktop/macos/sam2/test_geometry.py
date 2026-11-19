"""Unit tests for the CVAT <-> mask conversions and track building (no SAM 2 / torch needed).

Run: python3 -m unittest desktop/macos/sam2/test_geometry.py -v
"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import track_sam2 as t  # noqa: E402


def encode_cvat_mask(mask: np.ndarray):
    """Reference encoder (same format CVAT uses) to test the decoder."""
    ys, xs = np.nonzero(mask)
    left, top, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    flat = mask[top:bottom + 1, left:right + 1].reshape(-1)
    runs, current, count = [], 0, 0
    for value in flat:
        if value == current:
            count += 1
        else:
            runs.append(count)
            current, count = value, 1
    runs.append(count)
    return runs + [left, top, right, bottom]


class GeometryTests(unittest.TestCase):
    def test_mask_roundtrip(self):
        mask = np.zeros((40, 50), np.uint8)
        mask[5:20, 10:30] = 1
        mask[8:12, 15:18] = 0  # a hole
        decoded = t.decode_cvat_mask(encode_cvat_mask(mask), 50, 40)
        np.testing.assert_array_equal(decoded, mask)

    def test_mask_with_leading_foreground_run(self):
        mask = np.zeros((10, 10), np.uint8)
        mask[2:6, 3:7] = 1
        points = encode_cvat_mask(mask)
        self.assertEqual(points[0], 0 if mask[2, 3] == 1 else points[0])
        np.testing.assert_array_equal(t.decode_cvat_mask(points, 10, 10), mask)

    def test_inconsistent_mask_is_rejected(self):
        with self.assertRaises(t.UserError):
            t.decode_cvat_mask([1, 1, 0, 0, 5, 5], 10, 10)

    def test_polygon_rasterize_and_back(self):
        points = [10, 10, 60, 10, 60, 40, 10, 40]
        mask = t.rasterize("polygon", points, 100, 80)
        self.assertGreater(mask.sum(), 50 * 30 * 0.9)
        polygon = t.mask_to_polygon(mask)
        xs, ys = polygon[0::2], polygon[1::2]
        self.assertAlmostEqual(min(xs), 10, delta=1)
        self.assertAlmostEqual(max(xs), 60, delta=1)
        self.assertAlmostEqual(min(ys), 10, delta=1)
        self.assertAlmostEqual(max(ys), 40, delta=1)

    def test_rectangle_roundtrip(self):
        mask = t.rasterize("rectangle", [5, 6, 25, 36], 50, 50)
        self.assertEqual(int(mask.sum()), 20 * 30)
        self.assertEqual(t.mask_to_rectangle(mask), [5.0, 6.0, 25.0, 36.0])

    def test_empty_and_tiny_masks_give_nothing(self):
        empty = np.zeros((20, 20), np.uint8)
        self.assertIsNone(t.mask_to_polygon(empty))
        self.assertIsNone(t.mask_to_rectangle(empty))
        tiny = empty.copy()
        tiny[3, 3] = 1
        self.assertIsNone(t.mask_to_polygon(tiny))

    def test_unsupported_type(self):
        with self.assertRaises(t.UserError):
            t.rasterize("ellipse", [1, 2, 3, 4], 10, 10)


class TrackBuildingTests(unittest.TestCase):
    @staticmethod
    def square(x):
        mask = np.zeros((60, 60), np.uint8)
        mask[20:40, x:x + 10] = 1
        return mask

    def build(self, results, next_frame, kind="polygon"):
        return t.build_track_shapes(results, kind, next_frame, {"points": [0, 0, 5, 0, 5, 5]})

    def test_object_visible_throughout_is_closed_with_outside_shape(self):
        results = [(10, None), (11, self.square(10)), (12, self.square(14))]
        shapes = self.build(results, 13)
        self.assertEqual([s["frame"] for s in shapes], [10, 11, 12, 13])
        self.assertEqual([s["outside"] for s in shapes], [False, False, False, True])
        self.assertEqual(shapes[0]["points"], [0, 0, 5, 0, 5, 5])  # original geometry kept

    def test_no_closing_shape_at_end_of_job(self):
        shapes = self.build([(10, None), (11, self.square(10))], None)
        self.assertEqual([s["outside"] for s in shapes], [False, False])

    def test_object_disappears_and_returns(self):
        results = [(0, None), (1, self.square(10)), (2, np.zeros((60, 60), np.uint8)),
                   (3, np.zeros((60, 60), np.uint8)), (4, self.square(30))]
        shapes = self.build(results, 5)
        self.assertEqual([(s["frame"], s["outside"]) for s in shapes],
                         [(0, False), (1, False), (2, True), (4, False), (5, True)])

    def test_backward_tracking_is_sorted_ascending(self):
        results = [(10, None), (9, self.square(10)), (8, self.square(12))]
        shapes = self.build(results, 7)
        self.assertEqual([s["frame"] for s in shapes], [7, 8, 9, 10])
        self.assertTrue(shapes[0]["outside"])

    def test_rectangle_output(self):
        results = [(0, None), (1, self.square(10))]
        shapes = t.build_track_shapes(results, "rectangle", None, {"points": [1, 2, 3, 4]})
        self.assertEqual(shapes[1]["points"], [10.0, 20.0, 20.0, 40.0])


class ApiHelperTests(unittest.TestCase):
    annotations = {
        "shapes": [
            {"id": 1, "frame": 5, "label_id": 7, "type": "polygon", "points": [0, 0, 1, 0, 1, 1]},
            {"id": 2, "frame": 6, "label_id": 7, "type": "polygon", "points": []},
            {"id": 3, "frame": 5, "label_id": 8, "type": "ellipse", "points": []},
        ],
        "tracks": [{"id": 9, "label_id": 7, "group": 0, "attributes": [], "shapes": [
            {"frame": 5, "type": "rectangle", "outside": False, "points": [0, 0, 2, 2]},
            {"frame": 8, "type": "rectangle", "outside": True, "points": [0, 0, 2, 2]},
        ]}],
    }
    labels = {7: {"id": 7, "name": "car", "attributes": [{"id": 1, "mutable": True}, {"id": 2, "mutable": False}]},
              8: {"id": 8, "name": "ball", "attributes": []}}

    def test_list_objects_on_frame(self):
        objects = t.list_objects(self.annotations, self.labels, 5)
        self.assertEqual([(o["kind"], o["id"], o["supported"]) for o in objects],
                         [("shape", 1, True), ("shape", 3, False), ("track", 9, True)])
        self.assertEqual(objects[0]["label"], "car")

    def test_outside_track_keyframe_is_not_listed(self):
        self.assertEqual(t.list_objects(self.annotations, self.labels, 8), [])

    def test_find_object(self):
        item, shape, track = t.find_object(self.annotations, "track", 9, 5)
        self.assertIs(track, item)
        with self.assertRaises(t.UserError):
            t.find_object(self.annotations, "shape", 1, 6)

    def test_split_attributes(self):
        attrs = [{"spec_id": 1, "value": "a"}, {"spec_id": 2, "value": "b"}]
        track_level, shape_level = t.split_attributes(self.labels[7], attrs)
        self.assertEqual(track_level, [{"spec_id": 2, "value": "b"}])
        self.assertEqual(shape_level, [{"spec_id": 1, "value": "a"}])

    def test_frame_sequence(self):
        job = {"start_frame": 0, "stop_frame": 20}
        self.assertEqual(t.frame_sequence(5, 3, "forward", job, set()), [5, 6, 7, 8])
        self.assertEqual(t.frame_sequence(5, 3, "backward", job, set()), [5, 4, 3, 2])
        self.assertEqual(t.frame_sequence(5, 3, "forward", job, {6}), [5, 7, 8, 9])
        self.assertEqual(t.frame_sequence(19, 10, "forward", job, set()), [19, 20])
        self.assertEqual(t.frame_sequence(1, 10, "backward", job, set()), [1, 0])


if __name__ == "__main__":
    unittest.main()
