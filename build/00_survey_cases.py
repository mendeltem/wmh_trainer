# 00_survey_cases.py
# ---------------------------------------------------------------------------
# Step 0: look at every one of the 110 official TEST scans of the MICCAI WMH
#         Segmentation Challenge and write one table row per scan.
#
# Input : the prepared public challenge scans (READ-ONLY), one folder per scan:
#             <CHALLENGE>/test110/out/<id>/flair.nii.gz            FLAIR picture
#             <CHALLENGE>/test110/out/<id>/wmh_manual.nii.gz       expert mask, label 1 (WMH)
#             <CHALLENGE>/test110/out/<id>/other_pathology.nii.gz  expert mask, label 2 (not scored)
#             <CHALLENGE>/test110/out/<id>/brainmask.nii.gz        brain mask (for crop and grey window)
#             <CHALLENGE>/test110/out/<id>/wm_mask_flairspace.nii.gz  white matter mask (BIANCA step)
#             <CHALLENGE>/test110/bianca_best/<id>_prob.nii.gz     BIANCA probability map
#         <CHALLENGE>/test110/cases110.tsv                         list of the 110 scan names
#         <CHALLENGE>/film_data_test110_best.json                  BIANCA scores, whole scan
# Output: build/case_table.tsv   (one row per scan: volume, lesion load class, ...)
#
# Run   : WMH_CHALLENGE_DIR=/path/to/prepared/challenge/copy python build/00_survey_cases.py
#
# The script STOPS with a clear message if a scan or a BIANCA result is
# missing. It never uses other data instead.
# ---------------------------------------------------------------------------
import csv
import json
import os
from pathlib import Path

import nibabel as nib
import numpy as np
from scipy import ndimage

# ---- settings --------------------------------------------------------------
# Folder with the prepared public challenge data. Another place can be given
# with the environment variable WMH_CHALLENGE_DIR.
CHALLENGE = Path(os.environ.get("WMH_CHALLENGE_DIR", "challenge_copy"))
TEST = CHALLENGE / "test110"
OUT = Path(__file__).resolve().parent                  # the build/ folder

# Lesion load classes by the WMH volume of the whole scan.
# This is a convention of this trainer (close to the thirds of the 110 scans),
# NOT a value from the literature.
SMALL_BELOW_ML = 5.0       # small : less than 5 ml
LARGE_FROM_ML = 15.0       # large : 15 ml or more;  medium: in between
SMALL_LESION_MM3 = 30.0    # a single lesion below 30 mm3 counts as a "small lesion"

# Scanner of every test site, from the readme.pdf of the data set
# (table "Details") and Kuijf et al. 2019. The last two scanners were NOT
# part of the 60 training scans, so BIANCA has never seen them.
SITES = {
    "Utrecht":             dict(scanner="3 T Philips Achieva (UMC Utrecht)", in_training=True),
    "Singapore":           dict(scanner="3 T Siemens TrioTim (NUHS Singapore)", in_training=True),
    "Amsterdam_GE3T":      dict(scanner="3 T GE Signa HDxt (VU Amsterdam)", in_training=True),
    "Amsterdam_PhilipsVU": dict(scanner="3 T Philips Ingenuity (VU Amsterdam)", in_training=False),
    "Amsterdam_GE1T5":     dict(scanner="1.5 T GE Signa HDxt (VU Amsterdam)", in_training=False),
}

# ---- 1. read the list of scans and the BIANCA scores ------------------------
case_ids = [line.split("\t")[0] for line in (TEST / "cases110.tsv").read_text().splitlines() if line.strip()]
if len(case_ids) != 110:
    raise SystemExit(f"STOP: expected 110 test scans in cases110.tsv, found {len(case_ids)}")

film = json.loads((CHALLENGE / "film_data_test110_best.json").read_text())
if film["n"] != 110 or film["missing"]:
    raise SystemExit("STOP: film_data_test110_best.json does not hold BIANCA results for all 110 test scans")
