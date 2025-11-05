# Changelog

## v2.5 – URL cleaning & dedupe refinements (2025-11-05) - via ChatGPT analyzing changes recommended by Claude AI

This release keeps the original "smart URL" logic (canonical tags + anchor scoring)
but tightens how links are cleaned, filtered, and de-duplicated.

- **Restored and clarified URL selection pipeline**
  - Use `List-Post` header and canonical/meta tags (`<link rel="canonical">`,
    `og:url`, `twitter:url`) when available.
  - Score all HTML `<a>` tags by subject match, sender domain, and “view in browser /
    read more” patterns, while avoiding unsubscribe / privacy / preference links.
  - Fall back to first good plain-text URL if needed.

- **Improved URL normalization**
  - Decode Substack `/redirect` links by unpacking the `j` parameter when possible.
  - Follow common redirect-style query parameters (`redirect`, `url`, `u`, `target`, `r`, `to`)
    when they contain full URLs.
  - Strip common tracking parameters (`utm_*`, `mc_cid`, `mc_eid`), lowercase hostnames,
    remove `www.`, and trim trailing slashes so equivalent URLs normalize to the same form.

- **Stronger junk-link filtering**
  - Explicitly ignore boilerplate / tracking URLs such as:
    - `https://www.w3.org/1999/xhtml` (XHTML namespace),
    - `https://*.substackcdn.com/open` (Substack open pixel),
    - `https://email.m.ghost.io/o/...` (broken Ghost click-tracking links in some emails).
  - These will no longer show up in the Mastodon feed.

- **Refined de-duplication**
  - Continue tracking `SEEN_IDS` (Gmail message IDs) and `SEEN_URLS` (cleaned URLs) in
    Script Properties, pruning entries older than `SEEN_RETENTION_DAYS` (default: 180 days).
  - `alreadyPostedUrl_()` checks both local `SEEN_URLS` and,
    optionally, URLs in recent Mastodon statuses.
  - Mastodon history check is disabled by default via the `SKIP_MASTODON_CHECK` property to
    avoid scope and rate-limit issues.

- **Better Mastodon posts and error handling**
  - New post format including subject, author name, and date on the first line,
    the URL on the second line, and optional site + global hashtags
    (e.g. `#Substack #OwnYourFeed #FederatedReader`).
  - `postToot_()` now logs detailed errors and can send an email alert to `ERROR_EMAIL`
    when Mastodon calls fail.


## v2.4 – Smarter links & de-duplication (2025-11-04) - via ChatGPT

- **Improved URL extraction**
  - Bot now scans *all* URLs in each email (HTML + plain text) and picks the first **non-junk** one.
  - Ignores known tracking / boilerplate URLs, including:
    - `https://www.w3.org/1999/xhtml/` (XHTML namespace)
    - `https://*.substackcdn.com/open` (Substack open-pixel / tracking)
    - `http(s)://email.m.ghost.io/o/...` and `http(s)://email.ghost.io/o/...` (Ghost click-tracking redirects)

- **URL normalization ("canonicalization")**
  - Lowercases hostnames and strips leading `www.`.
  - Removes trailing slashes from paths (except the root `/`).
  - Strips common tracking query parameters (`utm_*`, `mc_cid`, `mc_eid`, etc.).
  - Helps treat small variations of the same link as a single canonical URL for de-duplication.

- **Stronger de-duplication logic**
  - `SEEN_URLS` now stores normalized URLs plus timestamps and is **pruned** based on a `SEEN_RETENTION_DAYS` window (default: 180 days).
  - `SEEN_IDS` (Gmail message IDs) is also pruned so Script Properties don’t grow indefinitely and hit quota limits.
  - Duplicate URLs are skipped gracefully, while the associated Gmail messages are still marked as “seen” so they’re not re-processed every hour.

- **More resilient Mastodon posting**
  - `postToot_()` is wrapped in `try/catch` to handle temporary network / instance errors without crashing the whole run.
  - Mastodon history check (to avoid reposting URLs from recent statuses) is now **optional** and controlled by the `USE_MASTODON_HISTORY` Script Property (default: `false`).

- **Quality-of-life configuration**
  - `POST_WITHOUT_URL` Script Property controls whether subject-only posts are allowed (default: `false`).
  - `MAX_ITEMS_PER_RUN` and `SEEN_RETENTION_DAYS` can be customized via Script Properties without changing code.
  - Simple `DOMAIN_TAGS` map adds automatic hashtags (e.g., `#Substack`, `#Ghost`, `#WordPress`) based on sender domain.
  
