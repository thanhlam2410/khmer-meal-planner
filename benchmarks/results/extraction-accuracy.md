# Extraction accuracy (model-vs-model)

Generated 2026-10-02T05:55:32+00:00 by `benchmarks/extraction_accuracy.py` from `data/cache/crosscheck/`.

Sample: 10 of 31 images, 165 items. Claude Opus 5.5 judged each extracted item against the menu image (true/false per field). rate = agreed / judged; 95% Wilson interval. Model-vs-model agreement, not human ground truth.

| Field | Predicted | Agreed | Rate | 95% CI |
|---|---|---|---|---|
| Item exists | — | 165/165 | 100.0% | 97.7–100.0% |
| Khmer spelling | 60–75% | 145/165 | 87.9% | 82.0–92.0% |
| English meaning | 85–90% | 153/165 | 92.7% | 87.7–95.8% |
| Price | 88–93% | 160/165 | 97.0% | 93.1–98.7% |
| Category | 90–95% | 160/165 | 97.0% | 93.1–98.7% |
| All fields | — | 131/165 | 79.4% | 72.6–84.9% |

Missing items reported: 2. Price disputes come from: 2026-07-21_11-16-25.

## Per image

| Image | Items | Exists | Khmer | English | Price | Category | Missing |
|---|---|---|---|---|---|---|---|
| 2026-07-20_22-23-50.png | 9 | 100.0 | 88.9 | 88.9 | 100.0 | 88.9 | 0 |
| 2026-07-20_22-24-59.png | 15 | 100.0 | 66.7 | 100.0 | 100.0 | 100.0 | 0 |
| 2026-07-20_22-27-14.png | 35 | 100.0 | 94.3 | 94.3 | 100.0 | 100.0 | 0 |
| 2026-07-20_22-31-05.png | 6 | 100.0 | 100.0 | 83.3 | 100.0 | 100.0 | 0 |
| 2026-07-20_22-31-15.png | 6 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 0 |
| 2026-07-20_22-36-45.png | 9 | 100.0 | 88.9 | 88.9 | 100.0 | 100.0 | 0 |
| 2026-07-20_22-43-25.png | 9 | 100.0 | 77.8 | 100.0 | 100.0 | 100.0 | 0 |
| 2026-07-20_22-47-26.png | 15 | 100.0 | 80.0 | 86.7 | 100.0 | 93.3 | 0 |
| 2026-07-21_11-15-08.png | 45 | 100.0 | 91.1 | 88.9 | 100.0 | 93.3 | 1 |
| 2026-07-21_11-16-25.png | 16 | 100.0 | 87.5 | 100.0 | 68.8 | 100.0 | 1 |
