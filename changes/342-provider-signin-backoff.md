---
section: fixed
---

- **The factory stops retrying a provider whose login expired every 30 minutes.** When a factory session fails because its provider isn't signed in (such as OpenCode answering `Request failed: 401` for an expired OpenAI login), new factory work now skips that provider until its login changes, instead of trying it again every half hour and failing each time:
  - The provider is used again once detection sees a different login (signed out and in again, another account, a new expiry), when you press **Check now** on the factory panel or **Retry** a failed run on it, or after 6 hours in case the change can't be seen.
  - The back-off survives a restart, so restarting CodeDen no longer triggers a fresh failure.
  - You get one inbox item per provider, such as "OpenCode isn't signed in (openai/gpt-5.5): run `opencode auth login`", instead of a "Run failed" item for every pull request. Later failures update it, and it closes by itself once a factory session on that provider works again.
  - Usage limits and failed starts still back off for a set time.
