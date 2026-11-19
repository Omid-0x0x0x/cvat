#!/usr/bin/env python3
"""Track a CVAT object across frames with SAM 2.1, entirely on this computer.

Used by CVAT Desktop for macOS (menu: CVAT Desktop > SAM 2 tracking...). It talks to the local
CVAT API, runs the SAM 2 video predictor (Apple GPU via MPS when available, otherwise CPU) and
saves the result as a NEW track in the same job. Existing annotations are never modified, except
for the optional removal of the original single-frame shape after the track was saved.

Modes (first argument), all of them print one JSON object per line on stdout:

  list           list the objects that can be tracked on one frame
  track          track one object for N frames
  download-model download and verify a SAM 2.1 checkpoint
  selftest       run the whole pipeline on synthetic frames (used by CI)
"""

import argparse
import hashlib
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

MODELS = {
    "tiny": {
        "file": "sam2.1_hiera_tiny.pt",
        "config": "configs/sam2.1/sam2.1_hiera_t.yaml",
        "url": "https://huggingface.co/facebook/sam2.1-hiera-tiny/resolve/main/sam2.1_hiera_tiny.pt",
        "size": 156008466,
        "sha256": "7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
    },
    "small": {
        "file": "sam2.1_hiera_small.pt",
        "config": "configs/sam2.1/sam2.1_hiera_s.yaml",
        "url": "https://huggingface.co/facebook/sam2.1-hiera-small/resolve/main/sam2.1_hiera_small.pt",
        "size": 184416285,
        "sha256": "6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38",
    },
    "base_plus": {
        "file": "sam2.1_hiera_base_plus.pt",
        "config": "configs/sam2.1/sam2.1_hiera_b+.yaml",
        "url": "https://huggingface.co/facebook/sam2.1-hiera-base-plus/resolve/main/sam2.1_hiera_base_plus.pt",
        "size": 323606802,
        "sha256": "a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5",
    },
}

SUPPORTED_TYPES = ("polygon", "mask", "rectangle")
MIN_AREA_PIXELS = 4


class UserError(Exception):
    """An error whose message is meant to be shown to the user as it is."""


def emit(event: str, **fields) -> None:
    print(json.dumps({"event": event, **fields}, ensure_ascii=False), flush=True)


def progress(message: str, fraction: float | None = None) -> None:
    emit("progress", message=message, fraction=fraction)


# --------------------------------------------------------------------------------------
# Geometry: CVAT shapes <-> masks
# --------------------------------------------------------------------------------------

def decode_cvat_mask(points, width: int, height: int) -> np.ndarray:
    """CVAT stores a mask as run lengths (starting with background) of the cropped bounding box,
    followed by [left, top, right, bottom]."""
    left, top, right, bottom = (int(round(v)) for v in points[-4:])
    box_w, box_h = right - left + 1, bottom - top + 1
    runs = np.asarray([int(v) for v in points[:-4]], dtype=np.int64)
    if box_w <= 0 or box_h <= 0 or runs.sum() != box_w * box_h:
        raise UserError("A mask on this frame has inconsistent data and cannot be used.")
    flat = np.repeat(np.arange(len(runs)) % 2, runs).astype(np.uint8)
    mask = np.zeros((height, width), dtype=np.uint8)
    crop = flat.reshape(box_h, box_w)
    y0, x0 = max(top, 0), max(left, 0)
    y1, x1 = min(bottom + 1, height), min(right + 1, width)
    mask[y0:y1, x0:x1] = crop[y0 - top:y1 - top, x0 - left:x1 - left]
    return mask


def rasterize(shape_type: str, points, width: int, height: int) -> np.ndarray:
    """Return a uint8 (0/1) mask of the shape."""
    if shape_type == "mask":
        return decode_cvat_mask(points, width, height)
    mask = np.zeros((height, width), dtype=np.uint8)
    if shape_type == "polygon":
        pts = np.round(np.asarray(points, dtype=np.float64).reshape(-1, 2)).astype(np.int32)
        cv2.fillPoly(mask, [pts], 1)
    elif shape_type == "rectangle":
        x1, y1, x2, y2 = points
        cv2.rectangle(mask, (int(round(x1)), int(round(y1))), (int(round(x2)) - 1, int(round(y2)) - 1), 1, -1)
    else:
        raise UserError(f"Shapes of type '{shape_type}' cannot be tracked (use polygon, mask or rectangle).")
    return mask


