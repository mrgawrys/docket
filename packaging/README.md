# Packaging

`docket` ships as a prebuilt macOS binary through a personal tap,
[mrgawrys/homebrew-tap](https://github.com/mrgawrys/homebrew-tap).

## Cutting a release

Tag and push — `.github/workflows/release.yml` does the rest:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

It runs the test suite, cross-compiles both macOS binaries, publishes a GitHub
release with `docket-darwin-arm64.tar.gz`, `docket-darwin-x64.tar.gz`, and
`SHA256SUMS`, then pushes the updated formula to the tap. Each tarball carries
the `docket` binary and the shell completions (bash, zsh, fish).

Users pick it up with `brew update && brew upgrade docket`.

## The tap formula is generated

`packaging/docket.rb` is the source of truth; the tap's `Formula/docket.rb` is
generated from it on every tag push, with `version` and both `sha256`s filled
in from `SHA256SUMS`. **Edit the formula here, never in the tap** — a change
made there is overwritten by the next release.

Anything else about the formula — a new completion, a new `depends_on`, a
changed `test do` — is a normal edit to `packaging/docket.rb`, and reaches
users on the next tag.

## The tap token

Pushing to `mrgawrys/homebrew-tap` is a cross-repo write, which the workflow's
own `GITHUB_TOKEN` cannot do. The `TAP_TOKEN` secret on `mrgawrys/docket` is a
fine-grained PAT scoped to `homebrew-tap` alone, with `Contents: Read and
write`. It expires; when it does the release still publishes and only the tap
step fails, so the recovery is to mint a new token and re-run that job.

## If the tap step fails

The release is already published by then, so nothing is lost — fix the token
(or whatever broke) and re-run the job. A re-run regenerates an identical
formula and pushes nothing if it already landed. To repair the tap by hand,
apply the three substitutions above to `packaging/docket.rb` and commit the
result as `Formula/docket.rb`.

`brew install mrgawrys/tap/docket` picks up a pushed formula immediately;
`brew test docket` runs its smoke test.
