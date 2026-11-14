---
section: security
---

- **Remote images in Markdown wait for a click.** An image from another host in an agent or PM reply, a GitHub issue or pull request body, a comment, an inbox item or release notes now shows a placeholder naming its host. **Load image** fetches it through CodeDen's server, which contacts only public internet addresses and passes on only images. Before, the image loaded as soon as the reply was shown, so a prompt-injected agent could send data to any host just by being read. Inline images and CodeDen's own stored files still show at once.
- **Links in Markdown show where they go.** Clicking one opens a dialog with its real address, **Copy link** and **Open link**; `javascript:` and `data:` links stay refused.
- **The UI has a Content-Security-Policy.** The server sends it, and the desktop app sets it on its window: images only from CodeDen, `data:` and `blob:`, scripts only from CodeDen's own files, connections only to CodeDen, and no framing by other sites.
