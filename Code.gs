// Federated Reader Bot — v2 with stronger de-duplication
// - Normalizes URLs more aggressively
// - Remembers seen URLs in SEEN_URLS with pruning
// - Also checks recent Mastodon posts so you don't re-share links
//   even if local script properties were cleared

// --- Config ---

const DEFAULT_QUERY =
  'label:Newsletters OR category:promotions newer_than:3d';
const MAX_ITEMS_PER_RUN = 20;   // safety cap so we don’t spam
const MAX_TOOT_LEN = 500;       // Mastodon default character limit

// How long to remember that we've already posted a URL
const SEEN_RETENTION_DAYS = 180;
const SEEN_RETENTION_MS = SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// --- Script Properties helpers ---

function props_() {
  return PropertiesService.getScriptProperties();
}

function getCfg_(k, d = '') {
  return props_().getProperty(k) || d;
}

function setCfg_(k, v) {
  props_().setProperty(k, v);
}

// --- One-time setup ---

function setup_() {
  if (!getCfg_('MASTODON_BASE_URL') || !getCfg_('MASTODON_TOKEN')) {
    throw new Error(
      'Set MASTODON_BASE_URL and MASTODON_TOKEN in Script Properties.'
    );
  }

  if (!getCfg_('SEEN_IDS')) {
    setCfg_('SEEN_IDS', JSON.stringify({}));
  }
  if (!getCfg_('SEEN_URLS')) {
    setCfg_('SEEN_URLS', JSON.stringify({}));
  }

  Logger.log('Setup complete.');
}

// Optional: manual reset if you *really* want to clear memory
function resetSeen_() {
  props_().deleteProperty('SEEN_IDS');
  props_().deleteProperty('SEEN_URLS');
  Logger.log('SEEN_IDS and SEEN_URLS cleared. (You may get reposts.)');
}

// --- Main entry point ---

function run() {
  const query = getCfg_('QUERY', DEFAULT_QUERY);

  // 1) Load state
  const threads = GmailApp.search(query, 0, 50); // up to 50 recent threads
  const seenIds = JSON.parse(getCfg_('SEEN_IDS', '{}'));
  const seenUrls = loadSeenUrls_();
  const recentMastoUrls = getRecentPostedUrls_();

  let posted = 0;

  for (const th of threads) {
    const msg = th.getMessages().pop(); // latest message in thread
    const id = msg.getId();

    // Skip if we've already processed this Gmail message ID
    if (seenIds[id]) {
      continue;
    }

    const subject = safeTrim_(msg.getSubject());
    const html = msg.getBody();
    const plain = msg.getPlainBody();

    // Extract & normalize first URL we find
    const rawUrl = extractFirstUrl_(html) || extractFirstUrl_(plain);
    const url = rawUrl ? cleanUrl_(rawUrl) : null;

    // Compose status line
    let status = subject || '(no subject)';
    if (url) {
      status = `${status} — ${url}`;
    }
    status = truncate_(status, MAX_TOOT_LEN);

    // De-duplication: if URL exists and we've already posted it, skip
    if (url && alreadyPostedUrl_(url, seenUrls, recentMastoUrls)) {
      Logger.log(`Skipping duplicate URL: ${url}`);
      // We still mark the Gmail message as seen so we don't re-evaluate it
      seenIds[id] = Date.now();
      continue;
    }

    // Post to Mastodon
    if (postToot_(status)) {
      Logger.log(`Posted: ${status}`);
      seenIds[id] = Date.now();

      if (url) {
        seenUrls[url] = Date.now();
      }

      posted++;
    }

    if (posted >= MAX_ITEMS_PER_RUN) {
      break;
    }
  }

  // 2) Save updated state
  setCfg_('SEEN_IDS', JSON.stringify(seenIds));
  saveSeenUrls_(seenUrls);

  Logger.log(`Posted ${posted} items.`);
}

// --- Seen URL storage (Script Properties with pruning) ---

function loadSeenUrls_() {
  const raw = getCfg_('SEEN_URLS', '{}');
  let seen;
  try {
    seen = JSON.parse(raw);
  } catch (e) {
    Logger.log('Failed to parse SEEN_URLS, resetting. ' + e);
    seen = {};
  }

  const now = Date.now();
  const pruned = {};

  for (const key in seen) {
    if (!Object.prototype.hasOwnProperty.call(seen, key)) continue;
    const ts = seen[key];
    if (typeof ts === 'number' && now - ts < SEEN_RETENTION_MS) {
      pruned[key] = ts;
    }
  }

  setCfg_('SEEN_URLS', JSON.stringify(pruned));
  return pruned;
}

