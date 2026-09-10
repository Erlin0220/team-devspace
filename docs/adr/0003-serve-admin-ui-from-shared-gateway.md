# Serve Admin UI from the shared Gateway

Team DevSpace serves `/admin*` from the existing Gateway Worker and protects that path with a project-owned Cloudflare Access self-hosted Application. The Worker also validates the Access JWT signature, issuer and Application AUD instead of trusting forwarded header presence alone. The Admin Web adapter and the existing `ADMIN_TOKEN` CLI adapter both call the same Admin Service, which remains the only owner of Access Key and Device Binding lifecycle transitions, Tunnel/DNS cleanup, fail-closed behavior and reconciliation.

The page uses server-rendered HTML, vendored Pico CSS 2.1.1 and small native JavaScript. Web Crypto generates Access Key plaintext in the browser and the Worker receives only its ID, label and SHA-256 hash. A pending plaintext credential exists only in session storage until the administrator confirms it was copied. The browser never receives `ADMIN_TOKEN`.

We deliberately do not add a Web framework, WebView, second Worker, Service Binding, second database, KV/R2 state, or a separate authentication system. D1 `access_keys` remains the sole cloud business fact source. Deployment creates or verifies Access before uploading Admin routes and refuses to adopt unknown applications or policies.
