import { notifyEnabled, type Config } from "./config";
import type { Verdict } from "./state";

// One wording for "someone reviewed your PR", shared by the sync trigger and
// its tests.
export function feedbackNotification(
  key: string,
  verdict: Verdict,
  reviewer: string,
): { title: string; body: string } {
  const what =
    verdict === "approved"
      ? "approved with comments"
      : verdict === "changes-requested"
        ? "requested changes"
        : "commented";
  return { title: `Feedback on ${key}`, body: `${reviewer} ${what}` };
}

export async function notify(
  cfg: Config,
  title: string,
  body: string,
): Promise<void> {
  if (!notifyEnabled(cfg) || process.platform !== "darwin") return;
  const strip = (s: string) => s.replaceAll('"', "");
  const script = `display notification "${strip(body)}" with title "${strip(title)}"`;
  try {
    await Bun.$`osascript -e ${script}`.quiet();
  } catch {
    // notifications are best-effort, exactly like the bash `|| true`
  }
}
