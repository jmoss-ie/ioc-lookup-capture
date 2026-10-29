// The version this code is. Must match manifest.json (a unit test checks).
//
// Why it exists: after an unpacked install's files are replaced, Chrome can
// carry on running the previous version's background code — through a
// browser restart — until the extension is reloaded on chrome://extensions,
// while the popup and Options pages already load the new files. The
// background reports this constant with its state; the pages compare it with
// manifest.json (always read fresh) and offer a Reload when they differ.
export const CODE_VERSION = "1.9.0";
