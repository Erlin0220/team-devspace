# Client distribution

`release.config.json` is the canonical release declaration. CI builds every enabled OS/architecture on a native runner, runs the runtime tests, and produces four required immutable components (`app`, `devspace-runtime`, `node`, `cloudflared`) plus the conditional Windows `git-fallback` component. The Windows build uses the SHA-256-pinned official Zig 0.15.2 toolchain only to compile the native x64 no-console launcher; the compiler is not shipped. Employee machines never run `npm install` or a native build.

Each target first produces a content-addressed offline layout:

```text
release/offline/<release>/<target>/
  manifest.json
  manifest.json.sha256
  objects/sha256/<digest>/<component>.tar.gz
  objects/sha256/<digest>/git-fallback.7z.exe  # Windows only
  <platform entrypoint>
```

The release manifest contains no remote artifact URL. Its `installMode` is `offline`, and every bootstrapper fails closed when a required component is absent instead of attempting an object-storage or authenticated GitHub download.

Windows keeps the small NSIS bootstrapper separate from the component objects; the administrator distributes the complete target directory as a ZIP. Under the canonical `internal-free` trust profile, the published Windows installer is Authenticode-signed with one fixed self-signed internal publisher identity. The private key stays only in the protected administrator backup and GitHub `production` secrets; the ZIP contains only the public certificate and a current-user trust helper. macOS embeds the verified component objects inside an intentionally unsigned/unnotarized self-contained `.pkg`. Linux embeds the same objects in its offline bootstrap archive. GitHub credentials are never shipped to employee machines.

Windows production dependencies are installed from the lockfile with `npm ci --omit=dev --omit=optional`. Team DevSpace disables upstream subagents and DevSpace uses its pipe implementation on Windows, so the optional platform Claude executable, Pi clipboard binding and `node-pty` are not part of that target artifact. The package build rejects `node-pty` or any platform `claude-agent-sdk-*` payload if either reappears, and records the install profile in both the cache fingerprint and release provenance. macOS/Linux retain `node-pty` for Unix TTY sessions, remove only lockfile-confirmed optional `claude-agent-sdk-<platform>` executables, and remove recognized foreign-platform PTY prebuild directories. The SDK JavaScript, native current-target PTY and Linux build outputs remain intact. Every Unix build runs a real PTY process after pruning. SBOM generation inspects the installed tree, not an unpruned lockfile graph.

The Windows Git component is the byte-for-byte pinned official PortableGit SFX. Installation verifies SHA-256 before executing it in isolated staging, then verifies Git/Bash. No expanded Git copy remains in the build cache. `devspace-runtime` contains only `node_modules`; build lockfiles and `.npmrc` are excluded. bsdtar gzip timestamps are disabled so unchanged cached input is not invalidated just by wall-clock archive time. The reusable dependency fingerprint ignores only the app's own version fields; dependency versions, lifecycle scripts, npm policy, target and runtime/tool versions still invalidate it. The full original lock hash remains in provenance. This is not a claim that different machines or fresh native builds produce byte-identical archives.

## Install transaction

The bootstrapper validates target, fixed version, artifact path, exact byte size and SHA-256 before extraction. It reads only the supplied offline package or its verified local cache. There is no `latest` lookup and no runtime download origin.

Windows stores archives under `cache/sha256`, extracts into the short `s/` staging path, validates Node, DevSpace, cloudflared and native SQLite, then switches between the fixed `v/0` and `v/1` slots. Full release and manifest identity lives in `active.json`. The short physical slots keep the unmodified upstream dependency tree below legacy MAX_PATH. The prior active slot remains available only until candidate setup and active-pointer commit succeed. After success it is retired; there is no supported post-upgrade rollback command. macOS/Linux use the equivalent `cache`, `staging`, `versions` and active-pointer layout.

Setup/Enrollment runs against the candidate before the active pointer changes. An integrity, extraction or setup failure leaves the previous active version selected and restores its startup entries. Repair uses the same cache and manifest; if an artifact is no longer cached, the administrator-supplied offline package is required. Post-commit cleanup retains only artifacts referenced by the current manifest and the current extracted version. Cleanup failure warns and is retried by subsequent install/repair instead of misreporting activation as failed. To downgrade later, the administrator supplies the older complete offline package. Uninstall removes owned payload/cache/startup entries but retains Enrollment and employee project files.

Unix activation and garbage collection share an atomic directory lock. Normal exits and signals clean the lock and partial files. After an uncatchable termination, the diagnostic identifies the owner PID and lock path; verify no installer remains before removing a stale lock. Never remove a live installer's lock.

## Publication gates

`.github/workflows/build-installers.yml` reads Node/npm versions and enabled targets from canonical configuration, checks the fixed Windows internal signing identity before native builds, uses the protected `production` environment for its private key, uploads each offline layout once, aggregates all native layouts, verifies every local component against the manifest, then assembles administrator handoff assets. Published Windows installers must carry the expected internal Authenticode signer and are re-verified on a runner after temporarily trusting the public certificate. Published macOS packages intentionally remain unsigned/unnotarized in this free internal profile; there is no Apple credential gate.

Publication is allowed only when the GitHub repository reports `private: true`. CI creates the fixed `v<version>` GitHub Release once and refuses to overwrite an existing release. The private Release is operator storage and handoff only: employees receive the package from the administrator and do not authenticate to GitHub during installation.

## Trust and remaining external gates

The fixed-version manifest is embedded in each platform handoff, so this version does not add TUF or a second manifest-signing subsystem. Trust is deliberately scoped to a private administrator handoff: Windows uses the fixed internal self-signed publisher certificate; macOS relies on the private Release SHA-256 plus the administrator-approved Gatekeeper exception for that package. This is not equivalent to public CA trust, SmartScreen reputation, Developer ID signing or Apple notarization. A production handoff still requires the Windows internal signing identity, native macOS/Linux runs, successful private GitHub Release publication, and real employee Enrollment. See `docs/internal-distribution.md` for the operator steps.

The current Access Key and device-secret model remains in place until two distinct Workspace users pass Managed OAuth identity routing and Linked App Token is proven through the wildcard per-device Access application. Do not delete those credentials based only on protocol-level unit tests.
