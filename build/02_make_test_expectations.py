# 02_make_test_expectations.py
# ---------------------------------------------------------------------------
# Step 2: compute the "right answers" for the page test, in Python, WITHOUT
#         using any code of the web page and WITHOUT reading the data files
#         that step 1 wrote for the page.
#
# The page test (03_test_page.mjs) opens every patient in the page, paints
# known masks and compares the numbers shown by the page with the numbers
# computed here.
#
# Input : the ORIGINAL challenge label files (READ-ONLY)
#             <CHALLENGE>/test110/src/challenge-test/<site>/<number>/wmh.nii.gz
#             (label 1 = WMH, label 2 = other pathology)
#         the BIANCA probability maps and white matter masks (READ-ONLY)
#         build/cases_meta.json (slice numbers and crop box from step 1)
# Output: build/test_expected.json
#
# Run   : WMH_CHALLENGE_DIR=/path/to/prepared/challenge/copy python build/02_make_test_expectations.py
#
# For every patient:   voxels of the reference per slice, and the score of
#                      BIANCA on the chosen slices (per slice and together).
# For a few patients:  a "partial" test mask = the expert reference moved
#                      2 voxels to the right plus a fixed rectangle, so a mask
#                      that is partly right and partly wrong, with its score.
#                      The patients are chosen so that at least two of them
#                      have real "other pathology" on their slices (this tests
#                      the rule that such voxels are ignored).
# ---------------------------------------------------------------------------
import json
import os
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

# ---- settings --------------------------------------------------------------
CHALLENGE = Path(os.environ.get("WMH_CHALLENGE_DIR", "challenge_copy"))
TEST = CHALLENGE / "test110"
BUILD = Path(__file__).resolve().parent
SHIFT_X = 2                                # the partial mask is the reference moved by 2 voxels
RECT = dict(x0=30, x1=42, y0=40, y1=48)    # extra rectangle in the partial mask (voxels)
BIANCA_THRESHOLD = 0.90
BIANCA_MIN_CLUSTER = 3
N_PARTIAL_PLAIN = 3                        # patients without other pathology on their slices
N_PARTIAL_IGNORE = 2                       # patients with other pathology on their slices

cases_meta = json.loads((BUILD / "cases_meta.json").read_text())
# id -> folder of the original challenge files, e.g. "Amsterdam/GE1T5/150"
original_folder = dict(line.split("\t") for line in (TEST / "cases110.tsv").read_text().splitlines() if line.strip())


# ---- helpers ---------------------------------------------------------------
def run_length(mask_2d):
    """start, length, start, length ... (row by row, index = row * width + column)."""
    flat = mask_2d.ravel().astype(np.int8)
    change = np.diff(np.concatenate([[0], flat, [0]]))
    starts = np.flatnonzero(change == 1)
    ends = np.flatnonzero(change == -1)
    runs = []
    for s, e in zip(starts, ends):
        runs += [int(s), int(e - s)]
    return runs


def score(own_list, ref_list, ignore_list, voxel_ml):
    """Count TP, FP, FN over several slices; ignored voxels are left out."""
    tp = fp = fn = ignored_painted = 0
    for own, ref, ignore in zip(own_list, ref_list, ignore_list):
        keep = ~ignore
        tp += int((own & ref & keep).sum())
        fp += int((own & ~ref & keep).sum())
        fn += int((~own & ref & keep).sum())
        ignored_painted += int((own & ignore).sum())
    total = 2 * tp + fp + fn
    return dict(
        tp=tp, fp=fp, fn=fn, ignored_painted=ignored_painted,
        dice=(2 * tp / total) if total else None,
        sensitivity=(tp / (tp + fn)) if tp + fn else None,
        precision=(tp / (tp + fp)) if tp + fp else None,
        own_ml=(tp + fp) * voxel_ml,
        ref_ml=(tp + fn) * voxel_ml,
    )


# ---- loop over the 110 patients ---------------------------------------------
expected = dict(cases={}, partial={})
plain_done = ignore_done = 0

