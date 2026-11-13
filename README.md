# WMH Rater Trainer

A small web page for practising the segmentation of **white matter hyperintensities (WMH)**
on FLAIR MRI. You paint the WMH on a few slices of a patient, press **Score**, and see

- your **Dice score** against the expert's mask (per slice and over all slices),
- the overlay of what you **hit**, what you painted **extra** and what you **missed**,
- the Dice of an automatic method (**BIANCA**, FSL) on the same slices, with a clear line
  "You beat the algorithm" or "The algorithm was better this time".

Then you press **Next patient** and go on, for as long as you like. There are 110 patients.

**Open the trainer:** https://mendeltem.github.io/wmh_trainer/

**For teaching only. Not a medical device. Not for diagnosis or any clinical decision.**

## How to use

Open `index.html` in a browser. Nothing has to be installed and no internet is needed; the page
also works when the folder is served as a static site (for example GitHub Pages).

1. The page opens a random patient. A short tutorial (3 steps) is shown on the first visit; it can
   be opened again with the **Tutorial** button. The longer **How to** panel is closed until you open it.
2. Paint the WMH on each of the 6 slices (brush, eraser, undo, zoom, brightness and contrast).
   Mark only WMH, no other lesions.
3. Press **Score**. The expert's mask is shown and the patient is locked.
4. Press **Next patient** for another random patient. No patient is repeated until all 110 are done.

Other things on the page:

- **Choose patient**: the list of all 110 patients. It can be sorted by WMH volume, lesion load,
  the algorithm's Dice and your own scores, and filtered by lesion load.
- **My progress**: patients done, mean Dice, how often you beat the algorithm, best score and a
  small chart of the last scores. The numbers use the **first try** of every patient, so trying a
  patient again does not polish the statistics (a better try becomes your best score).
- **Reset my progress** removes all scores on this device (after a confirmation in the page).
- A link of the form `index.html?patient=Utrecht_10` opens one given patient (the names are in the
  patient list, with `_` instead of spaces).
- Progress and the mask you are working on are kept in the browser of this device only
  (`localStorage`). Nothing is uploaded. If the browser blocks storage the page still works,
  it only forgets the progress when it is closed.

On a phone or tablet: one finger paints, two fingers zoom and move the picture, the **Fit** button
shows the whole slice again. The column to the right of the picture holds the most used tools and a
free margin; a swipe that starts there scrolls the page.

Keys on a laptop: `B` brush, `E` eraser, `M` move, `Z` undo, `H` hide the mask, `[` `]` brush size,
left and right arrow for the previous and next slice. Mouse wheel zooms.

### How the score is counted

`Dice = 2 TP / (2 TP + FP + FN)`, counted in voxels over the 6 slices shown (not the whole brain).
TP = painted by you and by the expert, FP = only by you, FN = only by the expert. Voxels that the
challenge marked as "other pathology" are not scored, for you and for the algorithm alike (they
are shown in grey after scoring). An empty mask gives a Dice of 0.

## Data, credit and licence