function saveSeenUrls_(seen) {
  setCfg_('SEEN_URLS', JSON.stringify(seen));
}

// --- Mastodon recent-history guardrail ---

function getRecentPostedUrls_() {
  const base = getCfg_('MASTODON_BASE_URL');
  const token = getCfg_('MASTODON_TOKEN');

  if (!base || !token) {
    Logger.log('Missing Mastodon config; skipping recent URL check.');
    return {};
  }

  const instance = base.replace(/\/+$/, '');
  const headers = {
    Authorization: `Bearer ${token}`
  };

  try {
    // 1) Who am I?
    const meRes = UrlFetchApp.fetch(
      `${instance}/api/v1/accounts/verify_credentials`,
      {
        method: 'get',
        muteHttpExceptions: true,
        headers
      }
    );
    if (meRes.getResponseCode() < 200 || meRes.getResponseCode() >= 300) {
      Logger.log(
        `Error verifying Mastodon credentials: ${meRes.getResponseCode()} ${meRes
          .getContentText()
          .slice(0, 300)}`
      );
      return {};
    }
    const me = JSON.parse(meRes.getContentText());
    const accountId = me.id;

    // 2) Get recent statuses (you can increase limit if desired)
    const stRes = UrlFetchApp.fetch(
      `${instance}/api/v1/accounts/${accountId}/statuses?limit=80`,
      {
        method: 'get',
        muteHttpExceptions: true,
        headers
      }
    );

    if (stRes.getResponseCode() < 200 || stRes.getResponseCode() >= 300) {
      Logger.log(
        `Error fetching recent Mastodon statuses: ${
          stRes.getResponseCode()
        } ${stRes.getContentText().slice(0, 300)}`
      );
      return {};
    }

    const statuses = JSON.parse(stRes.getContentText());
    const urls = {};

    statuses.forEach(st => {
      // Very simple URL scrape from HTML content
      const matches = (st.content || '').match(/https?:\/\/[^\s<">]+/g) || [];
      matches.forEach(raw => {
        const u = cleanUrl_(raw);
        urls[u] = true;
      });
    });

    return urls;
  } catch (e) {
    Logger.log('Error in getRecentPostedUrls_: ' + e);
    return {};
  }
}

function alreadyPostedUrl_(url, seenUrls, recentMastoUrls) {
  if (!url) return false;
  if (seenUrls[url]) return true;
  if (recentMastoUrls && recentMastoUrls[url]) return true;
  return false;
}

// --- Mastodon posting ---

function postToot_(status) {
  const base = getCfg_('MASTODON_BASE_URL');
  const token = getCfg_('MASTODON_TOKEN');

  if (!base || !token) {
    Logger.log('Missing MASTODON_BASE_URL or MASTODON_TOKEN.');
    return false;
  }

  const url = `${base.replace(/\/+$/, '')}/api/v1/statuses`;
  const payload = { status };

  const opts = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(payload)
  };

  const res = UrlFetchApp.fetch(url, opts);
  const code = res.getResponseCode();

  if (code >= 200 && code < 300) {
    return true;
  }

  Logger.log(
    `Mastodon error ${code}: ${res.getContentText().slice(0, 500)}`
  );
  return false;
}

// --- URL extraction & normalization ---

function extractFirstUrl_(text) {
  if (!text) return null;
  const re = /(https?:\/\/[^\s"'<>]+)/i;
  const m = text.match(re);
  return m ? m[1] : null;
}

function cleanUrl_(u) {
  if (!u) return u;
  try {
    let url = new URL(u);

    // 1) Strip common tracking parameters
    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'mc_cid',
      'mc_eid'
    ].forEach(p => url.searchParams.delete(p));

    // 2) Canonicalize host: lowercase + strip leading www.
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }

    // Example of optional host normalization if needed:
    // const HOST_ALIASES = {
    //   'm.nytimes.com': 'nytimes.com'
    // };
    // if (HOST_ALIASES[hostname]) {
    //   hostname = HOST_ALIASES[hostname];
    // }

    // 3) Normalize path: remove trailing slashes except root
    let path = url.pathname || '/';
    path = path.replace(/\/+$/, '');
    if (path === '') path = '/';

    // 4) Rebuild without query/hash (we've already stripped tracking params)
    const finalUrl = `${url.protocol}//${hostname}${path}`;
    return finalUrl;
  } catch (e) {
    // Fallback: strip query & trailing slash if URL constructor failed
    let base = u.split('?')[0];
    base = base.replace(/\/+$/, '');
    return base;
  }
}

// --- Misc helpers ---

function truncate_(s, n) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function safeTrim_(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}
