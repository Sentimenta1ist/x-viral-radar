// Virality scoring for a single X post. Pure functions, no DOM, no network.
// Used by content.js (browser) and test.js (node).
(function (root) {
  const DEFAULTS = {
    tau: 150,          // minutes: views accumulate as 1 - exp(-t / tau). Assumption, calibrate from exported data.
    hotScore: 70,
    risingScore: 45,
    minViews: 30,
    maxAgeMin: 360,    // older posts are not flagged
    weights: { reply: 3, repost: 2, like: 1, bookmark: 2 },
    // reply value: how many people will still open this thread and could see a fresh reply
    // Own data, 249 replies 2026-11-04..16: median views 252 under posts < 1 h old, 177 at 1-3 h, 108 at 3-8 h;
    // 482 at < 3 replies per 10k post views, 92 at 10+; every reply under a 2000+ reply thread stayed under 30 views.
    replyMaxAgeMin: 180,   // older threads are mostly done: no reply score
    crowdPer10k: 5,        // replies per 10k views where a new reply gets about half the visibility
    crowdMaxReplies: 2000, // past this a new reply is never seen
    replyMin: 1000,        // remaining views -> 0
    replyMax: 200000,      // remaining views -> 100
  };

  const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

  function lifetimeFraction(ageMin, tau) {
    return 1 - Math.exp(-Math.max(ageMin, 1) / tau);
  }

  // Expected final views if the post follows the decay curve. Fraction floored to avoid wild jumps for very young posts.
  function projectViews(views, ageMin, cfg) {
    return views / Math.max(lifetimeFraction(ageMin, cfg.tau), 0.15);
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Reply value (Nov 2026). X shows replies from accounts you don't follow only inside the thread (OONRetweetReplyFilter
  // in xai-org/x-algorithm), so a reply is seen by people who open the thread later. Value = views still to come
  // (projection minus views so far) x share left after the crowd of earlier replies x current acceleration.
  function replyValue(views, ageMin, replies, projected, accelRatio, cfg) {
    if (ageMin > cfg.replyMaxAgeMin || !projected) return { score: 0, remaining: 0, crowd: 0 };
    const remaining = Math.max(projected - views, 0);
    // replies per viewer, not the raw count; views floored at 5000 so a young post's first replies don't count as a crowd
    const perView = (replies || 0) / Math.max(views || 0, 5000) * 10000;
    const crowd = (replies || 0) >= cfg.crowdMaxReplies ? 0 : 1 / (1 + perView / cfg.crowdPer10k);
    const accel = accelRatio == null ? 1 : Math.min(2, Math.max(0.5, accelRatio));
    const v = remaining * crowd * accel;
    const s = v <= cfg.replyMin ? 0 : clamp((Math.log(v / cfg.replyMin) / Math.log(cfg.replyMax / cfg.replyMin)) * 100);
    return { score: Math.round(s), remaining, crowd };
  }

  // tweet: {views, likes, replies, reposts, bookmarks, ageMin}
  // ctx:   {authorProjected: number[] (past projected finals of this author), prev: {views, ageMin} | null}
  function score(tweet, ctx = {}, userCfg = {}) {
    const cfg = { ...DEFAULTS, ...userCfg, weights: { ...DEFAULTS.weights, ...(userCfg.weights || {}) } };
    const { views, ageMin } = tweet;
    if (!(views >= cfg.minViews) || !(ageMin >= 2)) {
      return { score: 0, label: 'low-data', parts: {}, projected: null, vpm: views / Math.max(ageMin, 1), confidence: 0, reply: { score: 0, remaining: 0, crowd: 0 } };
    }

    const projected = projectViews(views, ageMin, cfg);
    const vpm = views / ageMin;
    const w = cfg.weights;
    const eng = w.reply * (tweet.replies || 0) + w.repost * (tweet.reposts || 0) + w.like * (tweet.likes || 0) + w.bookmark * (tweet.bookmarks || 0);
    const er = eng / views;

    const parts = {};
    // 1k projected -> 0, 500k -> 100 (log scale)
    parts.size = clamp((Math.log10(projected / 1000) / Math.log10(500)) * 100);
    // weighted engagement per view: 1% -> 0, 6% -> 100
    parts.engagement = clamp(((er - 0.01) / 0.05) * 100);

    const base = ctx.authorProjected && ctx.authorProjected.length >= 3 ? median(ctx.authorProjected) : null;
    if (base && base > 0) {
      // 1x author's normal -> 0, 8x -> 100
      parts.relative = clamp((Math.log2(projected / base) / 3) * 100);
    }

    if (ctx.prev && ageMin - ctx.prev.ageMin >= 2 && views > ctx.prev.views) {
      const dt = ageMin - ctx.prev.ageMin;
      const recent = (views - ctx.prev.views) / dt;
      // instantaneous / average rate expected from the decay model at this age
      const expected = (Math.exp(-ageMin / cfg.tau) / cfg.tau) / (lifetimeFraction(ageMin, cfg.tau) / ageMin);
      const ratio = recent / (vpm * expected);
      parts.accelRatio = ratio;
      parts.acceleration = clamp(50 + 50 * Math.log2(ratio));
      parts.recentVpm = recent;
    }

    const weights = { size: 0.35, engagement: 0.2, relative: 0.25, acceleration: 0.2 };
    let sum = 0, wsum = 0;
    for (const k of Object.keys(weights)) {
      if (parts[k] != null) { sum += parts[k] * weights[k]; wsum += weights[k]; }
    }
    const confidence = clamp(views / 300, 0, 1) * (ageMin >= 5 ? 1 : 0.6);
    let total = (sum / wsum) * (0.5 + 0.5 * confidence);

    let label = total >= cfg.hotScore ? 'hot' : total >= cfg.risingScore ? 'rising' : 'normal';
    if (ageMin > cfg.maxAgeMin) label = 'old';
    const reply = replyValue(views, ageMin, tweet.replies, projected, parts.accelRatio, cfg);
    return { score: Math.round(total), label, parts, projected, vpm, er, confidence, reply };
  }

  const api = { DEFAULTS, score, replyValue, projectViews, lifetimeFraction, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XVR = api;
})(typeof self !== 'undefined' ? self : this);
