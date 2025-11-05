/**
 * @name Federated Reader Bot
 * @version 2.0
 * @description Gmail newsletters to Mastodon with improved deduplication
 * @license MIT
 * @author Wes Fryer
 * @collaborator Claude (Anthropic)
 */

// --- CONFIG ---
const DEFAULT_QUERY =
  '(label:Newsletters OR label:Newsletter OR category:promotions) newer_than:30d';
const MAX_ITEMS_PER_RUN = 20;
const MAX_TOOT_LEN = 500;

// URL deduplication settings
const SEEN_RETENTION_DAYS = 180;
const SEEN_RETENTION_MS = SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// Domain to hashtag mapping
const DOMAIN_TAGS = {
  'substack.com': '#Substack',
  'ghost.io': '#Ghost',
  'platformer.news': '#Ghost',
  'wordpress.com': '#WordPress',
  'wordpress.org': '#WordPress'
};

// --- One-time setup ---
function setup_() {
  if (!getCfg_('MASTODON_BASE_URL') || !getCfg_('MASTODON_TOKEN')) {
    throw new Error('Set MASTODON_BASE_URL and MASTODON_TOKEN in Script Properties.');
  }
  if (!getCfg_('SEEN_IDS')) setCfg_('SEEN_IDS', JSON.stringify({}));
  if (!getCfg_('SEEN_URLS')) setCfg_('SEEN_URLS', JSON.stringify({}));
  Logger.log('Setup complete.');
}

// Optional manual reset
function resetSeen_() {
  props_().deleteProperty('SEEN_IDS');
  props_().deleteProperty('SEEN_URLS');
  Logger.log('SEEN_IDS and SEEN_URLS cleared.');
}

// --- Main entry point ---
function run() {
  const query = getCfg_('QUERY', DEFAULT_QUERY);
  
  // Load state with pruning
  const seenIds = JSON.parse(getCfg_('SEEN_IDS', '{}'));
  const seenUrls = loadSeenUrls_();
  const recentMastoUrls = getRecentPostedUrls_();
  
  // Fetch messages using Gmail API
  const list = Gmail.Users.Messages.list('me', { q: query, maxResults: 50 });
  const msgs = list.messages || [];
  
  const posts_to_make = [];
  
  for (const m of msgs) {
    const id = m.id;
    if (seenIds[id]) continue;
    
    const msg = Gmail.Users.Messages.get('me', id, { format: 'full' });
    const headers = getHeaders_(msg);
    const subject = safeTrim_(headers.Subject || '(no subject)');
    const from = (headers.From || '').toLowerCase();
    const fromDomain = extractDomain_(from);
    const bodies = getBodies_(msg);
    
    // Find best URL using sophisticated link detection
    const url = findCanonicalUrl_(bodies.html, headers) ||
                pickBestHtmlUrl_(bodies.html, fromDomain, subject) ||
                extractFirstPlainUrl_(bodies.text);
    
    if (url) {
      // Clean and normalize the URL
      const cleanedUrl = cleanUrl_(url);
      
      // Check for duplicates using both local and Mastodon history
      if (alreadyPostedUrl_(cleanedUrl, seenUrls, recentMastoUrls)) {
        Logger.log(`Skipping duplicate URL: ${cleanedUrl}`);
        seenIds[id] = Date.now();
        continue;
      }
      
      // Prepare post data
      const authorName = (headers.From || '').replace(/<.*>/, '').replace(/"/g, '').trim();
      const formattedDate = new Date(parseInt(msg.internalDate)).toLocaleDateString('en-US', { 
        month: 'long', 
        day: 'numeric', 
        year: 'numeric' 
      });
      
      posts_to_make.push({
        id: id,
        url: cleanedUrl,
        subject: subject,
        authorName: authorName,
        formattedDate: formattedDate,
        fromDomain: fromDomain
      });
    } else {
      seenIds[id] = Date.now();
    }
  }
  
  // Post to Mastodon
  let posted = 0;
  for (const post of posts_to_make) {
    if (posted >= MAX_ITEMS_PER_RUN) break;
    
    const mainText = `${post.subject} by ${post.authorName} - ${post.formattedDate}`;
    const siteTag = DOMAIN_TAGS[post.fromDomain] || '';
    const globalTags = '#OwnYourFeed #FederatedReader';
    
    let status = `${mainText}\n${post.url}\n\n${siteTag} ${globalTags}`.trim();
    status = truncate_(status, MAX_TOOT_LEN);
    
    if (postToot_(status)) {
      Logger.log(`Posted: ${post.subject}`);
      seenIds[post.id] = Date.now();
      seenUrls[post.url] = Date.now();
      posted++;
    }
  }
  
  // Save state
  setCfg_('SEEN_IDS', JSON.stringify(seenIds));
  saveSeenUrls_(seenUrls);
  
  Logger.log(`Posted ${posted} items.`);
}

// --- Seen URL storage with pruning ---
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
  
  return pruned;
}

