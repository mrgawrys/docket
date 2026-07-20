export async function notify(enabled: boolean, title: string, body: string): Promise<void> {
  if (!enabled || process.platform !== "darwin") return;
  const strip = (s: string) => s.replaceAll('"', "");
  const script = `display notification "${strip(body)}" with title "${strip(title)}"`;
  try {
    await Bun.$`osascript -e ${script}`.quiet();
  } catch {
    // notifications are best-effort, exactly like the bash `|| true`
  }
}