def mask_to_polygon(mask: np.ndarray):
    """Largest outer contour as a flat [x1, y1, x2, y2, ...] list, or None if the mask is (almost) empty."""
    contours, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < MIN_AREA_PIXELS:
        return None
    epsilon = max(0.5, 0.0015 * cv2.arcLength(contour, True))
    approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
    if len(approx) < 3:
        return None
    return [float(v) for v in approx.reshape(-1)]


def mask_to_rectangle(mask: np.ndarray):
    ys, xs = np.nonzero(mask)
    if len(xs) < MIN_AREA_PIXELS:
        return None
    return [float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)]


def build_track_shapes(results, output_type: str, last_next_frame, first_shape):
    """Turn per-frame masks into CVAT track shapes.

    results: list of (frame, mask or None) in tracking order; the first item is the source frame.
    first_shape: the original geometry for the first frame (a dict with 'points'), used as it is.
    last_next_frame: the frame after the last tracked one (in tracking direction) if it is inside
    the job, so the track can be closed with an "outside" keyframe; otherwise None.
    """
    shapes = []
    previous = None  # geometry of the last visible frame
    visible = False
    for index, (frame, mask) in enumerate(results):
        if index == 0:
            points = first_shape["points"]
        else:
            points = None
            if mask is not None:
                points = mask_to_rectangle(mask) if output_type == "rectangle" else mask_to_polygon(mask)
        if points is not None:
            shapes.append({"frame": frame, "points": points, "outside": False})
            previous, visible = points, True
        elif visible:
            shapes.append({"frame": frame, "points": previous, "outside": True})
            visible = False
    if visible and last_next_frame is not None:
        shapes.append({"frame": last_next_frame, "points": previous, "outside": True})
    shapes.sort(key=lambda item: item["frame"])
    return shapes


# --------------------------------------------------------------------------------------
# CVAT API
# --------------------------------------------------------------------------------------

class Cvat:
    def __init__(self, server: str, token: str):
        import requests

        self.server = server.rstrip("/")
        self.http = requests.Session()
        self.http.headers["Authorization"] = "Token " + token
        self.http.headers["Accept"] = "application/vnd.cvat+json"

    def get(self, path, **params):
        response = self.http.get(self.server + path, params=params, timeout=120)
        self._check(response)
        return response

    def patch(self, path, body, **params):
        response = self.http.patch(self.server + path, params=params, json=body, timeout=300)
        self._check(response)
        return response

    @staticmethod
    def _check(response):
        if response.status_code in (401, 403):
            raise UserError("CVAT refused the request (not authorized). Restart CVAT Desktop and try again.")
        if response.status_code >= 400:
            raise UserError(f"CVAT returned HTTP {response.status_code}: {response.text[:300]}")

    def job(self, job_id):
        return self.get(f"/api/jobs/{job_id}").json()

    def deleted_frames(self, job_id):
        return set(self.get(f"/api/jobs/{job_id}/data/meta").json().get("deleted_frames") or [])

    def labels(self, job_id):
        result = self.get("/api/labels", job_id=job_id, page_size=1000).json()
        return {label["id"]: label for label in result.get("results", [])}

    def annotations(self, job_id):
        return self.get(f"/api/jobs/{job_id}/annotations").json()

    def frame(self, job_id, number):
        deadline = time.time() + 120
        while True:
            response = self.http.get(
                f"{self.server}/api/jobs/{job_id}/data",
                params={"type": "frame", "number": number, "quality": "original"},
                timeout=120,
            )
            if response.status_code == 202 and time.time() < deadline:
                time.sleep(1)
                continue
            self._check(response)
            image = cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                raise UserError(f"Frame {number} could not be decoded.")
            return image


def list_objects(annotations: dict, labels: dict, frame: int) -> list:
    objects = []

    def describe(kind, item, shape):
        label = labels.get(item["label_id"], {})
        return {
            "kind": kind,
            "id": item["id"],
            "label_id": item["label_id"],
            "label": label.get("name", str(item["label_id"])),
            "type": shape["type"],
            "supported": shape["type"] in SUPPORTED_TYPES,
        }

    for shape in annotations.get("shapes", []):
        if shape["frame"] == frame:
            objects.append(describe("shape", shape, shape))
    for track in annotations.get("tracks", []):
        for shape in track["shapes"]:
            if shape["frame"] == frame and not shape.get("outside"):
                objects.append(describe("track", track, shape))
    return objects


