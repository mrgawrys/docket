# Template for mrgawrys/homebrew-tap — see packaging/README.md.
# The two sha256 placeholders must be replaced from the release's SHA256SUMS.
class Docket < Formula
  desc "Pre-runs Claude Code's /code-review on PRs awaiting your review"
  homepage "https://github.com/mrgawrys/docket"
  version "0.1.0"

  on_arm do
    url "https://github.com/mrgawrys/docket/releases/download/v#{version}/docket-darwin-arm64.tar.gz"
    sha256 "PLACEHOLDER_SHA256_ARM64"
  end

  on_intel do
    url "https://github.com/mrgawrys/docket/releases/download/v#{version}/docket-darwin-x64.tar.gz"
    sha256 "PLACEHOLDER_SHA256_X64"
  end

  depends_on :macos
  depends_on "gh"
  # The `claude` CLI and the code-review plugin are runtime deps too, but neither
  # is in Homebrew — `docket doctor` is what checks the full chain.

  def install
    bin.install "docket"
    fish_completion.install "fish/docket-completions.fish" => "docket.fish"
  end

  def caveats
    <<~EOS
      Run `docket doctor` first — it writes a starter config to
      ~/.config/docket/config.json and checks the rest of the review chain.
    EOS
  end

  test do
    assert_match "docket poll", shell_output("#{bin}/docket help")
    assert_match "unknown subcommand", shell_output("#{bin}/docket nope 2>&1", 1)
  end
end
