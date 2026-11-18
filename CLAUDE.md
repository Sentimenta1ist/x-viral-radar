# x-viral-radar

Chrome MV3 extension (plain JS, no build). Passive: reads rendered tweets on x.com, scores early virality, shows a badge. No calls to X, no automated actions — keep it that way (account safety). The only network call: fresh feed posts (under 3 h, not replies) go in batches every 10 s to the local x-scout app (`POST localhost:8765/api/feed`, through background.js) for its Feed reply queue; x-scout off = dropped.

- `scoring.js` pure scoring, UMD, tested with `node test.js`.
- `content.js` DOM reading, snapshots in `chrome.storage.local`, badge painting.
- `popup.*` top list, settings (hot threshold, tau), CSV export.
- X selectors (`article[data-testid="tweet"]`, group `aria-label`) are the fragile part.
- Context and decisions: `~/dev/brain` (factory/2-areas/x.md, backlog #53).