def find_object(annotations: dict, kind: str, object_id: int, frame: int):
    if kind == "shape":
        for shape in annotations.get("shapes", []):
            if shape["id"] == object_id and shape["frame"] == frame:
                return shape, shape, None
    else:
        for track in annotations.get("tracks", []):
            if track["id"] == object_id:
                for shape in track["shapes"]:
                    if shape["frame"] == frame and not shape.get("outside"):
                        return track, shape, track
    raise UserError("The selected object was not found on this frame. Save your changes in CVAT first (Ctrl+S).")


def split_attributes(label: dict, attributes: list):
    """CVAT keeps immutable attributes on the track and mutable ones on every shape."""
    mutable = {attr["id"]: attr.get("mutable", False) for attr in label.get("attributes", [])}
    track_level = [a for a in attributes if not mutable.get(a["spec_id"], False)]
    shape_level = [a for a in attributes if mutable.get(a["spec_id"], False)]
    return track_level, shape_level


def frame_sequence(start: int, count: int, direction: str, job: dict, deleted: set) -> list:
    step = 1 if direction == "forward" else -1
    frames = [start]
    current = start
    while len(frames) < count + 1:
        current += step
        if current < job["start_frame"] or current > job["stop_frame"]:
            break
        if current in deleted:
            continue
        frames.append(current)
    return frames


# --------------------------------------------------------------------------------------
# SAM 2
# --------------------------------------------------------------------------------------

def load_sam2(args):
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    if args.sam2_src:
        sys.path.insert(0, args.sam2_src)
    if args.packages_dir and os.path.isdir(args.packages_dir):
        sys.path.append(args.packages_dir)  # after the bundled packages, so those win
    try:
        import torch
    except ImportError as error:
        raise UserError("PyTorch is not installed yet. Use 'Install SAM 2 components' first.") from error
    try:
        from sam2.build_sam import build_sam2_video_predictor
    except ImportError as error:
        raise UserError(f"The SAM 2 code could not be loaded: {error}") from error
    return torch, build_sam2_video_predictor


def pick_device(torch, requested: str) -> str:
    if requested != "auto":
        return requested
    return "mps" if torch.backends.mps.is_available() else "cpu"


def run_tracking(args, frames_dir: str, frame_count: int, prompt: dict):
    """Yield (local_index, mask or None). prompt: {'mask': HxW bool} or {'box': [x1,y1,x2,y2]}."""
    torch, build = load_sam2(args)
    model = MODELS[args.model]
    checkpoint = Path(args.models_dir) / model["file"]
    if not checkpoint.is_file():
        raise UserError("The SAM 2 model file is missing. Use 'Install SAM 2 components' first.")

    device = pick_device(torch, args.device)
    for attempt_device in ([device] if device == "cpu" else [device, "cpu"]):
        try:
            progress(f"Loading SAM 2 ({args.model}) on {attempt_device.upper()}…")
            predictor = build(model["config"], str(checkpoint), device=attempt_device)
            with torch.inference_mode():
                state = predictor.init_state(
                    video_path=frames_dir, offload_video_to_cpu=True, async_loading_frames=False
                )
                if "mask" in prompt:
                    predictor.add_new_mask(state, frame_idx=0, obj_id=1, mask=prompt["mask"])
                else:
                    predictor.add_new_points_or_box(
                        state, frame_idx=0, obj_id=1, box=np.asarray(prompt["box"], dtype=np.float32)
                    )
                for index, _ids, logits in predictor.propagate_in_video(state, start_frame_idx=0):
                    mask = (logits[0] > 0.0).cpu().numpy().reshape(logits.shape[-2], logits.shape[-1])
                    yield index, mask.astype(np.uint8)
            return
        except UserError:
            raise
        except Exception as error:  # MPS can lack an operator: fall back to the CPU once
            if attempt_device == "cpu":
                raise
            progress(f"{attempt_device.upper()} failed ({type(error).__name__}); retrying on CPU…")


# --------------------------------------------------------------------------------------
# Modes
# --------------------------------------------------------------------------------------

