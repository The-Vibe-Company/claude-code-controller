export function showDesktopNotification(title: string, body: string, tag?: string): void {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag });
  } catch {
    // Silently fail if Notification API is not available
  }
}