function saveSeenUrls_(seen) {
  setCfg_('SEEN_URLS', JSON.stringify(seen));
}

// --- Mastodon recent-history check ---
function getRecentPostedUrls_() {
  // Skip this check by default to avoid API rate limits and permission issues
  // The local SEEN_URLS tracking is sufficient for most use cases
  const skipMastoCheck = getCfg_('SKIP_MASTODON_CHECK', 'true');
  if (skipMastoCheck === 'true') {
    return {};
  }
  
  const base = getCfg_('MASTODON_BASE_URL');
  const token = getCfg_('MASTODON_TOKEN');
  
  if (!base || !token) {
    return {};
  }
  
  const instance = base.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  
  try {
    // Get account ID
    const meRes = UrlFetchApp.fetch(
      `${instance}/api/v1/accounts/verify_credentials`,
      { method: 'get', muteHttpExceptions: true, headers }
    );
    
    if (meRes.getResponseCode() < 200 || meRes.getResponseCode() >= 300) {
      Logger.log(`Mastodon verify_credentials returned: ${meRes.getResponseCode()}`);
      return {};
    }
    
    const me = JSON.parse(meRes.getContentText());
    const accountId = me.id;
    
    // Get recent statuses
    const stRes = UrlFetchApp.fetch(
      `${instance}/api/v1/accounts/${accountId}/statuses?limit=80`,
      { method: 'get', muteHttpExceptions: true, headers }
    );
    
    if (stRes.getResponseCode() < 200 || stRes.getResponseCode() >= 300) {
      Logger.log(`Mastodon statuses returned: ${stRes.getResponseCode()}`);
      return {};
    }
    
    const statuses = JSON.parse(stRes.getContentText());
    const urls = {};
    
    statuses.forEach(st => {
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

// --- Script properties helpers ---
function props_() {
  return PropertiesService.getScriptProperties();
}

function getCfg_(k, d = '') {
  return props_().getProperty(k) || d;
}

function setCfg_(k, v) {
  props_().setProperty(k, v);
}

// --- Gmail helpers ---
function getHeaders_(msg) {
  const h = {};
  const headers = (msg.payload && msg.payload.headers) || [];
  headers.forEach(x => { h[x.name] = x.value; });
  return h;
}

function getBodies_(msg) {
  const res = { text: '', html: '' };
  
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
  return '';
}

// --- URL extraction (sophisticated link detection) ---
function findCanonicalUrl_(html, headers) {
  if (headers && headers['List-Post']) {
    const url = headers['List-Post'].replace(/[<>]/g, '');
    if (isGoodUrl_(url)) {
      return url;
    }
  }
  if (!html) return null;
  
  let m = html.match(/<link[^>]+rel=["']?canonical["']?[^>]*href=["']([^"']+)["']/i);
  if (m && isGoodUrl_(m[1])) return m[1];
  
  m = html.match(/<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
  if (m && isGoodUrl_(m[1])) return m[1];
  
  m = html.match(/<meta[^>]+name=["']twitter:url["'][^>]*content=["']([^"']+)["']/i);
  if (m && isGoodUrl_(m[1])) return m[1];
  
  return null;
}

function pickBestHtmlUrl_(html, fromDomain, subject) {
  if (!html) return null;
  const anchors = extractAnchors_(html);
  if (!anchors.length) return null;
  
  const bad = /unsubscribe|manage\s*preferences|privacy|terms|spam|update\s*profile|email\s+preferences/i;
  const mailto = /^mailto:/i;
  const http = /^https?:\/\//i;
  
  function score(a, idx) {
    if (!a.href || !http.test(a.href)) return -1e6;
    if (mailto.test(a.href)) return -1e6;
    if (bad.test(a.href) || bad.test(a.text)) return -1e6;
    if (a.href.includes('redirect=app-store') || a.href.includes('substack.com/app-link')) return -1e6;
    
    // Filter out common junk URLs
    if (a.href.includes('www.w3.org/1999/xhtml')) return -1e6;
    if (a.href.includes('substackcdn.com/open')) return -1e6;
    if (a.href.includes('email.m.ghost.io/o/')) return -1e6;
    
    let s = 0;
    if (a.fullTag && a.fullTag.includes('class="post-title-link"')) s += 200;
    if (a.text && subject && a.text.trim().toLowerCase() === subject.toLowerCase()) s += 100;
    if (/\bsubstack\.com\/p\//.test(a.href)) s += 50;
    if (fromDomain && a.href.includes(fromDomain)) s += 35;
    if (/view\s+in\s+browser|view\s+online|view this post on the web/i.test(a.text)) s += 30;
    if (/read\s+more|continue\s+reading/i.test(a.text)) s += 20;
    s += Math.max(0, 10 - idx);
    
    return s;
  }
  
  let best = null, bestScore = -1e9;
  anchors.forEach((a, i) => {
    const sc = score(a, i);
    if (sc > bestScore) {
      best = a;
      bestScore = sc;
    }
  });
  
  return best ? best.href : null;
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
      out.push({ href: hrefMatch[1], text: text, fullTag: fullTag });
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
    if (isGoodUrl_(u)) return u;
  }
  return null;
}

function isGoodUrl_(u) {
  if (!u) return false;
  const s = String(u).toLowerCase();
  if (s.startsWith('mailto:')) return false;
  if (s.includes('unsubscribe')) return false;
  if (s.includes('manage-preferences')) return false;
  if (s.includes('www.w3.org/1999/xhtml')) return false;
  if (s.includes('substackcdn.com/open')) return false;
  if (s.includes('email.m.ghost.io/o/')) return false;
  return /^https?:\/\//i.test(u);
}

// --- URL cleaning and normalization ---
function cleanUrl_(u) {
  if (!u) return u;
  try {
    let url = new URL(u);
    
    // Handle Substack redirects
    if (url.hostname === 'substack.com' && url.pathname.startsWith('/redirect/')) {
      const j = url.searchParams.get('j');
      if (j) {
        try {
          const decoded = JSON.parse(
            Utilities.newBlob(
              Utilities.base64Decode(j.split('.')[1].replace(/_/g, '/').replace(/-/g, '+'))
            ).getDataAsString()
          );
          if (decoded.u) {
            url = new URL(`https://${decoded.u}`);
          }
        } catch (e) { /* Fallback */ }
      }
    }
    
    // Check for redirect parameters
    const paramsToCheck = ['redirect', 'url', 'u', 'target', 'r', 'to'];
    for (const name of paramsToCheck) {
      const v = url.searchParams.get(name);
      if (v && /^https?:\/\//i.test(decodeURIComponent(v))) {
        url = new URL(decodeURIComponent(v));
        break;
      }
    }
    
    // Strip tracking parameters
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 
     'mc_cid', 'mc_eid'].forEach(p => url.searchParams.delete(p));
    
    // Normalize hostname (lowercase, strip www)
    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('www.')) {
      hostname = hostname.slice(4);
    }
    
    // Normalize path (remove trailing slashes)
    let path = url.pathname || '/';
    path = path.replace(/\/+$/, '');
    if (path === '') path = '/';
    
    // Return normalized URL without query params
    return `${url.protocol}//${hostname}${path}`;
    
  } catch (e) {
    return u.split('?')[0].replace(/\/+$/, '');
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

// --- Mastodon posting ---
function postToot_(status) {
  const base = getCfg_('MASTODON_BASE_URL');
  const token = getCfg_('MASTODON_TOKEN');
  
  if (!base || !token) {
    Logger.log('Missing MASTODON_BASE_URL or MASTODON_TOKEN.');
    return false;
  }
  
  const url = `${base.replace(/\/+$/,'')}/api/v1/statuses`;
  
  const payload = { status };
  const opts = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(payload)
  };
  
  try {
    const res = UrlFetchApp.fetch(url, opts);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      return true;
    } else {
      const errorMsg = `Mastodon error ${code}: ${res.getContentText().slice(0,500)}`;
      Logger.log(errorMsg);
      // Send email notification if ERROR_EMAIL is configured
      try {
        const errorEmail = getCfg_('ERROR_EMAIL');
        if (errorEmail) {
          MailApp.sendEmail({
            to: errorEmail,
            subject: 'Federated Reader Script Error',
            body: errorMsg
          });
        }
      } catch (mailError) {
        Logger.log('Could not send error email: ' + mailError);
      }
      return false;
    }
  } catch (e) {
    const errorMsg = `Failed to execute UrlFetchApp: ${e.message}`;
    Logger.log(errorMsg);
    // Send email notification if ERROR_EMAIL is configured
    try {
      const errorEmail = getCfg_('ERROR_EMAIL');
      if (errorEmail) {
        MailApp.sendEmail({
          to: errorEmail,
          subject: 'Federated Reader Script Error',
          body: errorMsg
        });
      }
    } catch (mailError) {
      Logger.log('Could not send error email: ' + mailError);
    }
    return false;
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
