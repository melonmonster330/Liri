// Cross-platform push notification helpers.
//
// On iOS: schedules a local notification via the Capacitor LocalNotifications
//         plugin (declared in @capacitor/local-notifications, registered
//         by AppDelegate).
// Web intentionally does not offer or send flip notifications: browser
// notifications are inconsistent once the page is backgrounded/closed.
//
// iOS notifications are gated on the user opt-in flag stored at localStorage["liri_flip_notify"].
// If the user hasn't enabled flip alerts (via the Settings → Flip reminders
// toggle), these are no-ops.

function getLocalNotif() {
  return window.Capacitor?.Plugins?.LocalNotifications ?? null;
}

function userOptedIn() {
  return localStorage.getItem("liri_flip_notify") === "true";
}

// Schedule a "flip the record" reminder. Called from the side-end handler.
export function showFlipPushNotification(song, discInfo) {
  if (!userOptedIn()) return;
  let title = "Time to flip! 💿";
  if (discInfo?.isNewDisc) {
    title = `Time for LP ${discInfo.nextDisc}! 💿`;
  }
  const body  = song ? `${song.artist} — ${song.album || "Side A done"}` : "Your side has ended — flip the record";

  if (!window.Capacitor) return;
  try { getLocalNotif()?.schedule({ notifications: [{ id: 1001, title, body }] }); } catch {}
}

// Schedule a "you finished the album" notification. Called from album-end.
export function showAlbumEndPushNotification(song) {
  if (!userOptedIn()) return;
  const title = "That's the album! 🎶";
  const body  = song ? `${song.artist} — ${song.album || "Album complete"}` : "Put on your next record to keep going";

  if (!window.Capacitor) return;
  try { getLocalNotif()?.schedule({ notifications: [{ id: 1002, title, body }] }); } catch {}
}

// Exposed for callers (e.g. enableFlipNotify in main.js) that need
// the underlying LocalNotifications plugin for permission requests.
export { getLocalNotif };
