---
section: security
---

- **A session's Markdown export hides secrets.** **Copy as Markdown** and **Download as Markdown** replace anything that looks like a secret with `[redacted]`, and the file's summary says how many values were hidden. This covers GitHub, OpenAI, Anthropic, AWS, Slack and other token formats, JSON Web Tokens, bearer tokens, passwords in URLs, private keys, values of secret-named settings such as `GITHUB_TOKEN=…` or `--password …`, and your CodeDen install token. Both menu items now say "Secrets redacted". A literal `</details>` in a message can no longer close a subagent's folded block early.
