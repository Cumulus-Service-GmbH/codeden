---
section: security
---

- **MDX and SVG files are reviewed in the docs pipeline.** A docs pull request that changed only `.mdx` or `.svg` files merged without the independent review. MDX runs JSX and imports when a docs site builds, and an SVG can carry scripts, so both are now reviewed like code. Plain prose (`.md`, `.txt`, `.rst`) and raster images (`.png`, `.jpg`, `.gif`, `.webp`, `.ico`) still skip the review.
- **License files always go to a person.** `LICENSE`, `LICENCE`, `UNLICENSE`, `COPYING` and `NOTICE` (bare, as `.md` or `.txt`, or with a variant such as `LICENSE-MIT`) at any depth, and anything in a `LICENSES/` folder, are now always protected, like `.codeden/`. A pull request that changes one is escalated and never merged automatically, whatever the vision lists. Before, `LICENSE.md` and `LICENSE.txt` counted as documentation and could merge without a review.
