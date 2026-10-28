// The toolbar badge, shared by two things that want it:
//   - "Query evidence" (bg/exportRenamer.js): the held number, or ON while
//     exports are being renamed;
//   - a capture that's waiting on a bot check or for Capture now: WAIT, which
//     takes precedence while it lasts, because it needs you.

const NAME = "IOC Lookup Capture";
const AMBER = "#9a6700";

let exportBadge = { text: "", color: null, title: [] };
let waiting = null; // { siteName, mode } while a capture waits

async function render() {
  try {
    if (waiting) {
      await chrome.action.setBadgeText({ text: "WAIT" });
      await chrome.action.setBadgeBackgroundColor({ color: AMBER });
      const what =
        waiting.mode === "pause"
          ? `${waiting.siteName} is waiting for you: open this popup and press Capture now when the page is ready`
          : `a bot check or captcha is showing on ${waiting.siteName}: solve it in the lookup window (or open this popup for Capture now / Skip)`;
      await chrome.action.setTitle({ title: `${NAME} — ${what}` });
      return;
    }
    await chrome.action.setBadgeText({ text: exportBadge.text });
    if (exportBadge.color) await chrome.action.setBadgeBackgroundColor({ color: exportBadge.color });
    await chrome.action.setTitle({ title: [NAME, ...exportBadge.title].join(" — ") });
  } catch (err) {
    console.warn(`${NAME}: badge update failed`, err);
  }
}

/** @param {{ text: string, color: string|null, title: string[] }} badge */
export function setExportBadge(badge) {
  exportBadge = badge;
  return render();
}

/** @param {{ siteName: string, mode: string }|null} info - null when the wait is over */
export function setWaitingBadge(info) {
  waiting = info;
  return render();
}
