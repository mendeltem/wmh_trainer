# 01_prepare_cases.py
# ---------------------------------------------------------------------------
# Step 1: turn the 110 public test scans into small data files for the web
#         page: about 6 slices per patient, each with the FLAIR picture, the
#         expert mask and the mask of the algorithm (BIANCA).
#
# Input : build/case_table.tsv (written by 00_survey_cases.py)
#         the public WMH Challenge test scans and the BIANCA probability maps
#         (READ-ONLY, same files as listed in 00_survey_cases.py)
#         one public TRAINING scan for the example picture of the tutorial
# Output: data/case_<id>.js      one file per patient (loaded only when opened)
#         data/cases.js          small index of all patients
#         data/tutorial.js       one example slice for the tutorial
#         build/cases_meta.json  slice numbers, crop box, voxel size (for the tests)
#
# Run   : WMH_CHALLENGE_DIR=/path/to/prepared/challenge/copy python build/01_prepare_cases.py
#
# Picture orientation used on the page (checked below, the script stops if a
# scan is stored differently):
#   NIfTI axis codes are L, P, S  -> array axis 0 runs to the patient's LEFT,
#                                    array axis 1 runs to the BACK of the head.
#   We show axis 0 from left to right on the screen and axis 1 from top to
#   bottom. So: front of the head = top of the picture, and the patient's
#   LEFT = RIGHT side of the picture (radiological convention).
# ---------------------------------------------------------------------------
import base64
import csv
import io
import json
import os
import platform
from pathlib import Path

import nibabel as nib
import numpy as np
import PIL
import scipy
from PIL import Image
from scipy import ndimage

# ---- settings --------------------------------------------------------------
CHALLENGE = Path(os.environ.get("WMH_CHALLENGE_DIR", "challenge_copy"))
TEST = CHALLENGE / "test110"
BUILD = Path(__file__).resolve().parent                # the build/ folder
DATA = BUILD.parent / "data"                           # the data/ folder of the page
DATA.mkdir(exist_ok=True)

N_SLICES = 6                   # slices per patient
MIN_WMH_VOXELS = 5             # a slice needs at least this many expert voxels to be chosen
SMALL_LESION_MM3 = 30.0        # a single lesion below 30 mm3 counts as a "small lesion"
CROP_MARGIN = 12               # voxels kept around the brain mask
WINDOW_PERCENTILES = (1.0, 99.9)   # robust grey window, measured inside the brain mask

# BIANCA settings of the best set-up (bianca-film/code/17b_score_test110_best.py),
# repeated here so that we can score BIANCA on exactly the slices the user sees.
BIANCA_THRESHOLD = 0.90        # probability cut-off
BIANCA_MIN_CLUSTER = 3         # specks smaller than 3 voxels are removed

# Example picture of the tutorial: a scan of the 60 TRAINING scans of the same
# challenge, so that no answer of the 110 trainer patients is given away.
TUTORIAL_FOLDER = CHALLENGE / "prep" / "challenge-39"

film = json.loads((CHALLENGE / "film_data_test110_best.json").read_text())
bianca_whole_scan = {c["id"]: c["dice_final"] for c in film["cases"]}

with open(BUILD / "case_table.tsv") as f:
    table = list(csv.DictReader(f, delimiter="\t"))
if len(table) != 110:
    raise SystemExit(f"STOP: expected 110 rows in case_table.tsv, found {len(table)}")


# ---- small helpers ---------------------------------------------------------
def run_length(mask_2d):
    """Store a yes/no picture as a short list: start, length, start, length ...
    The picture is read row by row (index = row * width + column)."""
    flat = mask_2d.ravel().astype(np.int8)
    change = np.diff(np.concatenate([[0], flat, [0]]))
    starts = np.flatnonzero(change == 1)
    ends = np.flatnonzero(change == -1)
    runs = []
    for s, e in zip(starts, ends):
        runs += [int(s), int(e - s)]
    return runs


def dice(a, b):
    """Dice = 2 * overlap / (size of a + size of b)."""
    total = a.sum() + b.sum()
    return float(2 * (a & b).sum() / total) if total else 1.0