def mode_list(args):
    cvat = Cvat(args.server, args.token)
    labels = cvat.labels(args.job)
    objects = list_objects(cvat.annotations(args.job), labels, args.frame)
    job = cvat.job(args.job)
    emit("objects", objects=objects, start_frame=job["start_frame"], stop_frame=job["stop_frame"])


def mode_track(args):
    if args.count < 1:
        raise UserError("The number of frames must be at least 1.")
    cvat = Cvat(args.server, args.token)
    job = cvat.job(args.job)
    if not job["start_frame"] <= args.frame <= job["stop_frame"]:
        raise UserError("The frame is outside of this job.")
    labels = cvat.labels(args.job)
    annotations = cvat.annotations(args.job)
    item, source_shape, source_track = find_object(annotations, args.kind, args.object_id, args.frame)
    if source_shape["type"] not in SUPPORTED_TYPES:
        raise UserError(f"Shapes of type '{source_shape['type']}' cannot be tracked (use polygon, mask or rectangle).")

    frames = frame_sequence(args.frame, args.count, args.direction, job, cvat.deleted_frames(args.job))
    if len(frames) < 2:
        raise UserError("There are no further frames in that direction.")

    with tempfile.TemporaryDirectory(prefix="cvat-sam2-") as frames_dir:
        width = height = None
        for index, number in enumerate(frames):
            progress(f"Downloading frame {number} ({index + 1}/{len(frames)})…", 0.25 * (index + 1) / len(frames))
            image = cvat.frame(args.job, number)
            if width is None:
                height, width = image.shape[:2]
            elif image.shape[:2] != (height, width):
                raise UserError("The frames of this job have different sizes; tracking needs equal sizes.")
            cv2.imwrite(os.path.join(frames_dir, f"{index:05d}.jpg"), image, [cv2.IMWRITE_JPEG_QUALITY, 95])

        source_mask = rasterize(source_shape["type"], source_shape["points"], width, height)
        if int(source_mask.sum()) < MIN_AREA_PIXELS:
            raise UserError("The selected object is empty on this frame.")
        prompt = {"box": source_shape["points"]} if source_shape["type"] == "rectangle" else {"mask": source_mask.astype(bool)}

        masks = {}
        for index, mask in run_tracking(args, frames_dir, len(frames), prompt):
            masks[index] = mask
            progress(f"Tracking frame {frames[index]} ({index + 1}/{len(frames)})…", 0.25 + 0.7 * (index + 1) / len(frames))

    output_type = "rectangle" if source_shape["type"] == "rectangle" else "polygon"
    first_points = source_shape["points"]
    if source_shape["type"] == "mask":
        first_points = mask_to_polygon(source_mask)
        if first_points is None:
            raise UserError("The selected mask could not be converted to a polygon.")
    step = 1 if args.direction == "forward" else -1
    next_frame = frames[-1] + step
    if not job["start_frame"] <= next_frame <= job["stop_frame"]:
        next_frame = None
    results = [(number, masks.get(index)) for index, number in enumerate(frames)]
    shapes = build_track_shapes(results, output_type, next_frame, {"points": first_points})

    label = labels.get(item["label_id"], {})
    track_attrs, shape_attrs = split_attributes(label, source_shape.get("attributes", []))
    track = {
        "label_id": item["label_id"],
        "frame": shapes[0]["frame"],
        "group": item.get("group") or 0,
        "source": "auto",
        "attributes": track_attrs if source_track is None else (source_track.get("attributes") or []),
        "shapes": [
            {
                "type": output_type,
                "frame": shape["frame"],
                "points": shape["points"],
                "outside": shape["outside"],
                "occluded": bool(source_shape.get("occluded", False)),
                "z_order": source_shape.get("z_order", 0),
                "rotation": source_shape.get("rotation", 0.0),
                "attributes": shape_attrs,
            }
            for shape in shapes
        ],
    }
    progress("Saving the track in CVAT…", 0.97)
    cvat.patch(f"/api/jobs/{args.job}/annotations", {"version": 0, "tags": [], "shapes": [], "tracks": [track]}, action="create")
    replaced = False
    if args.replace and args.kind == "shape":
        cvat.patch(f"/api/jobs/{args.job}/annotations", {"version": 0, "tags": [], "shapes": [source_shape], "tracks": []}, action="delete")
        replaced = True
    visible = sum(1 for shape in shapes if not shape["outside"])
    emit("done", frames_tracked=len(frames) - 1, frames_with_object=visible, replaced=replaced)


