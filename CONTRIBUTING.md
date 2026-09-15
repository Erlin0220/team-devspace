# Contributing

Team DevSpace original code is source-available under PolyForm Shield 1.0.0.
Read LICENSE before contributing. Contribute only material you have the right
to license under these terms; keep third-party code and notices under their
own licenses. Do not paste employer-owned or confidential material into a PR.

## Change flow

Open an Issue with the outcome and acceptance criteria. Branch from current
`main` (`fix/`, `feat/`, or `chore/`), implement the smallest useful change, then
open a PR referencing the Issue. Prefer reusing upstream/OS/provider features
to introducing new services, dependencies or duplicate state machines.

Run `npm run check`, `npm test` and any affected build/installer checks. Windows
shell tests use Git for Windows Bash; put its `bin` directory before the WSL
launcher in PATH. Record actual results and untested platforms in the PR.
Mocked APIs, extracted packages and emulation are not native installation proof.

`main` is the integration branch, not a daily development workspace. The
proposed ruleset is `config/main-ruleset.json`: PR required, `verify` and
`secret-scan` checks required, resolved review threads, linear squash history,
no force push or deletion. A solo maintainer may merge their own PR after
reviewing the diff; required approvals are deliberately zero. The JSON file
does not enforce anything until installed and verified in GitHub. Current
account/visibility limitations are tracked in `docs/public-readiness.md`.

## CI and release boundaries

PR CI has read-only repository permission and no production Environment.
Never run untrusted PR code with production credentials, `pull_request_target`,
a privileged `workflow_run`, or an employee/self-hosted runner. Pin Actions to
full commit SHAs. A contributor PR modifying CI still requires human inspection
before running it. Approve external-contributor workflow runs deliberately.

Production candidate builds and deployment are manual, reviewed-main-only
actions. Environment branch restrictions must also be configured remotely;
an `if:` expression is not a substitute for protecting the Environment itself.
Production signing/deployment secrets belong only to their individual steps,
not dependency installation, unit tests, artifact logs or caches.

A merge does not publish. Preserve the exact accepted bytes, source commit,
release profile digest, signatures and receipt limitations. Do not overwrite
an existing version, force a rollout, or remove recovery baselines merely to
make a failing gate pass. Cross-platform install and upgrade acceptance is a
release gate, not a required expensive build for every small PR.

## Privacy

Do not commit `.runtime`, `.env`, credentials, signing private keys, employee
logs, screenshots of private UI, production resource IDs or binary backups.
Use `config/*.example.json` and reserved example domains. Do not use `git push
--mirror`; local Codex checkpoints are not release refs. Never upload raw
secret-scanner reports as public CI artifacts. Use a noreply Git commit email.

Security reports follow SECURITY.md rather than ordinary public Issues.
