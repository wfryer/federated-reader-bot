/**
 * @name Federated Reader Bot
 * @version 1.4
 * @description A Google Apps Script that converts Gmail newsletters into a Mastodon feed, creating a self-hosted, federated reader.
 * @license MIT
 * @author Wes Fryer
 * @collaborator Gemini
 */
/*** Federated Reader: Gmail → Mastodon (read-only), v1.4 ***/
/* Tagline: Turn email newsletters into a news reader you control. */

// --- CONFIG (override via Script Properties) ---
const DEFAULT_QUERY =
  '(label:Newsletters OR label:Newsletter OR category:promotions) newer_than:30d';
const MAX_ITEMS_PER_RUN = 20; // safety cap
const MAX_TOOT_LEN = 500; // Mastodon default
const POST_WITHOUT_URL = getBool_('POST_WITHOUT_URL', false); // default: require URL

// Simple sender-domain → hashtag mapping
const DOMAIN_TAGS = {
  'substack.com': '#Substack',
  'ghost.io': '#Ghost',
  'platformer.news': '#Ghost',
  'wordpress.com': '#WordPress',
  'wordpress.org': '#WordPress'
};

// ---------- One-time setup ----------
function setup_() {
  if (!getCfg_('MASTODON_BASE_URL') || !getCfg_('MASTODON_TOKEN')) {
    throw new Error('Set MASTODON_BASE_URL and MASTODON_TOKEN in Script Properties.');
  }
  if (!getCfg_('SEEN_IDS')) setCfg_('SEEN_IDS', JSON.stringify({}));
  Logger.log('Setup complete.');
}

