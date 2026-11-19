# SAM 2 tracking in CVAT Desktop for macOS

Menu: **CVAT Desktop → SAM 2 tracking…** (⌘⇧T).

You select one object (polygon, mask or rectangle) on a frame, choose how many following frames
to label (for example 100) and the direction. SAM 2.1 follows the object and the result is saved as
a **new track** in the same job (one keyframe per frame; polygons for polygons/masks, rectangles for
rectangles). If the object disappears, the track gets an "outside" keyframe and continues when it
reappears.

## Using it

1. Open a job and draw the object on the frame where it is clearly visible. **Save (Ctrl+S).**
2. Open the SAM 2 window. The job ID and the current frame are filled in; adjust them if needed.
3. **Load objects on this frame**, choose the object, set the number of frames, press **Start tracking**.
4. When it finishes, press **Reload the job** to see the track. Check it and fix keyframes where needed.

By default the original single-frame shape is replaced by the track. Existing tracks are never modified:
tracking one of them creates a second track, which you can use to replace it manually.

## One-time setup (needs internet)

The SAM 2 code ships inside the app. PyTorch (about 1 GB) and a model checkpoint are downloaded once,
after you confirm in the window, into `~/Library/Application Support/cvat-desktop-macos/sam2/`:

| Model | Size | Notes |
| --- | --- | --- |
| Tiny | 156 MB | fastest, good default |
| Small | 184 MB | |
| Base+ | 324 MB | more accurate, slower |

PyTorch comes from the Python Package Index; checkpoints come from Hugging Face (`facebook/sam2.1-hiera-*`)
and are verified against a pinned SHA-256. Images and annotations are never uploaded anywhere.

## Limits

- Needs Apple Silicon. "Automatic" uses the Apple GPU (MPS) and falls back to the CPU if MPS fails.
- All frames of the job must have the same size. Frame steps (`frame_filter`) are not supported.
- Only polygon, mask and rectangle objects can be tracked. Skeletons, polylines, points and ellipses cannot.
- Tracking 100 full-HD frames needs a few GB of free memory; use fewer frames if the Mac struggles.
- SAM 2 can drift. It follows appearance, not identity: review the result.
- Only the first administrator account is used to talk to the local CVAT API.

The Python tracker is `desktop/macos/sam2/track_sam2.py`; its geometry code has unit tests
(`python3 -m unittest desktop/macos/sam2/test_geometry.py`), and CI runs the real model end to end.

SAM 2 is released by Meta under the Apache-2.0 license (see `vendor/sam2/LICENSE` in the app bundle).
