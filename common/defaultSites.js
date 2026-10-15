// Data-driven site registry. Each record:
// {id, name, url, applies, settleMs, enabled, fullscreen, note}
// `applies` gates which indicator kinds a site is offered for.
// `fullscreen` maximizes the capture window for that site before capturing
// (some sites render more detail — maps, graphs, dashboards — given more
// screen space).
// URL templates use placeholders documented in urlTemplate.js.

/** @typedef {"ipv4"|"ipv6"|"domain"|"url"|"hash"} IndicatorKind */

/**
 * @typedef {Object} SiteRecord
 * @property {string} id
 * @property {string} name
 * @property {string} url
 * @property {IndicatorKind[]} applies
 * @property {number} settleMs
 * @property {boolean} enabled
 * @property {boolean} [fullscreen] - maximize the capture window before capturing this site
 * @property {string} [note]
 * @property {boolean} [isDefault] - marks a built-in (vs analyst-added) site
 */

/** @type {SiteRecord[]} */
export const DEFAULT_SITES = [
  // Shipped enabled by default — everything else below starts disabled
  // and can be ticked on in Options.
  {
    id: "abuseipdb",
    name: "AbuseIPDB",
    url: "https://www.abuseipdb.com/check/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 3000,
    enabled: true,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "virustotal-ip",
    name: "VirusTotal (IP)",
    url: "https://www.virustotal.com/gui/ip-address/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 7000,
    enabled: true,
    fullscreen: false,
    isDefault: true,
    note: "Renders far more detail when already signed in; uses the existing browser session.",
  },
  {
    id: "virustotal-domain",
    name: "VirusTotal (domain)",
    url: "https://www.virustotal.com/gui/domain/{host}",
    applies: ["domain"],
    settleMs: 7000,
    enabled: true,
    fullscreen: false,
    isDefault: true,
    note: "Renders far more detail when already signed in; uses the existing browser session.",
  },
  {
    id: "virustotal-url",
    name: "VirusTotal (URL)",
    url: "https://www.virustotal.com/gui/url/{vtUrlId}",
    applies: ["url"],
    settleMs: 7000,
    enabled: true,
    fullscreen: false,
    isDefault: true,
    note: "Renders far more detail when already signed in; uses the existing browser session.",
  },
  {
    id: "virustotal-file",
    name: "VirusTotal (file hash)",
    url: "https://www.virustotal.com/gui/file/{indicator}",
    applies: ["hash"],
    settleMs: 7000,
    enabled: true,
    fullscreen: false,
    isDefault: true,
    note: "Renders far more detail when already signed in; uses the existing browser session.",
  },
  {
    id: "ip-teoh-io",
    name: "ip.teoh.io",
    url: "https://ip.teoh.io/geolocation/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 3000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "urlscan-ip",
    name: "urlscan.io (IP)",
    url: "https://urlscan.io/ip/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "urlscan-domain",
    name: "urlscan.io (domain/URL)",
    url: "https://urlscan.io/domain/{host}",
    applies: ["domain", "url"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "urlvoid",
    name: "URLVoid",
    url: "https://www.urlvoid.com/scan/{host}/",
    applies: ["domain", "url"],
    settleMs: 3000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "ipvoid",
    name: "IPVoid",
    url: "https://www.ipvoid.com/scan/{host}/",
    applies: ["ipv4"],
    settleMs: 3000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "shodan",
    name: "Shodan",
    url: "https://www.shodan.io/host/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
    note: "Renders far more detail when already signed in; uses the existing browser session.",
  },
  {
    id: "greynoise",
    name: "GreyNoise",
    url: "https://viz.greynoise.io/ip/{host}",
    applies: ["ipv4"],
    settleMs: 5000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
    note: "Renders far more detail when already signed in; uses the existing browser session.",
  },
  {
    id: "spur",
    name: "Spur",
    url: "https://app.spur.us/context/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
    note: "Requires a signed-in Spur account (the free Community tier works); uses the existing browser session.",
  },

  {
    id: "talos",
    name: "Cisco Talos Reputation Center",
    url: "https://talosintelligence.com/reputation_center/lookup?search={hostEncoded}",
    applies: ["ipv4", "ipv6", "domain", "url"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "censys",
    name: "Censys",
    url: "https://search.censys.io/hosts/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "otx-ip",
    name: "AlienVault OTX (IP)",
    url: "https://otx.alienvault.com/indicator/ip/{host}",
    applies: ["ipv4", "ipv6"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "otx-domain",
    name: "AlienVault OTX (domain)",
    url: "https://otx.alienvault.com/indicator/domain/{host}",
    applies: ["domain"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "pulsedive",
    name: "Pulsedive",
    url: "https://pulsedive.com/indicator/?ioc={encoded}",
    applies: ["ipv4", "ipv6", "domain", "url"],
    settleMs: 4000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "who-is",
    name: "who.is",
    url: "https://who.is/whois/{host}",
    applies: ["domain"],
    settleMs: 3000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
  {
    id: "mxtoolbox-blacklist",
    name: "MXToolbox Blacklist Check",
    url: "https://mxtoolbox.com/SuperTool.aspx?action=blacklist%3a{hostEncoded}",
    applies: ["ipv4", "domain"],
    settleMs: 5000,
    enabled: false,
    fullscreen: false,
    isDefault: true,
  },
];