// ---------- Main job ----------
function run() {
  // resetSeen_(); // This is now disabled for normal operation. Run it manually if you need to re-process old emails.

  const query = getCfg_('QUERY', DEFAULT_QUERY);
  const seen = JSON.parse(getCfg_('SEEN_IDS', '{}'));
  const list = Gmail.Users.Messages.list('me', { q: query, maxResults: 50 });
  const msgs = list.messages || [];

  const posts_to_make = [];

  for (const m of msgs) {
    const id = m.id;
    if (seen[id]) continue;

    const msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
    const headers = getHeaders_(msg);
    const subject = safeTrim_(headers.Subject || '(no subject)');
    const from = (headers.From || '').toLowerCase();
    const fromDomain = extractDomain_(from);
    const bodies = getBodies_(msg);
    
    const url = findCanonicalUrl_(bodies.html, headers) ||
                pickBestHtmlUrl_(bodies.html, fromDomain, subject) ||
                extractFirstPlainUrl_(bodies.text);

    if (url) {
      if (seen[url] || posts_to_make.some(p => p.url === url)) {
        Logger.log(`Skipping duplicate URL: ${url}`);
        seen[id] = Date.now();
        continue;
      }
      
      const authorName = (headers.From || '').replace(/<.*>/, '').replace(/"/g, '').trim();
      const formattedDate = new Date(parseInt(msg.internalDate)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

      posts_to_make.push({
        id: id,
        url: url,
        subject: subject,
        authorName: authorName,
        formattedDate: formattedDate,
        fromDomain: fromDomain
      });
    } else {
        seen[id] = Date.now();
    }
  }

  let posted = 0;
  for (const post of posts_to_make) {
    if (posted >= MAX_ITEMS_PER_RUN) break;

    const mainText = `${post.subject} by ${post.authorName} - ${post.formattedDate}`;
    const siteTag = DOMAIN_TAGS[post.fromDomain] || '';
    const globalTags = '#OwnYourFeed #FederatedReader';
    
    let status = `${mainText}\n${post.url}\n\n${siteTag} ${globalTags}`.trim();
    status = truncate_(status, MAX_TOOT_LEN);

    if (postToot_(status)) {
      seen[post.id] = Date.now();
      seen[post.url] = Date.now();
      posted++;
    }
  }

  setCfg_('SEEN_IDS', JSON.stringify(seen));
  Logger.log(`Posted ${posted} items.`);
}


// ---------- Script properties helpers ----------
function props_() {
  return PropertiesService.getScriptProperties();
}

function getCfg_(k, d = '') {
  return props_().getProperty(k) || d;
}

function setCfg_(k, v) {
  props_().setProperty(k, v);
}

function getBool_(k, d = false) {
  const v = getCfg_(k, '');
  if (v === '') return d;
  return String(v).toLowerCase() === 'true';
}


// ---------- Gmail helpers (read-only) ----------
function getHeaders_(msg) {
  const h = {};
  const headers = (msg.payload && msg.payload.headers) || [];
  headers.forEach(x => {
    h[x.name] = x.value;
  });
  return h;
}

function getBodies_(msg) {
  const res = {
    text: '',
    html: ''
  };

  function walk(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body && p.body.data) {
      res.text += decode_(p.body.data) + '\n';
    } else if (p.mimeType === 'text/html' && p.body && p.body.data) {
      res.html += decode_(p.body.data) + '\n';
    } else if (p.parts) {
      p.parts.forEach(walk);
    }
  }
  walk(msg.payload);
  return res;
}

function decode_(data) {
  if (!data) return '';
  if (typeof data === 'string') {
    const s = data.replace(/-/g, '+').replace(/_/g, '/');
    try {
      return Utilities.newBlob(Utilities.base64Decode(s)).getDataAsString('UTF-8');
    } catch (e) {
      return '';
    }
  }
  if (Array.isArray(data)) {
    try {
      return Utilities.newBlob(data).getDataAsString('UTF-8');
    } catch (e) {
      return '';
    }
  }
  return '';
}

// ---------- URL extraction ----------
function findCanonicalUrl_(html, headers) {
  if (headers && headers['List-Post']) {
    const url = headers['List-Post'].replace(/[<>]/g, '');
    if (isGoodUrl_(url)) {
      return cleanUrl_(url);
    }
  }
  if (!html) return null;
  let m = html.match(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i);
  if (m && isGoodUrl_(m[1])) return cleanUrl_(m[1]);
  m = html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  if (m && isGoodUrl_(m[1])) return cleanUrl_(m[1]);
  m = html.match(/<meta[^>]+name=["']twitter:url["'][^>]*content=["']([^"']+)["']/i);
  if (m && isGoodUrl_(m[1])) return cleanUrl_(m[1]);
  return null;
}

function pickBestHtmlUrl_(html, fromDomain, subject) {
  if (!html) return null;
  const anchors = extractAnchors_(html);
  if (!anchors.length) return null;

  const bad = /unsubscribe|manage\s*preferences|privacy|terms|spam|update\s*profile|email\s+preferences/i;
  const mailto = /^mailto:/i;
  const http = /^https?:\/\//i;

  function score(a, idx, fromDomain, subject) {
    if (!a.href || !http.test(a.href)) return -1e6;
    if (mailto.test(a.href)) return -1e6;
    if (bad.test(a.href) || bad.test(a.text)) return -1e6;
    if (a.href.includes('redirect=app-store') || a.href.includes('substack.com/app-link')) return -1e6;

    let s = 0;
    if (a.fullTag && a.fullTag.includes('class="post-title-link"')) {
        s += 200;
    }
    if (a.text && subject && a.text.trim().toLowerCase() === subject.toLowerCase()) {
      s += 100;
    }
    if (/\bsubstack\.com\/p\//.test(a.href)) s += 50;
    if (fromDomain && a.href.includes(fromDomain)) s += 35;
    if (/view\s+in\s+browser|view\s+online|view this post on the web/i.test(a.text)) s += 30;
    if (/read\s+more|continue\s+reading/i.test(a.text)) s += 20;

    s += Math.max(0, 10 - idx);
    return s;
  }

  let best = null,
    bestScore = -1e9;
  anchors.forEach((a, i) => {
    const sc = score(a, i, fromDomain, subject);
    if (sc > bestScore) {
      best = a;
      bestScore = sc;
    }
  });
  return best ? cleanUrl_(best.href) : null;
}

function extractAnchors_(html) {
    const out = [];
    const re = /<a\s+([^>]+)>(.*?)<\/a>/ig;
    let m;
    while ((m = re.exec(html)) !== null) {
        const fullTag = m[0];
        const attributes = m[1];
        const text = stripTags_(m[2] || '').trim();

        const hrefMatch = attributes.match(/href=["']([^"']+)["']/);
        if (hrefMatch && hrefMatch[1]) {
            out.push({
                href: hrefMatch[1],
                text: text,
                fullTag: fullTag
            });
        }
    }
    return out;
}

function stripTags_(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
}

function extractFirstPlainUrl_(text) {
  if (!text) return null;
  const candidates = text.match(/https?:\/\/[^\s"'<>]+/ig) || [];
  for (const u of candidates) {
    if (isGoodUrl_(u)) return cleanUrl_(u);
  }
  return null;
}

function isGoodUrl_(u) {
  if (!u) return false;
  const s = String(u).toLowerCase();
  if (s.startsWith('mailto:')) return false;
  if (s.includes('unsubscribe')) return false;
  if (s.includes('manage-preferences')) return false;
  if (s.includes('privacy')) return false;
  if (s.includes('terms')) return false;
  return /^https?:\/\//i.test(u);
}

function cleanUrl_(u) {
  try {
    let url = new URL(u);
    if (url.hostname === 'substack.com' && url.pathname.startsWith('/redirect/')) {
      const j = url.searchParams.get('j');
      if (j) {
        try {
          const decoded = JSON.parse(Utilities.newBlob(Utilities.base64Decode(j.split('.')[1].replace(/_/g, '/').replace(/-/g, '+'))).getDataAsString());
          if (decoded.u) {
            u = `https://${decoded.u}`;
            url = new URL(u);
          }
        } catch (e) { /* Fallback */ }
      }
    }

    const paramsToCheck = ['redirect', 'url', 'u', 'target', 'r', 'to'];
    for (const name of paramsToCheck) {
      const v = url.searchParams.get(name);
      if (v && /^https?:\/\//i.test(decodeURIComponent(v))) {
        url = new URL(decodeURIComponent(v));
        break;
      }
    }
    
    // Normalize the URL by removing all query parameters
    let finalUrl = url.origin + url.pathname;
    
    return finalUrl;

  } catch (e) {
    return u.split('?')[0]; // Fallback normalization
  }
}

function extractDomain_(fromHeader) {
  const emailMatch = fromHeader.match(/<([^>]+)>/) ||
    fromHeader.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  const whole = emailMatch ? emailMatch[1] || emailMatch[0] : '';
  const at = whole.lastIndexOf('@');
  const domain = at >= 0 ? whole.slice(at + 1) : whole;
  return (domain || '').toLowerCase();
}

// ---------- Mastodon + misc ----------
function postToot_(status) {
  const base = getCfg_('MASTODON_BASE_URL');
  const token = getCfg_('MASTODON_TOKEN');
  const url = `${base.replace(/\/+$/,'')}/api/v1/statuses`;

  const payload = {
    status
  };
  const opts = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: `Bearer ${token}`
    },
    payload: JSON.stringify(payload),
  };
  
  try {
    const res = UrlFetchApp.fetch(url, opts);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      return true; // Success
    } else {
      // Log the error and notify via email
      const errorMsg = `Mastodon error ${code}: ${res.getContentText().slice(0,500)}`;
      Logger.log(errorMsg);
      MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Federated Reader Script Error', errorMsg);
      return false; // Failure
    }
  } catch (e) {
    // Catch network errors or other exceptions
    const errorMsg = `Failed to execute UrlFetchApp: ${e.message}`;
    Logger.log(errorMsg);
    MailApp.sendEmail(Session.getActiveUser().getEmail(), 'Federated Reader Script Error', errorMsg);
    return false; // Failure
  }
}

function truncate_(s, n) {
  if (!s) return s;
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function safeTrim_(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// ---------- Utilities you can run manually ----------
function resetSeen_() {
  PropertiesService.getScriptProperties().deleteProperty('SEEN_IDS');
  Logger.log('SEEN_IDS cleared.');
}