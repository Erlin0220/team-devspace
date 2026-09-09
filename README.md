# Team DevSpace

Team-oriented distribution and connectivity layer for DevSpace.

The project is intended to provide one-click Windows and macOS installation for employees while keeping the upstream DevSpace runtime pinned and replaceable. The initial MVP will use the official `@waishnav/devspace` v1.0.8 release, start the local DevSpace service, establish the Cloudflare connectivity layer, and let each employee connect the shared ChatGPT workspace app to their own machine with an assigned access key.

## Principles

- Keep upstream DevSpace unmodified whenever possible.
- Prefer mature platform capabilities over custom infrastructure.
- Turn installation, startup, enrollment, and reconnect steps into stable automated actions.
- Keep employee machines isolated: one user's ChatGPT connection must only reach that user's local DevSpace.
- Do not depend on an administrator workstation being online.