for case_id, meta in cases_meta.items():
    labels = np.asanyarray(nib.load(TEST / "src" / "challenge-test" / original_folder[case_id] / "wmh.nii.gz").dataobj)
    labels = np.rint(labels).astype(np.int16)
    wmh3 = labels == 1                         # label 1: WMH
    other3 = labels == 2                       # label 2: other pathology (not scored)
    zooms = nib.load(TEST / "out" / case_id / "flair.nii.gz").header.get_zooms()[:3]
    voxel_ml = float(zooms[0]) * float(zooms[1]) * float(zooms[2]) / 1000.0

    # BIANCA mask, same recipe as bianca-film/code/17b_score_test110_best.py
    prob = np.asarray(nib.load(TEST / "bianca_best" / f"{case_id}_prob.nii.gz").dataobj, np.float32)
    wm_mask = np.asanyarray(nib.load(TEST / "out" / case_id / "wm_mask_flairspace.nii.gz").dataobj) > 0
    bianca3 = (prob >= np.float32(BIANCA_THRESHOLD)) & ~other3 & wm_mask
    clusters, n_clusters = ndimage.label(bianca3)
    sizes = np.bincount(clusters.ravel(), minlength=n_clusters + 1)
    keep_labels = np.flatnonzero(sizes >= BIANCA_MIN_CLUSTER)
    keep_labels = keep_labels[keep_labels > 0]
    bianca3 = np.isin(clusters, keep_labels)

    x0, x1 = meta["crop_x"]
    y0, y1 = meta["crop_y"]
    refs, ignores, biancas = [], [], []
    for z in meta["slices_z"]:
        refs.append(wmh3[x0:x1, y0:y1, z].T)       # [row, column], same as the page
        ignores.append(other3[x0:x1, y0:y1, z].T)
        biancas.append(bianca3[x0:x1, y0:y1, z].T)
    nothing = [np.zeros_like(r) for r in refs]

    bianca_score = score(biancas, refs, ignores, voxel_ml)
    expected["cases"][case_id] = dict(
        width=meta["width"], height=meta["height"], voxel_ml=voxel_ml, slices_z=meta["slices_z"],
        ref_voxels=[int(r.sum()) for r in refs],
        ignore_voxels=[int(i.sum()) for i in ignores],
        reference=score(refs, refs, ignores, voxel_ml),
        nothing=score(nothing, refs, ignores, voxel_ml),
        bianca=bianca_score,
        bianca_per_slice=[score([b], [r], [i], voxel_ml)["dice"] for b, r, i in zip(biancas, refs, ignores)],
    )

    # a partial test mask for a few patients
    n_ignore = sum(int(i.sum()) for i in ignores)
    want = (n_ignore > 0 and ignore_done < N_PARTIAL_IGNORE) or (n_ignore == 0 and plain_done < N_PARTIAL_PLAIN)
    if want:
        partials = []
        for ref, ignore in zip(refs, ignores):
            partial = np.zeros_like(ref)
            partial[:, SHIFT_X:] = ref[:, :-SHIFT_X]
            partial[RECT["y0"]:RECT["y1"], RECT["x0"]:RECT["x1"]] = True
            partial |= ignore                       # also paint over the other pathology: must not count
            partials.append(partial)
        s = score(partials, refs, ignores, voxel_ml)
        if n_ignore > 0:
            assert s["ignored_painted"] == n_ignore
            ignore_done += 1
        else:
            plain_done += 1
        expected["partial"][case_id] = dict(
            partial_rle=[run_length(m) for m in partials],
            score=s,
            per_slice=[score([m], [r], [i], voxel_ml)["dice"] for m, r, i in zip(partials, refs, ignores)],
            # reference plus all ignored voxels painted: still a perfect score
            reference_plus_ignore=score([r | i for r, i in zip(refs, ignores)], refs, ignores, voxel_ml),
            beats_bianca=s["dice"] > bianca_score["dice"],
        )
        print(f"partial mask for {case_id}: TP {s['tp']} FP {s['fp']} FN {s['fn']} Dice {s['dice']:.4f} "
              f"| BIANCA {bianca_score['dice']:.4f} | painted on other pathology: {s['ignored_painted']}")

assert plain_done == N_PARTIAL_PLAIN and ignore_done == N_PARTIAL_IGNORE
dices = [c["bianca"]["dice"] for c in expected["cases"].values()]
expected["mean_bianca_dice_slices"] = float(np.mean(dices))
print("patients:", len(expected["cases"]), "| mean BIANCA Dice on the chosen slices:", round(float(np.mean(dices)), 4))
print("patients with other pathology on their slices:",
      sum(1 for c in expected["cases"].values() if sum(c["ignore_voxels"]) > 0))

(BUILD / "test_expected.json").write_text(json.dumps(expected, separators=(",", ":")))
print("wrote", BUILD / "test_expected.json")
