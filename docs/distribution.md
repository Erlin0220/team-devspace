# Client distribution

`release.config.json` is the canonical release declaration. CI builds every enabled OS/architecture on a native runner, runs the runtime tests, and produces four required immutable components (`app`, `devspace-runtime`, `node`, `cloudflared`) plus the conditional Windows `git-fallback` component. Employee machines never run `npm install` or a native build.

Each target first produces a content-addressed offline layout:

```text
release/offline/<release>/<target>/
  manifest.json
  manifest.json.sha256
  objects/sha256/<digest>/<component>.tar.gz
  <platform entrypoint>
```

The release manifest contains no remote artifact URL. Its `installMode` is `offline`, and every bootstrapper fails closed when a required component is absent instead of attempting an object-storage or authenticated GitHub download.

Windows keeps the small signed NSIS bootstrapper separate from the component objects; the administrator distributes the complete target directory as a ZIP. macOS embeds the verified component objects inside the signed/notarized package so the `.pkg` is self-contained. Linux embeds the same objects in its offline bootstrap archive. GitHub credentials are never shipped to employee machines.

Windows production dependencies are installed from the lockfile with `npm ci --omit=dev --omit=optional`. Team DevSpace disables upstream subagents and DevSpace uses its pipe implementation on Windows, so the optional platform Claude executable, Pi clipboard binding and `node-pty` are not part of that target artifact. The package build rejects `node-pty` or any platform `claude-agent-sdk-*` payload if either reappears, and records the install profile in both the cache fingerprint and release provenance. macOS/Linux deliberately retain optional dependencies because upstream DevSpace uses `node-pty` for Unix TTY sessions.

## Install transaction

The bootstrapper validates target, fixed version, artifact path, exact byte size and SHA-256 before extraction. It reads only the supplied offline package or its verified local cache. There is no `latest` lookup and no runtime download origin.

Windows stores archives under `cache/sha256`, extracts into the short `s/` staging path, validates Node, DevSpace, cloudflared and native SQLite, then switches between the fixed `v/0` and `v/1` slots. Full release and manifest identity lives in `active.json`. The short physical slots keep the unmodified upstream dependency tree below legacy MAX_PATH. At least the prior active slot remains available for rollback. macOS/Linux use the equivalent `cache`, `staging`, `versions` and active-pointer layout.

Setup/Enrollment runs against the candidate before the active pointer changes. An integrity, extraction or setup failure leaves the previous active version selected and restores its startup entries. Repair uses the same cache and manifest; if an artifact is no longer cached, the administrator-supplied offline package is required. Uninstall removes owned payload/cache/startup entries but retains Enrollment and employee project files.

## Publication gates

`.github/workflows/build-installers.yml` aggregates all native layouts, requires Authenticode for a published Windows installer and Developer ID Installer signing plus notarization/stapling for published macOS packages, verifies every local component against the manifest, then assembles administrator handoff assets.

Publication is allowed only when the GitHub repository reports `private: true`. CI creates the fixed `v<version>` GitHub Release once and refuses to overwrite an existing release. The private Release is operator storage and handoff only: employees receive the package from the administrator and do not authenticate to GitHub during installation.

## Trust and remaining external gates

The fixed-version manifest is embedded in the signed platform installer/package, so this version does not add TUF or a second manifest-signing subsystem. Unsigned local builds are development candidates only. A production handoff still requires real signing credentials, native macOS/Linux runs, successful private GitHub Release publication, and real employee Enrollment.

The current Access Key and device-secret model remains in place until two distinct Workspace users pass Managed OAuth identity routing and Linked App Token is proven through the wildcard per-device Access application. Do not delete those credentials based only on protocol-level unit tests.
