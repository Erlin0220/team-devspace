# Fixed software distribution

The employee contract remains one organization-provided download entrypoint,
followed by installation and a separately issued Access Key. Downloads are
not Enrollment, and public source is not permission to use a production Key.

## Existing delivery path

The current publisher reuses an owned Caddy HTTPS static site and SSH. It does
not add an HTTP upload API, R2, a Worker binary proxy or per-user download
tickets. Server configuration is private `.runtime/downloads.json`; operator
origins come from the explicit release profile. Reserved example domains in
source are placeholders, not working employee download links.

The generated PowerShell/POSIX installation scripts select the matching
platform and pin the immutable package URL, complete size and SHA-256. Users
may inspect the script or download the installer directly. No credential is
embedded in a download URL. The normal OS installer owns installation,
rollback and repair; directory/identity/pause preservation is not reimplemented
by the delivery service.

## Publishing

Build and accept the four targets from the same source/profile. Select the
operator profile, retain the update-signing private key in its protected
publisher location and invoke the existing publisher explicitly:

```sh
npm run downloads:publish                 # prepare locally, no server activation
npm run downloads:publish -- --publish    # authorized production operation
npm run downloads:site                    # independently update the static page
```

The publisher verifies immutable bytes, signatures and acceptance. Uploads go
to an unserved staging directory, server-side complete hashes are checked,
public delivery is probed with HEAD/Range/ETag, and stable is switched
atomically only after verification. `--full-https-verify` additionally hashes
every byte read back from public HTTPS. It is more expensive than range checks.

The site serves only its public subtree, not SSH state, ownership markers,
incoming files, logs or backups. Keep the existing ownership marker and Caddy
validation/rollback checks; never adopt an unrelated server directory.

Retention follows current stable, automatic/minimum policy and the fixed
upgrade recovery baselines. A newer stable pointer does not prove old devices
have migrated. Old pinned files cannot simply be removed or changed into
redirects: installed clients currently reject redirects. Server activation
does not silently downgrade already-installed clients.

## GitHub Releases transition

GitHub Releases is being evaluated for large files, not enabled by this source
cleanup. Public anonymous access, region/network reliability, final-byte
immutability, release ownership, license source obligations and compatible
client download handling must all be verified first. Retain the old direct
origin and recovery packages through the transition. Do not route large
binaries through the Gateway to avoid one provider's bandwidth bill.

The publisher is the only rollout owner; keep its signing and
`stable / auto / minimumSupported` contract rather than adding a second release
state machine. Current blockers and evidence are in [public readiness](public-readiness.md).
