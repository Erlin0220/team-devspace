# Client distribution

`release.config.json` is the canonical release declaration. CI builds every enabled OS/architecture on a native runner, runs the runtime tests, and produces four required immutable components (`app`, `devspace-runtime`, `node`, `cloudflared`) plus the conditional Windows `git-fallback` component. The Windows build uses the SHA-256-pinned official Zig 0.15.2 toolchain only to compile the native x64 no-console launcher; the compiler is not shipped. Employee machines never run `npm install` or a native build.

Each target first produces a content-addressed CI layout:

```text
release/offline/<release>/<target>/
  manifest.json
  manifest.json.sha256
  objects/sha256/<digest>/<component>.tar.gz
  objects/sha256/<digest>/git-fallback.7z.exe  # Windows only
  <platform package>
```

The component layout is a build/verification boundary, not the Windows employee installation contract. The release manifest contains no remote artifact URL and every component is checked for exact path, size and SHA-256 before a platform package is assembled.

Windows embeds the fixed manifest and verified component objects into one NSIS installer EXE. Under the canonical `internal-free` trust profile, that EXE is Authenticode-signed with one fixed self-signed internal publisher identity; the administrator handoff ZIP contains only the self-contained EXE, its public certificate and the current-user trust helper. macOS embeds the same verified objects in a self-contained `.pkg`; protected Apple credentials optionally activate Developer ID signing/notarization, otherwise the package is explicitly unsigned/unnotarized. Linux embeds them in its offline bootstrap archive. GitHub credentials are never shipped to employee machines.

Windows production dependencies are installed from the lockfile with `npm ci --omit=dev --omit=optional`. Team DevSpace disables upstream subagents and DevSpace uses its pipe implementation on Windows, so the optional platform Claude executable, Pi clipboard binding and `node-pty` are not part of that target artifact. The package build rejects `node-pty` or any platform `claude-agent-sdk-*` payload if either reappears, and records the install profile in both the cache fingerprint and release provenance. macOS/Linux retain `node-pty` for Unix TTY sessions, remove only lockfile-confirmed optional `claude-agent-sdk-<platform>` executables, and remove recognized foreign-platform PTY prebuild directories. The SDK JavaScript, native current-target PTY and Linux build outputs remain intact. Every Unix build runs a real PTY process after pruning. SBOM generation inspects the installed tree, not an unpruned lockfile graph.

The Windows Git component is the byte-for-byte pinned official PortableGit SFX. The installer verifies its SHA-256 and expands it only when system Git is unavailable; Bash absence alone does not trigger the fallback because upstream DevSpace uses the Windows command processor for shell execution. The installed fallback is still checked for both Git and Bash integrity. `devspace-runtime` contains only `node_modules`; build lockfiles and `.npmrc` are excluded. bsdtar gzip timestamps are disabled so unchanged cached input is not invalidated just by wall-clock archive time. The reusable dependency fingerprint ignores only the app's own version fields; dependency versions, lifecycle scripts, npm policy, target and runtime/tool versions still invalidate it. The full original lock hash remains in provenance. This is not a claim that different machines or fresh native builds produce byte-identical archives.

## Install transaction

The platform installer validates target, fixed version, artifact path, exact byte size and SHA-256 before extraction. There is no `latest` lookup and no runtime download origin.

Windows extracts embedded objects into the short `s/` staging path, validates Node, DevSpace, cloudflared and native SQLite, then switches between fixed `v/0` and `v/1` slots. Full release and manifest identity lives in `active.json`. The short physical slots keep the unmodified upstream dependency tree below legacy MAX_PATH. Windows no longer persists a component archive cache after installation; re-running the same self-contained EXE is the repair source for damaged program files. The prior active slot remains available only until the new local version and its startup entries are safe to commit, then is retired. macOS/Linux keep their existing cache/staging/version implementation because their package contracts and platform installation paths are separate.

Windows local installation and cloud Enrollment are separate states. For a new device, the verified candidate is committed to `active.json` before first Enrollment. If Access Key validation, Gateway provisioning, DNS or Tunnel connectivity fails, the installer retains the local application, writes an onboarding diagnostic and reports that connection setup is pending instead of rolling the software version back. Re-running setup resumes the pending identity. On an already enrolled device, upgrades reuse the existing `bindingId`, `keyId`, credentials, Tunnel token and Allowed Roots without another `/v1/enroll` call; only local startup entries are refreshed. Network/Tunnel health is reported later by Status/Tray and never gates local installation success.

`Repair connection` is intentionally local-first: with healthy retained Enrollment material it recreates startup/configuration without reinstalling payloads or contacting the Gateway. If a required Enrollment credential such as `tunnel.token` is missing, Repair performs one idempotent `/v1/enroll` recovery using the retained device identity and Access Key instead of forcing a new device binding. Program-file damage is repaired by re-running the trusted self-contained installer. Uninstall removes owned program/startup entries but retains Enrollment and employee project files.

Unix activation and garbage collection share an atomic directory lock. Normal exits and signals clean the lock and partial files. After an uncatchable termination, the diagnostic identifies the owner PID and lock path; verify no installer remains before removing a stale lock. Never remove a live installer's lock.

## Publication gates

`.github/workflows/build-installers.yml` reads Node/npm versions and enabled targets from canonical configuration, checks the fixed Windows internal signing identity before native builds, uses the protected `production` environment for private credentials, uploads each offline layout once, aggregates all native layouts, verifies every local component against the manifest, then assembles administrator handoff assets. Published Windows installers must carry the expected internal Authenticode signer and are re-verified on a runner after temporarily trusting the public certificate. Apple credentials remain optional; when complete they enable app/PKG signatures plus notarization/staple, and when absent the job explicitly reports unsigned/unnotarized output.

Publication is allowed only when the GitHub repository reports `private: true`. CI creates the fixed `v<version>` GitHub Release once and refuses to overwrite an existing release. The private Release is operator storage and handoff only: employees receive the package from the administrator and do not authenticate to GitHub during installation.

## Trust and remaining external gates

The fixed-version manifest is embedded in each platform handoff, so this version does not add TUF or a second manifest-signing subsystem. Trust is deliberately scoped to a private administrator handoff: Windows uses the fixed internal self-signed publisher certificate; macOS relies on the private Release SHA-256 plus the administrator-approved Gatekeeper exception for that package. This is not equivalent to public CA trust, SmartScreen reputation, Developer ID signing or Apple notarization. A production handoff still requires the Windows internal signing identity, native macOS/Linux runs, successful private GitHub Release publication, and real employee Enrollment. See `docs/internal-distribution.md` for the operator steps.

The current Access Key and device-secret model remains in place until two distinct Workspace users pass Managed OAuth identity routing and Linked App Token is proven through the wildcard per-device Access application. Do not delete those credentials based only on protocol-level unit tests.