def mode_download_model(args):
    import requests

    model = MODELS[args.model]
    target = Path(args.models_dir) / model["file"]
    target.parent.mkdir(parents=True, exist_ok=True)

    def sha256_of(path):
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()

    if target.is_file() and target.stat().st_size == model["size"] and sha256_of(target) == model["sha256"]:
        emit("done", path=str(target), cached=True)
        return
    partial = target.with_suffix(".part")
    digest = hashlib.sha256()
    received = 0
    with requests.get(model["url"], stream=True, timeout=60) as response:
        if response.status_code != 200:
            raise UserError(f"The model download failed (HTTP {response.status_code}).")
        with open(partial, "wb") as handle:
            for chunk in response.iter_content(1 << 20):
                handle.write(chunk)
                digest.update(chunk)
                received += len(chunk)
                progress(f"Downloading {model['file']} ({received // (1 << 20)} of {model['size'] // (1 << 20)} MB)…",
                         received / model["size"])
    if received != model["size"] or digest.hexdigest() != model["sha256"]:
        partial.unlink(missing_ok=True)
        raise UserError("The downloaded model file is corrupted (checksum mismatch). Please try again.")
    partial.replace(target)
    emit("done", path=str(target), cached=False)


def synthetic_frames(directory: str, count: int = 8, size: int = 256):
    truth = []
    for index in range(count):
        image = np.zeros((size, size, 3), np.uint8)
        center = (60 + 6 * index, 128)
        cv2.circle(image, center, 28, (255, 255, 255), -1)
        cv2.imwrite(os.path.join(directory, f"{index:05d}.jpg"), image)
        truth.append(center[0])
    return truth


def mode_selftest(args):
    with tempfile.TemporaryDirectory(prefix="cvat-sam2-selftest-") as frames_dir:
        truth_x = synthetic_frames(frames_dir)
        height = width = 256
        source = rasterize("polygon", [32, 100, 88, 100, 88, 156, 32, 156], width, height)
        centers = {}
        for index, mask in run_tracking(args, frames_dir, len(truth_x), {"mask": source.astype(bool)}):
            ys, xs = np.nonzero(mask)
            if len(xs):
                centers[index] = float(xs.mean())
            progress(f"selftest frame {index}", (index + 1) / len(truth_x))
    errors = [abs(centers[i] - truth_x[i]) for i in range(len(truth_x)) if i in centers]
    if len(errors) < len(truth_x) or max(errors) > 12:
        raise UserError(f"SAM 2 self-test failed: tracked {len(errors)}/{len(truth_x)} frames, max error {max(errors, default=-1):.1f}px")
    emit("done", frames=len(errors), max_error_px=round(max(errors), 2))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=["list", "track", "download-model", "selftest"])
    parser.add_argument("--server", default="http://127.0.0.1:28080")
    parser.add_argument("--token", default=os.environ.get("CVAT_SAM2_TOKEN", ""))
    parser.add_argument("--job", type=int)
    parser.add_argument("--frame", type=int)
    parser.add_argument("--kind", choices=["shape", "track"])
    parser.add_argument("--object-id", type=int)
    parser.add_argument("--count", type=int, default=100)
    parser.add_argument("--direction", choices=["forward", "backward"], default="forward")
    parser.add_argument("--model", choices=sorted(MODELS), default="tiny")
    parser.add_argument("--models-dir", default="")
    parser.add_argument("--packages-dir", default="")
    parser.add_argument("--sam2-src", default="")
    parser.add_argument("--device", choices=["auto", "mps", "cpu"], default="auto")
    parser.add_argument("--replace", action="store_true", help="delete the original single-frame shape after saving the track")
    args = parser.parse_args()
    if args.mode in ("list", "track") and (not args.token or args.job is None or args.frame is None):
        parser.error("--job, --frame and a token (CVAT_SAM2_TOKEN) are required")
    if args.mode == "track" and (args.kind is None or args.object_id is None):
        parser.error("--kind and --object-id are required")
    try:
        {"list": mode_list, "track": mode_track, "download-model": mode_download_model, "selftest": mode_selftest}[args.mode](args)
    except UserError as error:
        emit("error", message=str(error))
        return 1
    except Exception as error:  # noqa: BLE001 - report everything to the app, with the type for diagnosis
        emit("error", message=f"{type(error).__name__}: {error}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
