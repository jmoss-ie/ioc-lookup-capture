# IOC Lookup Capture

A Manifest V3 Chrome/Edge extension for attaching reputation-lookup
screenshots to incident reports. Paste one or more indicators into the
toolbar popup, tick which lookup sites to use, and press Capture. Each
applicable lookup opens in a dedicated browser window (your own tabs are
never touched), gets screenshotted once the page settles, and is saved to
disk alongside the run's manifest and checksum file. A separate **Open for
review** action skips the screenshot step entirely and just opens every
lookup for you to look at. For query work, **Capture section** screenshots
the query and results on a Sentinel / Log Analytics page with one click,
and **Rename exports** files the exports you make (a query exported to CSV
or Excel, say) into the same case folder; both are named and numbered in
order — see [Query evidence](#query-evidence-capture-section-and-rename-exports).

This extension does not try to minimize Chrome's permission warnings at
the cost of functionality. It does try to request the minimum permission
set that actually works, and to explain plainly why each one is there.

This is an independent, personal project. It is not affiliated with,
endorsed by, or built on behalf of any employer or client; it collects,
transmits, and shares no data — see [`PRIVACY.md`](./PRIVACY.md).

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder.
4. Pin the extension from the toolbar puzzle-piece menu for quick access.
5. Open the extension's **Options** page (right-click the toolbar icon →
   Options, or the ⚙ in the popup) and review the site list, naming
   settings, and capture backend before first use. Run the **diagnostics
   self-test** there to confirm captures work in your environment.

No build step is required — this is plain ES modules loaded directly by
Chrome.

## Permissions, and why each one is there

| Permission | Why |
| --- | --- |
| `tabs` | Create and manage the dedicated lookup windows/tabs, read their load status. |
| `downloads` | Save PNG screenshots, the run manifest, and the checksum file. While **Rename exports** is switched on, also rename downloads started by web pages (`chrome.downloads.onDeterminingFilename`) — no extra permission is needed for that. |
| `storage` | Persist the site registry and settings across browser restarts. |
| `offscreen` | Mint `blob:` object URLs for screenshot downloads — required because service workers cannot call `URL.createObjectURL()` (see Chromium behaviour below). |
| `debugger` | The **full-page (debugger)** backend: drives navigation and screenshot capture via the Chrome DevTools Protocol. Required, not optional — see below. A build can leave it out altogether; see [A build without `debugger`](#a-build-without-debugger). |
| `scripting` (optional permission) | Needed by the **stitched** backend, to run its scroll-and-measure functions inside the lookup tab it opened, and by **Capture section**, to find the section's position in the current tab's frames. Requested at runtime, together with `<all_urls>`: from the Options page when you select the stitched backend, or from the popup the first time you press Capture section. Chrome shows no warning for it. |
| `<all_urls>` (optional host permission) | Needed by the **viewport** and **stitched** backends and by **Capture section**, to satisfy `chrome.tabs.captureVisibleTab`'s host-permission requirement (and, for Capture section, to run its probe in frames from other sites, such as the Azure portal's embedded Logs page). Requested at runtime only when you use one of those. |

**`debugger` shows two separate warnings, and switching backends does not
avoid either of them.** Chrome displays the `debugger` permission as both
*"Access the page debugger backend"* and *"Read and change all your data on
all websites"* at install time, because `debugger` is what the full-page
backend uses. Because `debugger` can't be an optional permission (see
[Chromium behaviour](#chromium-behaviour-this-extension-is-built-around)
item 2), selecting a different backend in Options doesn't remove those
warnings from the install prompt — only a build without `debugger` does.
And the viewport and stitched backends still need `<all_urls>` — the same
"read and change all your data on all websites" scope — just requested at
runtime instead of install time. There is no configuration of this
extension that avoids that warning; the honest framing is "when", not
"whether".

## The three capture backends