bianca_whole_scan = {c["id"]: c["dice_final"] for c in film["cases"]}

# ---- 2. measure every scan -------------------------------------------------
NEEDED = ["flair.nii.gz", "wmh_manual.nii.gz", "other_pathology.nii.gz", "brainmask.nii.gz", "wm_mask_flairspace.nii.gz"]
table = []
for case_id in case_ids:
    folder = TEST / "out" / case_id
    prob_file = TEST / "bianca_best" / f"{case_id}_prob.nii.gz"
    missing = [name for name in NEEDED if not (folder / name).exists()]
    if not prob_file.exists():
        missing.append(prob_file.name)
    if missing or case_id not in bianca_whole_scan:
        raise SystemExit(f"STOP: {case_id}: missing {missing or 'BIANCA score'}")

    # which site? (longest matching name first, so "Amsterdam_GE3T" wins over "Amsterdam")
    site = next(s for s in sorted(SITES, key=len, reverse=True) if case_id.startswith(s))

    flair_img = nib.load(folder / "flair.nii.gz")
    other = np.asanyarray(nib.load(folder / "other_pathology.nii.gz").dataobj) > 0
    wmh = (np.asanyarray(nib.load(folder / "wmh_manual.nii.gz").dataobj) > 0) & ~other
    prob_shape = nib.load(prob_file).shape
    if not (flair_img.shape == wmh.shape == other.shape == prob_shape):
        raise SystemExit(f"STOP: {case_id}: picture, masks and BIANCA map have different sizes")

    voxel_mm = [float(v) for v in flair_img.header.get_zooms()[:3]]
    voxel_mm3 = voxel_mm[0] * voxel_mm[1] * voxel_mm[2]
    wmh_ml = float(wmh.sum() * voxel_mm3 / 1000.0)

    # separate lesions = connected groups of WMH voxels (26-neighbourhood)
    labels, n_lesions = ndimage.label(wmh, structure=np.ones((3, 3, 3)))
    lesion_mm3 = np.bincount(labels.ravel())[1:] * voxel_mm3

    if wmh_ml < SMALL_BELOW_ML:
        load = "small"
    elif wmh_ml < LARGE_FROM_ML:
        load = "medium"
    else:
        load = "large"

    table.append(dict(
        id=case_id, site=site, scanner=SITES[site]["scanner"],
        scanner_in_bianca_training=SITES[site]["in_training"],
        orientation="".join(nib.aff2axcodes(flair_img.affine)),
        size_x=flair_img.shape[0], size_y=flair_img.shape[1], n_slices=flair_img.shape[2],
        voxel_mm="x".join(f"{v:.2f}" for v in voxel_mm),
        wmh_ml=round(wmh_ml, 2), lesion_load=load,
        n_lesions=int(n_lesions),
        n_small_lesions=int((lesion_mm3 < SMALL_LESION_MM3).sum()),
        largest_lesion_ml=round(float(lesion_mm3.max() / 1000.0), 2),
        n_slices_with_wmh=int((wmh.sum(axis=(0, 1)) > 0).sum()),
        other_pathology_voxels=int(other.sum()),
        bianca_dice_whole_scan=round(bianca_whole_scan[case_id], 4),
    ))
    print(table[-1])

# ---- 3. write the table ----------------------------------------------------
with open(OUT / "case_table.tsv", "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=list(table[0]), delimiter="\t")
    writer.writeheader()
    writer.writerows(table)

print("\nscans:", len(table))
for load in ("small", "medium", "large"):
    print(f"lesion load {load}:", sum(1 for r in table if r["lesion_load"] == load))
print("orientations:", sorted(set(r["orientation"] for r in table)))
print("fewest slices with WMH in one scan:", min(r["n_slices_with_wmh"] for r in table))
print("wrote", OUT / "case_table.tsv")
