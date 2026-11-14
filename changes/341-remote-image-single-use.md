---
section: security
---

- **Load image allows only the exact URL you clicked.** If an image's URL changes after you loaded it, for example when the author of a GitHub issue edits its body, the placeholder comes back and the new image needs its own click. Before, the new URL loaded without one.
- **Only your click fetches a remote image.** **Load image** now asks the server for a single-use id for that URL, valid for a minute, and the image loads from that id. A plain `<img src="/api/remote-image?url=…">` that slipped into Markdown or other HTML, or an unknown, expired or used id, gets 404 and fetches nothing, so CodeDen's own address can't be used to get around its Content-Security-Policy.
