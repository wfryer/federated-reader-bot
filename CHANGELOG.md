# Changelog

## v2.4 – Smarter links & de-duplication (2025-11-04)

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
  