def picture_as_png(flair_slice, low, high):
    """Grey window low..high -> 8 bit PNG, as text that a web page can show.
    .T turns [x, y] into [row = y, column = x] -> front of the head on top."""
    picture = np.clip((flair_slice.T - low) / (high - low), 0, 1) * 255
    picture = np.round(picture).astype(np.uint8)
    png = io.BytesIO()
    Image.fromarray(picture).save(png, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(png.getvalue()).decode()


def crop_box(brain, shape):
    """Smallest box around the brain mask plus a margin (same box for all slices)."""
    xs = np.flatnonzero(brain.any(axis=(1, 2)))
    ys = np.flatnonzero(brain.any(axis=(0, 2)))
    x0, x1 = max(0, xs.min() - CROP_MARGIN), min(shape[0], xs.max() + 1 + CROP_MARGIN)
    y0, y1 = max(0, ys.min() - CROP_MARGIN), min(shape[1], ys.max() + 1 + CROP_MARGIN)
    return int(x0), int(x1), int(y0), int(y1)


def choose_slices(wmh, voxel_mm3):
    """The slice selection rule. Returns the chosen slice numbers (0-based) and
    some numbers that explain the choice.

    1. Range: count the expert's WMH voxels per slice and take the slices
       that hold the middle 90 % of all WMH voxels (5 % to 95 %).
    2. Candidates: slices in that range with at least MIN_WMH_VOXELS expert
       voxels (if that leaves fewer than N_SLICES: every slice with WMH).
    3. Spread N_SLICES target positions evenly over the range and take for
       each target the nearest candidate that is still free.
    4. Largest lesion: the slice where the largest lesion of the scan has its
       largest cut must be among the chosen ones. If it is not, the nearest
       chosen slice is moved onto it.
    5. Small lesions: the candidate slice that shows the most small lesions
       (below SMALL_LESION_MM3) must be among the chosen ones, in the same way.
    """
    n_z = wmh.shape[2]
    wmh_per_slice = wmh.sum(axis=(0, 1))

    # 1. range
    cumulative = np.cumsum(wmh_per_slice) / wmh_per_slice.sum()
    z_first = int(np.argmax(cumulative >= 0.05))
    z_last = int(np.argmax(cumulative >= 0.95))

    # 2. candidates
    candidates = [z for z in range(z_first, z_last + 1) if wmh_per_slice[z] >= MIN_WMH_VOXELS]
    if len(candidates) < N_SLICES:
        candidates = [z for z in range(z_first, z_last + 1) if wmh_per_slice[z] > 0]
    n_wanted = min(N_SLICES, len(candidates))

    # 3. evenly spread
    chosen = []
    for target in np.linspace(z_first, z_last, n_wanted):
        free = [z for z in candidates if z not in chosen]
        chosen.append(min(free, key=lambda z: (abs(z - target), z)))

    # separate lesions = connected groups of WMH voxels (26-neighbourhood)
    labels, n_lesions = ndimage.label(wmh, structure=np.ones((3, 3, 3)))
    lesion_voxels = np.bincount(labels.ravel())
    lesion_voxels[0] = 0                                   # label 0 is the background

    # 4. largest lesion
    largest = int(np.argmax(lesion_voxels))
    z_largest = int(np.argmax((labels == largest).sum(axis=(0, 1))))

    # 5. small lesions
    small_labels = np.flatnonzero((lesion_voxels > 0) & (lesion_voxels * voxel_mm3 < SMALL_LESION_MM3))
    small_per_slice = [len(np.intersect1d(np.unique(labels[:, :, z]), small_labels)) for z in range(n_z)]
    z_small = max(candidates, key=lambda z: (small_per_slice[z], -z))
    if small_per_slice[z_small] == 0:
        z_small = None                                     # no small lesion in the range

    anchors = [z_largest] + ([z_small] if z_small is not None else [])
    for anchor in anchors:
        if anchor in chosen:
            continue
        movable = [z for z in chosen if z not in anchors]
        nearest = min(movable, key=lambda z: (abs(z - anchor), z))
        chosen[chosen.index(nearest)] = anchor

    chosen = sorted(chosen)
    info = dict(range_z=[z_first, z_last], z_largest_lesion=z_largest, z_most_small_lesions=z_small,
                small_lesions_shown=int(sum(small_per_slice[z] for z in chosen)),
                small_lesions_in_scan=int(len(small_labels)), lesions_in_scan=int(n_lesions))
    return chosen, info


# ---- main loop over the 110 patients ---------------------------------------
software = dict(
    python=platform.python_version(), nibabel=nib.__version__, numpy=np.__version__,
    scipy=scipy.__version__, pillow=PIL.__version__,
)
index_rows = []
cases_meta = {}

for row in table:
    case_id = row["id"]
    folder = TEST / "out" / case_id
    print("\n==", case_id)

    # -- 1. load ------------------------------------------------------------
    flair_img = nib.load(folder / "flair.nii.gz")
    flair = flair_img.get_fdata(dtype=np.float32)
    other = np.asanyarray(nib.load(folder / "other_pathology.nii.gz").dataobj) > 0   # label 2: not scored
    wmh = (np.asanyarray(nib.load(folder / "wmh_manual.nii.gz").dataobj) > 0) & ~other   # label 1: WMH
    brain = np.asanyarray(nib.load(folder / "brainmask.nii.gz").dataobj) > 0
    zooms = [float(v) for v in flair_img.header.get_zooms()[:3]]
    voxel_mm = [round(v, 4) for v in zooms]                # for display and brush size
    voxel_mm3 = zooms[0] * zooms[1] * zooms[2]
    voxel_ml = voxel_mm3 / 1000.0                          # volume of one voxel in millilitres

    # -- 2. check the orientation (see the header of this file) -------------
    axis_codes = "".join(nib.aff2axcodes(flair_img.affine))
    if axis_codes != "LPS":
        raise SystemExit(f"STOP: {case_id}: unexpected orientation {axis_codes}")

    # -- 3. choose the slices -----------------------------------------------
    z_list, why = choose_slices(wmh, voxel_mm3)
    print("slices (0-based):", z_list, "WMH voxels:", [int(wmh[:, :, z].sum()) for z in z_list], why)

    # -- 4. crop to the brain (same box for all slices of the patient) ------
    x0, x1, y0, y1 = crop_box(brain, flair.shape)
    width, height = x1 - x0, y1 - y0
    # nothing of the reference may be cut away
    assert wmh[x0:x1, y0:y1, :].sum() == wmh.sum(), f"{case_id}: crop cuts the reference"

    # -- 5. grey window: 1st to 99.9th percentile inside the brain ----------
    low, high = np.percentile(flair[brain], WINDOW_PERCENTILES)

    # -- 6. BIANCA on the same scan -----------------------------------------
    # Same recipe as bianca-film/code/17b_score_test110_best.py: probability
    # >= 0.90, other pathology ignored, inside the white matter mask, specks
    # smaller than 3 voxels removed.
    prob = np.asarray(nib.load(TEST / "bianca_best" / f"{case_id}_prob.nii.gz").dataobj, np.float32)
    wm_mask = np.asanyarray(nib.load(folder / "wm_mask_flairspace.nii.gz").dataobj) > 0
    bianca = (prob >= np.float32(BIANCA_THRESHOLD)) & ~other & wm_mask
    clusters, n_clusters = ndimage.label(bianca)
    sizes = ndimage.sum(bianca, clusters, range(1, n_clusters + 1))
    bianca = np.isin(clusters, np.flatnonzero(sizes >= BIANCA_MIN_CLUSTER) + 1)
    dice_whole = dice(bianca, wmh)
    # our re-computation must give the number stored by the BIANCA project
    if abs(dice_whole - bianca_whole_scan[case_id]) > 1e-6:
        raise SystemExit(f"STOP: {case_id}: BIANCA Dice {dice_whole} differs from the stored {bianca_whole_scan[case_id]}")
    assert bianca[x0:x1, y0:y1, :].sum() == bianca.sum(), f"{case_id}: crop cuts the BIANCA mask"
    dice_slices = dice(bianca[:, :, z_list], wmh[:, :, z_list])
    print(f"BIANCA Dice: whole scan {dice_whole:.4f} | the {len(z_list)} slices {dice_slices:.4f}")

    # -- 7. make the slices -------------------------------------------------
    slices = []
    for z in z_list:
        slices.append(dict(
            z=z,                                              # 0-based slice index in the scan
            png=picture_as_png(flair[x0:x1, y0:y1, z], low, high),
            ref=run_length(wmh[x0:x1, y0:y1, z].T),           # expert reference (WMH)
            ignore=run_length(other[x0:x1, y0:y1, z].T),      # other pathology (not scored)
            bianca=run_length(bianca[x0:x1, y0:y1, z].T),     # mask of the algorithm
            refVoxels=int(wmh[:, :, z].sum()),
        ))

    # -- 8. write the data file of this patient -----------------------------
    case = dict(
        id=case_id,
        scanner=row["scanner"],
        width=width, height=height,
        voxelMm=voxel_mm,
        voxelMl=voxel_ml,
        nSlicesInScan=int(flair.shape[2]),
        orientation=axis_codes,
        slices=slices,
    )
    text = ("// Made by build/01_prepare_cases.py - do not edit by hand.\n"
            "// Data: MICCAI WMH Segmentation Challenge (Kuijf et al., IEEE TMI 2019), CC BY-NC 4.0.\n"
            "window.WMH_CASES = window.WMH_CASES || {};\n"
            f"window.WMH_CASES[{json.dumps(case_id)}] = {json.dumps(case, separators=(',', ':'))};\n")
    out_file = DATA / f"case_{case_id}.js"
    out_file.write_text(text)
    size_kb = out_file.stat().st_size / 1024
    print("wrote", out_file.name, f"{size_kb:.0f} KB", f"picture {width} x {height}")

    index_rows.append(dict(
        id=case_id,
        site=row["site"],
        scanner=row["scanner"],
        scannerInTraining=row["scanner_in_bianca_training"] == "True",
        wmhMl=float(row["wmh_ml"]),                 # expert WMH volume of the whole scan
        load=row["lesion_load"],                    # small / medium / large
        nSlices=len(z_list),
        biancaDice=round(dice_slices, 4),           # BIANCA on the slices of the trainer
        biancaDiceWholeScan=round(dice_whole, 4),
    ))
    cases_meta[case_id] = dict(crop_x=[x0, x1], crop_y=[y0, y1], slices_z=z_list, voxel_mm=voxel_mm,
                               width=width, height=height, file_kb=round(size_kb, 1),
                               bianca_dice_slices=dice_slices, bianca_dice_whole_scan=dice_whole, **why)

# ---- the index of all patients ----------------------------------------------
index = dict(
    nCases=len(index_rows),
    slicesPerCase=N_SLICES,
    loadClasses=dict(small="less than 5 ml", medium="5 to 15 ml", large="15 ml or more"),
    bianca=dict(threshold=BIANCA_THRESHOLD, minClusterVoxels=BIANCA_MIN_CLUSTER, trainingScans=60,
                meanDiceSlices=round(float(np.mean([r["biancaDice"] for r in index_rows])), 4),
                meanDiceWholeScan=round(float(np.mean([r["biancaDiceWholeScan"] for r in index_rows])), 4)),
    window=dict(percentiles=WINDOW_PERCENTILES),
    orientation="LPS",
    software=software,
)
lines = ",\n".join("  " + json.dumps(r, separators=(",", ":")) for r in index_rows)
text = ("// Made by build/01_prepare_cases.py - do not edit by hand.\n"
        "// Data: MICCAI WMH Segmentation Challenge (Kuijf et al., IEEE TMI 2019), CC BY-NC 4.0.\n"
        f"window.WMH_INDEX = {json.dumps(index, indent=1)};\n"
        f"window.WMH_INDEX.cases = [\n{lines}\n];\n")
(DATA / "cases.js").write_text(text)
(BUILD / "cases_meta.json").write_text(json.dumps(cases_meta, indent=1))

# ---- the example slice of the tutorial ---------------------------------------
flair_img = nib.load(TUTORIAL_FOLDER / "flair.nii.gz")
assert "".join(nib.aff2axcodes(flair_img.affine)) == "LPS"
flair = flair_img.get_fdata(dtype=np.float32)
other = np.asanyarray(nib.load(TUTORIAL_FOLDER / "other_pathology.nii.gz").dataobj) > 0
wmh = (np.asanyarray(nib.load(TUTORIAL_FOLDER / "wmh_manual.nii.gz").dataobj) > 0) & ~other
brain = np.asanyarray(nib.load(TUTORIAL_FOLDER / "brainmask.nii.gz").dataobj) > 0
x0, x1, y0, y1 = crop_box(brain, flair.shape)
low, high = np.percentile(flair[brain], WINDOW_PERCENTILES)
z = int(np.argmax(wmh.sum(axis=(0, 1))))                   # the slice with the most WMH
tutorial = dict(width=x1 - x0, height=y1 - y0, z=z,
                voxelMm=[round(float(v), 4) for v in flair_img.header.get_zooms()[:3]],
                png=picture_as_png(flair[x0:x1, y0:y1, z], low, high),
                ref=run_length(wmh[x0:x1, y0:y1, z].T))
text = ("// Made by build/01_prepare_cases.py - do not edit by hand.\n"
        "// Example slice of the tutorial: one of the 60 training scans of the\n"
        "// MICCAI WMH Segmentation Challenge (Kuijf et al., IEEE TMI 2019), CC BY-NC 4.0.\n"
        f"window.WMH_TUTORIAL = {json.dumps(tutorial, separators=(',', ':'))};\n")
(DATA / "tutorial.js").write_text(text)

# ---- summary on the screen ---------------------------------------------------
n_slices = sum(r["nSlices"] for r in index_rows)
total_kb = sum(f.stat().st_size for f in DATA.glob("*.js")) / 1024
print("\npatients:", len(index_rows), "| slices:", n_slices)
print("mean BIANCA Dice on the chosen slices:", index["bianca"]["meanDiceSlices"],
      "| whole scan:", index["bianca"]["meanDiceWholeScan"])
print(f"data folder: {total_kb / 1024:.1f} MB, {total_kb / n_slices:.1f} KB per slice")
print("software:", software)