The pictures and expert masks come from the **MICCAI WMH Segmentation Challenge**
(<https://wmh.isi.uu.nl/>). This page uses the 110 official **test** scans of the challenge
(Utrecht, Singapore and three scanners in Amsterdam).

- Data: Kuijf, Hugo; Biesbroek, Matthijs; de Bresser, Jeroen; et al.
  "Data of the White Matter Hyperintensity (WMH) Segmentation Challenge", DataverseNL,
  <https://doi.org/10.34894/AECRSD>, licence **CC BY-NC 4.0**
  (<https://creativecommons.org/licenses/by-nc/4.0/>).
- Please cite: Kuijf HJ, Biesbroek JM, de Bresser J, et al. "Standardized Assessment of Automatic
  Segmentation of White Matter Hyperintensities and Results of the WMH Segmentation Challenge."
  IEEE Transactions on Medical Imaging 38(11):2556-2568, 2019.
  <https://doi.org/10.1109/TMI.2019.2905770>

The files in `data/` are **derived** from this data set: single axial FLAIR slices, cropped to the
brain, reduced to 8 bit, together with the manual masks and the mask of the algorithm on these
slices. They are shared under the same licence, **CC BY-NC 4.0: credit the challenge as above,
non-commercial use only**. The same credit is shown in the footer of the page.

**Code licence:** the code of this repository (`index.html` and the build scripts `build/*.py`, `build/*.mjs`) is under the
**MIT licence** (`LICENSE`): free to use, change and share, also commercially, with the copyright notice. The MIT licence does
not cover the data: everything derived from the scans (`data/`, `build/screenshots/`, the case tables and JSON files in `build/`)
stays under CC BY-NC 4.0 (`data/LICENSE.md`).

The expert masks are the manual reference standard of the challenge (WMH = label 1; other
pathology = label 2, not scored). The algorithm is BIANCA (Griffanti et al., NeuroImage 2016;
part of FSL), trained on the 60 training scans of the same challenge. Two of the five test
scanners (Amsterdam 1.5 T GE and Amsterdam 3 T Philips Ingenuity) were not among its training
scans; the patient list marks them as "new to BIANCA".

## Folder layout

```
index.html                      the page (one file, no external libraries)
data/cases.js                   small index of the 110 patients (loaded at the start)
data/case_<id>.js               one file per patient, loaded only when the patient is opened
data/tutorial.js                example slice of the tutorial, loaded only when the tutorial opens
build/00_survey_cases.py        step 0: one table row per test scan
build/01_prepare_cases.py       step 1: choose the slices, write the files in data/
build/02_make_test_expectations.py   step 2: the right answers for the page test
build/03_test_page.mjs          step 3: test of the page in a headless browser
build/case_table.tsv            table from step 0
build/cases_meta.json           slice numbers and crop box from step 1
build/test_expected.json        numbers from step 2
build/screenshots/              pictures taken by the page test (PNG)
```

## How the data files were made

Only `index.html` and `data/` are needed to use the page. The scripts in `build/` document how the
files in `data/` were made and can make them again. They are plain numbered scripts, to be run in
this order from the folder of this README:

```
python build/00_survey_cases.py
python build/01_prepare_cases.py
python build/02_make_test_expectations.py
node   build/03_test_page.mjs
```

The Python scripts need `numpy`, `scipy`, `nibabel` and `pillow`. They read a prepared copy of the
public challenge data; its place is set with the environment variable `WMH_CHALLENGE_DIR`. For
every test scan this copy holds the FLAIR picture, the two expert label masks, a brain mask, a
white matter mask and the probability map of BIANCA. Making the brain mask, the white matter mask
and the BIANCA probability maps (FSL) is not part of this repository. The scripts stop with a
message if a scan or a BIANCA result is missing; they never use other data instead.

**Slices.** Every patient has 6 axial slices, chosen by this rule:

1. The range of slices that holds the middle 90 % of the expert's WMH voxels (from 5 % to 95 % of
   the cumulative count from bottom to top).
2. Candidates are the slices in this range with at least 5 WMH voxels.
3. 6 targets are spread evenly over the range and each is moved to the nearest free candidate.
4. The slice with the largest cross-section of the largest lesion is always included.
5. The slice that shows the most small lesions (below 30 mm³) is always included.

**Pictures.** Each slice is cropped to the brain mask plus 12 voxels, the grey values are windowed
from the 1st to the 99.9th percentile inside the brain mask and stored as an 8-bit PNG inside the
JavaScript file (about 26 KB per slice on average). The front of the head is at the top; the right
side of the picture is the patient's left. Voxels that are not square are drawn with their true
proportions.

**Algorithm mask.** BIANCA probability of 0.90 or more, inside the white matter mask, not on
"other pathology", clusters smaller than 3 voxels removed (counted in 3D). The Dice of BIANCA shown
on the page is counted on the same 6 slices as yours. Its mean over the 110 patients is 0.72 on
these slices (0.70 over the whole scans).

**Lesion load.** "small" is less than 5 ml of WMH in the whole scan, "medium" 5 to 15 ml, "large"
15 ml or more (41 / 34 / 35 patients). These limits are a convention of this trainer, chosen close
to the thirds of the 110 scans; they are not taken from the literature.

**Tutorial picture.** The example slice of the tutorial comes from one of the 60 training scans of
the same challenge, so no answer of the 110 trainer patients is given away.

## Test

`build/03_test_page.mjs` opens the page in a headless Chromium (package `playwright`; the places
of the package and of the browser can be set with `PLAYWRIGHT_DIR` and `CHROMIUM_PATH`). It goes
through all 110 patients and compares what the page shows with numbers computed independently in
Python from the original label files (step 2): the expert's exact mask must give a Dice of 1.000,
an empty mask 0, known partly wrong masks the expected values, and BIANCA's Dice must match for
every patient. It also checks the "Next patient" order, the saved progress after a reload, old and
broken saved states, the patient list, the page without browser storage, a missing data file, and
the layout and painting by touch on a phone (390 x 844) and on other window sizes.