|  | Full page (default) | Full page, stitched | Viewport |
| --- | --- | --- | --- |
| How | `chrome.debugger` (Chrome DevTools Protocol) | Scrolls the page one screen at a time, takes a `chrome.tabs.captureVisibleTab` screenshot of each screen, and joins them into one PNG | `chrome.tabs.captureVisibleTab` |
| Coverage | Entire page, up to Chromium's 16384px bitmap limit (taller pages are truncated and flagged) | Entire page height, up to the same 16384px limit (same truncation flag), at the capture window's width | Above the fold only, at capture time |
| Extra permission needed | None beyond the required set | `<all_urls>` and `scripting`, granted at runtime | `<all_urls>`, granted at runtime |
| Visible side effects | While the debugger is attached, Chrome shows a *"IOC Lookup Capture started debugging this browser"* banner. Clicking its Cancel button detaches the debugger, which makes the capture in progress fail. | The lookup page visibly scrolls. In "current window" mode, the lookup tab is briefly made the active tab. | In "current window" mode, the lookup tab is briefly made the active tab. |
| Time per capture | One screenshot | About half a second per screen-height of page (Chrome allows 2 `captureVisibleTab` calls per second) | One screenshot |
| Best for | Most lookups — one render of the whole page | Whole-page coverage without attaching the debugger | Quick captures where what's needed is visible without scrolling |

Full page (debugger) is the default because it captures the whole page in a
single render, without scrolling it. Choose **stitched** if you'd rather not
have the debugger attached to anything (no banner), or if you're running a
build without `debugger` — understanding the limits listed in the next
section. Choose **viewport** only if what you need is always above the fold.

## How the stitched backend works, and where it falls short

For each lookup, after the page has loaded and settled, the stitched backend:

1. Runs a small function in the lookup tab (via `chrome.scripting`, in the
   extension's isolated world) that hides the page's scrollbars, turns off
   smooth scrolling and scroll snapping, and works out what scrolls — the
   document itself or, on app-style pages where the document never scrolls,
   the largest visible scrolling panel.
2. Switches `position: sticky` elements to `position: relative` (offsets
   cleared) so a sticky header sits in its natural place instead of
   repeating on every screen once it has stuck.
3. Scrolls to the top, screenshots the screen, and repeats one screen-height
   at a time down to the bottom, spacing screenshots to stay inside Chrome's
   rate limit. Fixed-position elements are hidden on the middle screens so
   they aren't repeated: ones in the top half of the screen (headers) appear
   only on the first screen, ones in the bottom half (cookie bars, chat
   buttons, footers) only on the last. Fixed elements that cover most of
   the screen (backdrops) are left alone. Fixed and sticky elements inside
   open shadow roots are handled the same way.
4. Joins the screenshots on an `OffscreenCanvas` in the service worker and
   saves the result as a PNG through the same pipeline as the other
   backends.
5. Puts back everything it changed in the page — styles, scroll position,
   the hidden elements — whether or not the capture succeeded.

Limits worth knowing before you rely on it:

- **It's several screenshots, not one render.** They're taken over a few
  seconds. Anything that changes in that time — an animation, a rotating
  banner, a live counter, content that loads in as you scroll — can show a
  visible seam or a mismatch between screens. The capture timestamp is the
  moment the first screenshot was taken.
- **Pages that grow while being captured** (lazy loading, infinite scroll)
  are flagged: if the page is taller at the end than at the start, the
  manifest entry is marked `truncated`, with the page's new height in
  `realHeightPx`.
- **Width is the capture window's width.** Content that overflows
  horizontally beyond the window isn't captured. (The debugger backend
  captures the full content width, up to 16384px.)
- **Inner-panel pages:** everything above the scrolling panel is taken once
  from the first screen, the panel's full content is stitched below it, and
  anything below the panel (a footer bar) is taken once from the last
  screen. Areas *beside* the panel, such as a sidebar, appear only for the
  first screen's height; below that, the image is blank beside the panel.
- **Leave the capture window alone while it runs.** If its size changes
  mid-capture, the capture fails with an error rather than producing a
  misaligned image. If the window is minimized or completely covered,
  Chrome may stop repainting it, and screenshots can come out stale or
  fail.
- **The image is at the display's pixel density.** On a scaled display (for
  example 150% in Windows), the PNG is correspondingly larger than the
  page's CSS size, and the 16384px limit is reached sooner.
- **Some pages can't have a script run in them** at all — the Chrome Web
  Store, `chrome://` pages, other extensions' pages, and sites blocked by
  enterprise policy. A stitched capture of one of those fails with an
  error that says so.

## A build without `debugger`

The full-page (debugger) backend only exists if the manifest includes the
`debugger` permission. `npm run package` builds both Web Store zips from
this folder, into `dist/`:

- `ioc-lookup-capture-<version>-cws.zip`: all three backends.
- `ioc-lookup-capture-<version>-cws-no-debugger.zip`: identical except that
  `"debugger"` is removed from `permissions` in its `manifest.json`.

Nothing else differs, because the extension adapts at runtime:

- The Options page doesn't show the debugger backend at all — no radio
  button, no table column, no mention of it — and marks stitched as the
  default.
- A saved "Full page" setting — including the shipped default — runs as
  stitched, and the run manifest's `backend` field records `stitched`.
- `bg/fullPageCapture.js` is still in the zip, because `bg/runner.js`
  imports it statically (MV3 service workers can't use dynamic `import()`).
  Without the permission it's never called.
- As with the viewport backend, nothing can be captured until "All sites"
  and `scripting` are granted in Options; the popup says so until they are.
- The install prompt loses the two `debugger` lines. According to Chrome's
  permissions reference, `tabs` and `downloads` still show *"Read your
  browsing history"* and *"Manage your downloads"*, and the "read and
  change all your data on all websites" warning moves to the moment you
  grant `<all_urls>` in Options.

Both the default build and this one are covered by the end-to-end tests.

## Window behavior

Two settings in Options, under "Window behavior", control what happens to
the windows a capture batch opens:

- **Open lookups in the same window** (`reuseWindow`, off by default): one
  window/tab is opened and reused for every job in the batch, instead of a
  fresh window per lookup. Each job still gets its own navigation, settle
  delay, and screenshot — only the window itself is shared. Fewer windows
  popping up during a large batch, at the cost of all lookups happening in
  strict sequence in one window rather than being independently inspectable
  mid-run.
- **Keep windows open after capture** (`keepWindowsOpen`, off by default):
  instead of closing capture windows when the batch finishes, they're left
  open for manual review — one window if `reuseWindow` is also on, otherwise
  one per job. The popup shows a "N still open · Close all" control
  whenever any are left open, tracked in `chrome.storage.session` so it
  still works correctly after the service worker has been torn down and
  restarted.
- **Keep lookups in my current window** (`useCurrentWindow`, off by
  default): instead of a separate browser window, each lookup opens as a
  new background tab in the window you started the run from (the window
  the popup was open over) — your own active tab is never taken over or
  navigated away from. Combined with `reuseWindow`, one new tab is opened in
  your window and reused for the whole batch; without it, every job gets
  its own new tab there. This extension never closes or removes that
  window itself, no matter what `keepWindowsOpen` says — only the tabs it
  opened in it.
  - The **viewport** and **stitched** backends can only screenshot
    whichever tab is currently the *visible* one in a window, so with this
    setting on, each capture briefly makes the lookup tab active (stealing
    focus from whatever you had open) and restores your previous tab
    immediately afterward. For the stitched backend, "briefly" is the whole
    scroll-and-capture, a few seconds on a long page. The **full-page**
    (debugger) backend doesn't need to do this — it can screenshot the
    lookup tab in the background without touching your focus at all, which
    is one more reason it's the default backend.
  - A site's "Fullscreen" option, combined with this setting, maximizes
    your *whole* browser window rather than a separate one (it's the same
    window, after all) — and this extension restores it to whatever state
    it was in before, once the tab it opened there is closed.

**Open for review**, the popup's other action button, always leaves its
window(s)/tab(s) open regardless of `keepWindowsOpen` — that's the entire
point of that action — but otherwise respects `reuseWindow` and
`useCurrentWindow` the same way Capture does.

## Submitting a list of indicators for review, without capturing anything

Paste indicators and tick sites exactly as you would for a capture batch,
then press **Open for review** instead of Capture. Each applicable lookup is
opened and allowed to load and settle, but nothing is screenshotted,
downloaded, or written to disk — no manifest, no checksum file, no PNGs.
It's for quickly eyeballing a batch of lookups before deciding which ones are
worth turning into evidence screenshots, or for cases where a screenshot
isn't needed at all.

## Query evidence: Capture section and Rename exports

Investigating an alert can mean five or more queries, each needing a
screenshot of the query and its results and often an export — a Sentinel /
Log Analytics CSV, an **Open in Excel** workbook, a Defender
advanced-hunting export — saved under the same generic name
(`query_data.csv` and friends) and renamed by hand afterwards. The popup's
**Query evidence** box does both, into one numbered sequence per case.
With **Keep the same number** ticked while exporting each query (step 3
below), a query's screenshot and its exports share its number:

```
Downloads/soc-evidence/INC-1234/exports/INC-1234-01-signins-section-20261026T001528Z.png
Downloads/soc-evidence/INC-1234/exports/INC-1234-01-signins-query_data-20261026T001530Z.csv
Downloads/soc-evidence/INC-1234/exports/INC-1234-02-devicelogons-section-20261026T001655Z.png
Downloads/soc-evidence/INC-1234/exports/INC-1234-02-devicelogons-query_data-20261026T001702Z.csv
Downloads/soc-evidence/INC-1234/exports/INC-1234-02-devicelogons-query_data-20261026T001705Z.xlsx
```

Without it, every file takes the next number (01 screenshot, 02 export,
03 screenshot, …), still in the order they were made.

1. Type the case reference, and optionally a **label** for the query
   you're on. The label goes into every file's name (`{label}`) until you
   change or clear it, so a query's screenshot and its exports share it.
2. **Capture section** screenshots the query editor and results on the
   page in front of you (details below).
3. **Keep #NN for the next files (same query)** holds the number: while
   it's ticked, every file for that case — captures and renamed exports —
   gets the case's current number (its most recent, or 01 before any). The
   toolbar badge shows the held number in amber (`#05`) as a reminder.
   Untick it before moving to the next query; numbering carries on from
   the next number. **Restart at 01** also releases it. Only one case is
   held at a time, and a hold never affects other cases.
4. **Rename exports → Start** renames every file a web page downloads and
   saves it into the same sequence, instead of the Downloads root. The
   toolbar icon shows a red **ON** badge while it's on. Press **Stop** when
   you're done. Renaming also stops by itself after an idle period with no
   export or capture (60 minutes by default, set in Options; 0 = never),
   so a forgotten switch doesn't sweep unrelated downloads into a case
   folder later.

### Capture section

Does what DevTools' **Capture node screenshot** does on the Logs page's
query area, from one button: it finds the element matching a CSS selector
in the current tab, screenshots the tab, and crops to that element.

- **What it looks for.** Options → Query evidence → "Section to capture":
  CSS selectors, one per line, first one found wins. The default,
  `.listener-to-user-interaction.main-container`, is the query editor plus
  results area of the Sentinel / Log Analytics Logs page (the element
  DevTools highlights for that area). For another page, right-click the
  area → **Inspect**, find the element whose highlight covers what you want,
  and use its id (`#id`) or classes (`.a.b`).
- **Inside frames.** The Azure portal shows the Logs page inside an
  iframe from another site. A small script runs in each frame of the tab
  to find the element and work out where each frame sits in the page (see
  [Chromium behaviour](#chromium-behaviour-this-extension-is-built-around)
  item 9 for how), so the crop lands on the right place however deeply it's
  nested.
- **Only what's on screen.** It's a crop of the visible tab. If the
  section is larger than the visible area, the visible part is saved and
  the popup marks it "(visible part only)". Results grids that draw only
  their visible rows (Log Analytics' does) show only those rows — the export
  is the complete record.
- **Permissions.** Needs `scripting` and "All sites" (`<all_urls>`), asked
  for the first time you press it. In Chrome, that prompt can close the
  popup; the permission is still granted, and the next press captures.
- A capture only takes a number once the screenshot has worked; a page
  with nothing matching says so and leaves the numbering alone.

### Rename exports

Details:

- **Numbering is per case and survives restarts.** Captures and renamed
  exports share it. Switching renaming back on for the same case carries
  on from the next number. **Restart at 01** in the popup starts a case
  again (Chromium's "uniquify" stops a repeated name overwriting an earlier
  file — it appends ` (1)`). Switching to a different case starts or
  resumes that case's own numbering. Captures use the case typed in the
  popup; renamed exports use the case renaming was started for (the popup
  offers **Switch to** when they differ).
- **The filename template** (Options → Query evidence) defaults to
  `{prefix}-{case}-{seq}-{label}-{name}-{timestamp}`. Tokens: `{prefix}`
  (the same Prefix setting the screenshots use), `{case}`, `{seq}` (01, 02,
  …), `{label}`, `{name}` (the name the site gave the file; `section`
  for a capture),
  `{timestamp}` (UTC, same format as the screenshots) and `{date}`
  (YYYYMMDD). A token with no value is dropped along with one separator
  next to it, so an empty `{prefix}` or `{label}` doesn't leave `--`
  behind. The file's original extension is always kept. Exports go in an
  `exports` subfolder of the case folder by default; blank puts them in the
  case folder itself.
- **Only web-page downloads are renamed.** Downloads started by any
  extension are left alone, and this extension's own screenshots, manifests
  and checksum files keep their own names (see
  [Chromium behaviour](#chromium-behaviour-this-extension-is-built-around)
  item 7 for why that needed handling).
- **Optional site filter.** Off by default: every web-page download is
  renamed while renaming is on. To limit it to your query portal, export
  once, then press **Only rename from &lt;site&gt;** in the popup: it adds
  that export's sites to the list and ticks **Only rename from listed
  sites**. Untick it to rename everything again without losing the list,
  which you can also edit in Options (each entry covers its subdomains). A
  download matches if any of these is listed: the tab you're looking at
  when it starts (download items don't say which tab they came from, so
  this is the active tab of the focused window), the page that created
  it, or the page it was started from. A download that doesn't match keeps
  the browser's own name and place, and the popup lists it with its sites
  and offers **Also allow &lt;site&gt;**.
- **Off means off.** While renaming is off, this extension removes its
  `onDeterminingFilename` listener, so downloads elsewhere in the browser
  don't pass through it at all (the listener is briefly present each time
  the service worker starts, until it has read that renaming is off).
- **One renamer at a time.** If another installed extension also renames
  downloads, Chromium's documentation says the most recently installed one
  wins when both suggest a name — check for that if names come out wrong.
- **What it doesn't do.** It renames and files the export; it doesn't open,
  read or hash the exported file, and it doesn't record the query that
  produced it. Exports aren't listed in a capture run's manifest or
  `SHA256SUMS` file. The popup keeps a short list of recent renames (source
  name → new name) in local extension storage so you can confirm what
  happened.

## Per-site "fullscreen" (maximize the capture window)

Each site in the registry (Options → Sites) has a **Fullscreen** checkbox.
When ticked, the capture window is maximized before that site is navigated
to and captured — it does **not** click an in-page fullscreen button or
request fullscreen from the page itself, just the browser window. Some sites
(maps, dashboards, graphs) render meaningfully more detail given more screen
space. It's off by default for every shipped site; turn it on per site as
needed.

## Indicator handling

- IPv4, IPv6, domains, full URLs, and MD5/SHA-1/SHA-256 hashes are all
  accepted, mixed freely, one or more per line (or comma/semicolon
  separated).
- Defanged input is refanged before parsing: `hxxp`/`hxxps` → `http`/`https`;
  `[.]`, `(.)`, `[dot]` → `.`; `[:]` → `:`; `[@]`/`[at]` → `@`. Paste
  straight from a ticket.
- Indicators are de-duplicated (case-insensitive on the refanged form),
  order preserved.
- A bare host with a path or port (`evil.com/pay.php`, `evil.com:8080`) is
  classified as a URL, not a domain — it's routed only to sites that accept
  URLs.
- IPv4 octets are validated properly (`999.1.1.1` is rejected; so are
  ambiguous leading zeros like `192.168.01.1`).
- The popup shows exactly what was accepted and what was rejected, with a
  reason, before you run anything.

## Site registry

Sites are data, not code — see `common/defaultSites.js` for the shipped
list and the Options page to add, edit, disable, or delete any of them
(built-in or custom) without touching a file. Each site is:

```js
{ id, name, url, applies, settleMs, enabled, fullscreen, note }
```

`applies` is a list drawn from `ipv4`, `ipv6`, `domain`, `url`, `hash`, and
gates whether the site is even offered for a given indicator. `url` is a
template using these placeholders:

| Placeholder | Value |
| --- | --- |
| `{indicator}` | the refanged indicator exactly as typed |
| `{host}` | hostname only — a URL's domain, or the IP itself for an IP indicator |
| `{encoded}` / `{hostEncoded}` | URL-encoded forms of the indicator / host |
| `{vtUrlId}` | this extension's VirusTotal URL id: the SHA-256 hex digest of the URL string (a registry convention for the `virustotal-url` site template, not a general-purpose URL-hashing standard) |

Shipped enabled: AbuseIPDB and VirusTotal (IP/domain/URL/file). Everything
else ships disabled, ready to tick on in Options: ip.teoh.io, urlscan.io (IP
and domain/URL), URLVoid, IPVoid, Shodan, GreyNoise, Spur, Cisco Talos,
Censys, AlienVault OTX (IP and domain), Pulsedive, who.is, MXToolbox
blacklist check.

VirusTotal, Shodan, GreyNoise, and Spur render substantially more detail (or
in Spur's case, require it at all) when you're already signed in in that
browser profile — this extension uses whatever session already exists and
never touches credentials. Spur's free Community tier account is enough.

If the extension is updated and ships a new default site, it's added to
your saved list automatically. If you've deliberately deleted a default
site, it stays deleted — the merge only adds a default your saved list has
never seen before (tracked by id), never one simply "missing" from it,
since "missing" and "deleted" would otherwise be indistinguishable.

## Output layout

```
Downloads/soc-evidence/<case-ref>/<indicator>/<site>-<indicator>-<timestamp>.png
Downloads/soc-evidence/<case-ref>/manifest-<timestamp>.json
Downloads/soc-evidence/<case-ref>/SHA256SUMS-<timestamp>.txt
Downloads/soc-evidence/<case-ref>/exports/<case-ref>-<seq>-<name>-<timestamp>.<ext>   (Query evidence)
```

The base folder name and per-indicator subfolder are configurable in
Options, with a live example path shown as you change them. There's also
an optional filename prefix field (empty by default) if you want every
screenshot to start with a fixed string. An empty case reference drops
that folder level entirely rather than substituting a placeholder.

The run's `manifest-<timestamp>.json` lists every screenshot taken
(indicator, site, image path, pixel dimensions, whether it was truncated,
and its SHA-256), and `SHA256SUMS-<timestamp>.txt` is a plain
`sha256sum -c`-compatible checksum file covering the same PNGs — useful for
confirming a screenshot hasn't been altered after capture. There is no
per-screenshot JSON sidecar file; each screenshot is just the PNG itself,
accounted for in the run's manifest and checksum file.

**`chrome.downloads` can only write inside the browser's configured
Downloads directory.** That's a hard Chromium limit on the `downloads` API,
not a design choice this extension made — there is no way for an extension
to write files anywhere else.

Every path segment is sanitized for Windows, macOS, and Linux: reserved
characters are stripped, runs of two or more dots are collapsed so `..` can
never appear, trailing dots/spaces are trimmed (Windows silently mangles
these), and reserved Windows device names (`CON`, `PRN`, `AUX`, `NUL`,
`COM1`–`COM9`, `LPT1`–`LPT9`) are escaped case-insensitively.

## What a screenshot does and does not establish

- A **viewport** capture omits everything below the fold at capture time.
- A **full-page** capture of a page taller than 16384px is truncated;
  the manifest entry's `truncated`/`realHeightPx` fields say so explicitly.
- A **stitched** capture is assembled from several screenshots taken over a
  few seconds, with fixed and sticky elements repositioned or hidden so
  they appear once. It shows what each part of the page looked like when
  that part was captured, not the whole page at one instant. See [the
  stitched backend's limits](#how-the-stitched-backend-works-and-where-it-falls-short).
- The PNG's SHA-256 in the manifest/checksum file only tells you the file
  hasn't changed since the run — it says nothing about what the lookup site
  itself returned or when, beyond the filename's own timestamp.
- A **renamed export** is the file the query page produced, moved and
  renamed. Its timestamp is when the download started, not when the query
  ran, and the extension records no hash or query text for it.
- A **section capture** shows the part of the section that was on screen
  when the button was pressed; a results grid shows only its visible rows.
  Like exports, it isn't listed in a run's manifest or checksum file.

## Chromium behaviour this extension is built around

These were established empirically by loading the extension into Chromium
and observing the actual failure — not assumed from documentation, which in
a couple of cases doesn't fully spell this out.

1. **`tabs.captureVisibleTab` requires the literal `<all_urls>` host
   permission pattern.** A permission scoped to a named site is refused.
   So, at runtime, is a fully-granted `*://*/*` — the call still fails with
   *"Either the `<all_urls>` or `activeTab` permission is required."*
   `activeTab` cannot substitute: it only ever covers the tab whose toolbar
   icon was just clicked, never a tab this extension opened itself.
2. **`debugger` cannot be requested as an optional permission.** Listing it
   under `optional_permissions` loads fine, but calling
   `chrome.permissions.request` for it at runtime is rejected with *"Only
   permissions specified in the manifest may be requested."* It has to be
   a required permission from install time, which is why the full-page
   backend's warning appears at install rather than being deferrable.
3. **Offscreen documents have `chrome.runtime` and essentially nothing
   else.** Calling `chrome.downloads` from an offscreen document fails with
   *"Cannot read properties of undefined (reading 'download')."* Service
   workers, meanwhile, have no `URL.createObjectURL`. The split this forces:
   the blob URL is minted in the offscreen document (`offscreen.js`), the
   download is issued from the service worker (`background.js` via
   `bg/downloads.js`), and the blob URL is revoked only after
   `chrome.downloads.search` reports the download has reached a terminal
   state — revoking any earlier cancels the download outright.
4. **`chrome.offscreen.createDocument()` can resolve before the document is
   actually listening.** The promise resolves once Chrome has created the
   document, which is not guaranteed to be after the document's own script
   has run and registered its `onMessage` listener — more so for a
   `type="module"` script, which (like `defer`) runs after the document has
   parsed. Messaging it immediately after creation can race that and fail
   with *"Could not establish connection. Receiving end does not exist,"*
   which in practice showed up as the very first screenshot of a run
   failing with no response from the offscreen document. `bg/downloads.js`
   now PINGs the document and waits for a real response before trusting it
   with any work, and recreates it if an already-existing document turns
   out not to be responsive.
5. **`chrome.downloads.onChanged` alone is not a reliable way to know a
   download finished.** A small file can complete before the listener is
   even attached, and the missed event looks exactly like a hang. This
   extension polls `chrome.downloads.search` for a terminal state
   (`complete` or `interrupted`) instead.
6. **An optional API permission granted at runtime is usable straight
   away, with no reload.** After the Options page grants `scripting`, the
   already-running service worker can call `chrome.scripting` immediately.
   And because `scripting` carries no warning of its own, requesting it
   once `<all_urls>` is already granted completes without any dialog. The
   end-to-end test drives exactly this path through the Options page's
   Grant button.
7. **While an extension has a `chrome.downloads.onDeterminingFilename`
   listener, Chromium ignores the `filename` that same extension passes to
   `chrome.downloads.download()`.** The listener is handed Chromium's
   default name instead (`download.txt` for a `data:` URL), and that
   default is what's saved unless the listener suggests the intended name
   back. Observed directly: with the listener calling `suggest()` with no
   arguments, a download requested as `own/dir/own-file.txt` was saved as
   `download.txt` in the Downloads root. So every download this extension
   starts is registered first (`bg/ownDownloads.js`, keyed by its URL) and
   the listener suggests the registered name back for it. The end-to-end
   test checks capture files keep their names with the listener present,
   and fails if that registration is removed.
8. **A download's name isn't settled until every listener has called
   `suggest()`, and a download can only wake a stopped service worker if the
   listener is registered synchronously when the worker starts.**
   `bg/exportRenamer.js` registers it at the top level, removes it again once
   it has read that renaming is off, ends every path in exactly one
   `suggest()` call, and calls `suggest()` with no name if deciding takes
   more than five seconds. The end-to-end test stops the worker and confirms
   the next download wakes it and is renamed.
9. **A content script in Chrome can't ask which of its `<iframe>` elements
   holds a given frameId.** `chrome.runtime.getFrameId()`, which would
   answer that, exists only in Firefox; in Chrome it isn't defined
   (observed: *"chrome.runtime.getFrameId is not a function"*). Capture
   section needs that link to place a section that's inside nested
   cross-origin frames. `bg/sectionCapture.js` gets it with a handshake:
   every frame posts a one-off random nonce to its parent window, the
   parent's script matches the message's `source` to the `<iframe>` whose
   `contentWindow` it is (that comparison works across origins) and records
   the iframe's position, and the nonces returned from each frame's
   injection tie those positions back to frameIds. The end-to-end test
   checks the crop pixel for pixel through two levels of cross-site
   frames.

Two more, not Chromium quirks exactly, but they bit during development:

- An MV3 service worker is torn down after roughly 30 seconds without
  activity, and a pending `setTimeout` does not count as activity. A
  capture batch spends most of its time waiting on page loads and settle
  delays, so `bg/keepalive.js` pokes a trivial `chrome.*` API
  (`chrome.runtime.getPlatformInfo()`) on an interval for the duration of a
  run.
- Naively "adding any default site not currently present" on every load
  will resurrect every default you have deliberately deleted, because
  a deleted default and one that was simply never added look identical from
  that check alone. `common/storage.js` instead tracks which default ids
  existed the last time the merge ran, and only adds a default that is new
  relative to that record.

## Known UX limitation

Chrome/Edge extension popups close as soon as they lose focus — clicking
anywhere outside the popup while a capture batch is running will close it.
The batch itself is **not** affected: it runs in the background service
worker, independent of whether the popup that started it is still open, and
all files are still written and downloaded normally. You simply won't see
live progress until you reopen the popup (which starts a fresh, empty
progress view — the run itself isn't restarted).

## Development

```
npm test        # unit tests for every pure module (indicator parsing,
                 # URL templates, path sanitization, the default-site merge,
                 # backend/permission resolution, the stitched tile plan,
                 # export naming and host filtering)
npm run test:e2e   # loads the built extension into real Chromium via
                    # Playwright: drives the Options self-test for all three
                    # backends, and drives the popup end to end to verify
                    # window reuse, "keep windows open" + Close all, the
                    # Open for review action, and "keep lookups in my
                    # current window" (including that no new browser
                    # window is ever created, and that a stolen-focus
                    # viewport/stitched capture restores the previously-
                    # active tab), all against local test pages; and
                    # Rename exports and Capture section against real
                    # Chromium downloads (see below), including a crop
                    # checked pixel by pixel through nested cross-site
                    # iframes. Test files run one at a time: they share a
                    # display, and two browsers at once fight over focus.
npm run package    # builds the two Web Store upload zips into dist/ (with
                    # and without `debugger`); plain Node, no dependencies
```

The stitched backend's tests decode the captured PNG and check, row by
row, where each part of a test page landed: every band of a tall page at
its exact offset; a fixed header and a fixed footer (the footer inside a
shadow root) once each, at the top and bottom; a sticky bar once, in its
natural position; and an app-style page whose inner panel scrolls. They
also check that the page is left exactly as it was found, that `scripting`
can be granted at runtime from the Options page, and that a build without
`debugger` falls back to stitched. Set `E2E_SAVE_PNGS=/some/dir` to keep
the stitched PNGs for a look.

Set `CHROMIUM_PATH=/path/to/chrome` if Playwright's own Chromium revision
isn't installed.

Three things about the test harness itself:

- It launches Chromium with Playwright's viewport emulation turned off
  (`viewport: null`). By default Playwright emulates a 1280×720 viewport on
  every page it attaches to, including windows the extension opens itself,
  and not always before the extension measures them, so page metrics and
  screenshot sizes disagreed in ways a real browser never produces.
- `e2e/exportRenaming.test.js` and `e2e/sectionCapture.test.js` don't
  launch Chromium through Playwright (shared harness: `e2e/nativeChrome.js`).
  Playwright intercepts every download and saves it under a UUID name,
  which skips Chromium's filename decision entirely — the step Rename
  exports hooks into. They start Chromium themselves with a temp
  Downloads folder, connect Playwright over CDP only to drive pages, and
  reset the browser's download behaviour to Chromium's default, so files
  land under exactly the names Chromium chose and are checked on disk.
- The local fixture server strips the query string before mapping `/` to
  `index.html`. Batch tests navigate to `/?job=1`, `/?job=2`, and before
  this fix those requests got a 404 page. The window-behaviour tests still
  passed, because they only count screenshots.

`common/` holds every pure/testable module (indicator parsing, URL
templates, path sanitization, storage/merge logic, backend selection, the
stitched tile plan) with no browser-API dependency, so it's unit-tested
directly under Node. `bg/` holds the service-worker-side orchestration that
does depend on `chrome.*` APIs (the three capture backends and their shared
tab plumbing, downloads, keepalive, permissions) and is exercised by the
Playwright end-to-end test instead.

## Contributing

Issues and pull requests are welcome — in particular, new entries for
`common/defaultSites.js` for other reputation/lookup sites, following the
existing `{id, name, url, applies, settleMs, enabled, fullscreen, note}`
shape. Please run `npm test` (and `npm run test:e2e` if you're touching
anything in `bg/`) before opening a PR.

## License

[MIT](./LICENSE).

## Privacy

This extension collects, transmits, and shares no data whatsoever — see
[`PRIVACY.md`](./PRIVACY.md) for the full policy.
