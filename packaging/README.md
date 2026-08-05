# Packaging

`docket` ships as a prebuilt macOS binary through a personal tap,
[mrgawrys/homebrew-tap](https://github.com/mrgawrys/homebrew-tap).

## Cutting a release

Tag and push — `.github/workflows/release.yml` does the rest:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

It runs the test suite, cross-compiles both macOS binaries, and publishes a
GitHub release with `docket-darwin-arm64.tar.gz`, `docket-darwin-x64.tar.gz`,
and `SHA256SUMS`. Each tarball carries the `docket` binary and the fish
completions.

## Updating the tap

1. Copy `packaging/docket.rb` into `homebrew-tap/Formula/docket.rb`.
2. Set `version` to the tag you just pushed (without the `v`).
3. Replace `PLACEHOLDER_SHA256_ARM64` and `PLACEHOLDER_SHA256_X64` with the
   matching lines from the release's `SHA256SUMS`.
4. Commit and push the tap. `brew install mrgawrys/tap/docket` picks it up
   immediately; `brew test docket` runs the formula's smoke test.

The formula's URLs point at `mrgawrys/auto-review`, where the releases live.
If that repo is renamed to `docket`, update both URLs and the homepage.
