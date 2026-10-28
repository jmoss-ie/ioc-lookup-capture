# Privacy Policy — IOC Lookup Capture

**Last updated:** 2026-10-28

## Summary

This extension does not collect, transmit, sell, or share any data, to
anyone, for any purpose. Everything it does happens entirely on your own
machine, inside your own browser profile.

## What the extension does with your data

- **Indicators you type and your site list/settings** are stored only in
  your browser's local extension storage (`chrome.storage.local` /
  `chrome.storage.session`), which stays on your device. They are never
  sent anywhere by this extension.
- **Screenshots it captures** are written directly to your own Downloads
  folder (via `chrome.downloads`), using your own browser's permissions.
  They never pass through, or are uploaded to, any server operated by the
  developer or anyone else.
- **Pages it navigates to** are exactly the reputation-lookup sites you
  configure in Options, opened in a window/tab this extension controls.
  Navigating to those sites is normal browser activity between you and that
  site — the extension does not relay, log, or report that activity
  anywhere itself.
- **The stitched capture method's page script** (only if you select that
  method) runs in the lookup tab this extension opened. It scrolls the
  page, reads element sizes and positions so the screenshots can be
  joined, temporarily hides fixed headers and footers so they aren't
  repeated, and puts the page back afterwards. It doesn't read the page's
  text or other content, and what it measures never leaves the extension.
- **Rename exports** (only while you switch it on in the popup): for each
  new download a web page starts, the extension looks at the download's
  address, the address of the page it came from, the address of the tab
  you're looking at, and the filename the browser suggested, to decide
  whether and how to rename it. It doesn't
  open or read the downloaded file. A short list of recent decisions
  (original name, new name, source site) is kept in local extension storage
  so the popup can show it; it never leaves your device. While renaming is
  off, nothing is renamed and the extension removes its download listener
  (the listener is present for a moment each time the extension starts up,
  and lets any download it sees through unchanged).
- **Bot check** (only for sites you set it on): while a lookup page
  settles, the extension reads its title and looks for the elements a
  Cloudflare check or captcha uses, to know whether to wait. It reads
  nothing else on the page, and what it finds stays in the extension (the
  run manifest, if you keep it on, notes that a check was shown, how long
  the capture waited, and whether you pressed Capture now).
- **The progress of a capture batch** (the site and indicator of each
  lookup, and whether it worked) is kept in the browser's session storage
  so the popup can show it again after it closes. Session storage stays on
  your device and is cleared when the browser closes, or when you press
  Clear in the popup.
- **Capture section** (only when you press it): a small script runs in each
  frame of the tab you're looking at. It finds the element matching your
  configured selectors and reads the size and position of that element and
  of the page's frames, so the screenshot can be cropped; it doesn't read
  the page's text. To tell which frame is inside which, each frame sends its
  parent window a random one-off token (an ordinary `postMessage`, which
  the page's own scripts can see; it contains nothing else). The cropped
  screenshot is saved to your Downloads folder like any other.
- **No analytics, telemetry, crash reporting, or remote logging** of any
  kind is built into this extension. It makes no network requests on its
  own behalf, to the developer or anyone else.

## Why the permissions it requests look broad

This extension requests permissions that Chrome describes in strong terms
("read and change all your data on all websites") because of *how* it
captures screenshots (`chrome.debugger`, and optionally
`chrome.tabs.captureVisibleTab` with `<all_urls>`, plus `scripting` for the
stitched method), not because it collects data through them. The project's README documents exactly how, and why,
each permission is used, and the source code is public so you (or anyone
else) can verify this directly rather than take it on faith:

https://github.com/jmoss-ie/ioc-lookup-capture

## Children's privacy

This extension is a professional security tool and is not directed at, nor
does it knowingly collect any information from, children.

## Changes to this policy

If this extension's data practices ever change, this policy will be updated
in the same repository, and the Chrome Web Store listing will reflect the
current version.

## Contact

Questions about this policy or the extension: **jmoss.dev@proton.me**
