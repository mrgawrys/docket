import { notifyEnabled, type Config } from "./config";

export async function notify(cfg: Config, title: string, body: string): Promise<void> {
  if (!notifyEnabled(cfg) || process.platform !== "darwin") return;
  const strip = (s: string) => s.replaceAll('"', "");
  const script = `display notification "${strip(body)}" with title "${strip(title)}"`;
  try {
    await Bun.$`osascript -e ${script}`.quiet();
  } catch {
    // notifications are best-effort, exactly like the bash `|| true`
  }
}
