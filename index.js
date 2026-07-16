/**
 * DesiCinema.org Stremio/Nuvio Addon
 *
 * Serves:
 *   /manifest.json
 *   /catalog/movie/desicinema_top.json
 *   /catalog/movie/desicinema_top/skip={N}.json
 *   /catalog/movie/desicinema_search={query}.json
 *   /meta/movie/{id}.json
 *   /stream/movie/{id}.json
 */
import express from "express";
import pkg from "stremio-addon-sdk";
const { addonBuilder, getRouter } = pkg;
import {
  fetchMovieListings,
  fetchMovieDetail,
  fetchVideoSource,
  searchMovies,
} from "./scraper.js";

const PORT = process.env.PORT || 7000;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour for successful data
const CACHE_TTL_FAIL = 5 * 60 * 1000; // 5 min for failures

// In-memory cache
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.time < entry.ttl) return entry.data;
  cache.delete(key);
  return null;
}

function setCache(key, data, ttl = CACHE_TTL) {
  cache.set(key, { data, time: Date.now(), ttl });
}

// ── Build the Stremio addon ──────────────────────────────────────────
const builder = new addonBuilder({
  id: "org.desicinema.addon",
  version: "1.0.0",
  name: "DesiCinema",
  description:
    "Watch Bollywood, Hollywood (Hindi Dubbed), and South Indian movies from DesiCinema.org",
  logo: "https://www.desicinema.org/wp-content/uploads/2025/02/desicinemas-pk-logo.png",
  resources: ["catalog", "meta", "stream"],
  types: ["movie"],
  idPrefixes: ["dc_"],
  catalogs: [
    {
      type: "movie",
      id: "desicinema_top",
      name: "DesiCinema - Latest Movies",
      extra: [
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false },
        { name: "genre", isRequired: false },
      ],
    },
  ],
});

// ── Catalog Handler ──────────────────────────────────────────────────
builder.defineCatalogHandler(async (args) => {
  console.log("[Catalog]", args.id, args.extra);

  const skip = parseInt(args.extra?.skip || "0", 10);
  const searchQuery = args.extra?.search || "";

  // Handle search
  if (searchQuery) {
    const cacheKey = `search:${searchQuery}`;
    let results = getCached(cacheKey);
    if (!results) {
      results = await searchMovies(searchQuery);
      setCache(cacheKey, results);
    }

    return {
      metas: results.map((m) => ({
        id: `dc_${m.id}`,
        type: "movie",
        name: m.title,
        poster: m.poster || undefined,
        year: m.year ? parseInt(m.year, 10) || undefined : undefined,
      })),
    };
  }

  // Paginated catalog
  const page = Math.floor(skip / 20) + 1;
  const cacheKey = `catalog:${page}`;
  let movies = getCached(cacheKey);
  if (!movies) {
    movies = await fetchMovieListings(page);
    setCache(cacheKey, movies);
  }

  const skipWithin = skip % 20;
  const pageMovies = movies.slice(skipWithin, skipWithin + 20);

  return {
    metas: pageMovies.map((m) => ({
      id: `dc_${m.id}`,
      type: "movie",
      name: m.title,
      poster: m.poster || undefined,
      year: m.year ? parseInt(m.year, 10) || undefined : undefined,
      description: m.quality ? `${m.quality}` : undefined,
    })),
  };
});

// ── Meta Handler ─────────────────────────────────────────────────────
builder.defineMetaHandler(async (args) => {
  const slug = args.id.replace(/^dc_/, "");
  console.log("[Meta]", slug);

  const cacheKey = `meta:${slug}`;
  let detail = getCached(cacheKey);
  if (!detail) {
    detail = await fetchMovieDetail(slug);
    setCache(cacheKey, detail);
  }

  return {
    meta: {
      id: `dc_${detail.id}`,
      type: "movie",
      name: detail.title,
      poster: detail.poster || undefined,
      description: detail.description || undefined,
      year: detail.year ? parseInt(detail.year, 10) || undefined : undefined,
      genres: detail.genres.length > 0 ? detail.genres : undefined,
      director: detail.director ? [detail.director] : undefined,
      cast: detail.cast.length > 0 ? detail.cast : undefined,
    },
  };
});

// ── Stream Handler ───────────────────────────────────────────────────
builder.defineStreamHandler(async (args) => {
  const slug = args.id.replace(/^dc_/, "");
  console.log("[Stream]", slug);

  try {
    // Check cache first for the resolved video URL
    const streamCacheKey = `stream:${slug}`;
    let videoUrl = getCached(streamCacheKey);
    let detail;

    if (!videoUrl) {
      // Check if we have cached meta (avoids double scrape)
      const metaCacheKey = `meta:${slug}`;
      detail = getCached(metaCacheKey);

      if (!detail) {
        detail = await fetchMovieDetail(slug);
        setCache(metaCacheKey, detail);
      }

      if (detail.embedUrl) {
        const source = await fetchVideoSource(detail.embedUrl);
        if (source && source.url) {
          videoUrl = source.url;
          setCache(streamCacheKey, videoUrl);
        } else {
          // Cache the failure too (shorter TTL to allow retries)
          setCache(streamCacheKey, null, CACHE_TTL_FAIL);
        }
      }
    }

    const streams = [];

    if (videoUrl) {
      streams.push({
        title: "DesiCinema",
        url: videoUrl,
      });
    }

    // Get detail for trailer (from cache or fresh)
    if (!detail) {
      detail = getCached(`meta:${slug}`) || (await fetchMovieDetail(slug));
    }

    if (detail?.trailerUrl) {
      const ytId = extractYouTubeId(detail.trailerUrl);
      streams.push({
        title: "Trailer (YouTube)",
        ytId: ytId || undefined,
        url: ytId ? undefined : detail.trailerUrl,
      });
    }

    // External link fallback — use resolved URL from detail if available
    streams.push({
      title: "Watch on DesiCinema.org",
      externalUrl: detail?.finalUrl || `https://www.desicinema.org/${slug}/`,
    });

    return { streams };
  } catch (err) {
    console.error(`[Stream] Error for ${slug}:`, err.message);
    // Return just the external link as fallback
    return {
      streams: [
        {
          title: "Watch on DesiCinema.org",
          externalUrl: `https://www.desicinema.org/${slug}/`,
        },
      ],
    };
  }
});

// ── Helper ──────────────────────────────────────────────────────────
function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

// ── Create Express app + serve ───────────────────────────────────────
const app = express();
const addonInterface = builder.getInterface();

// Serve the addon via Express (getRouter returns Express-compatible middleware)
app.use(getRouter(addonInterface));

// Landing page
app.get("/", (req, res) => {
  const proto = req.protocol;
  const host = req.get("host");
  const manifestUrl = `${proto}://${host}/manifest.json`;
  res.send(`
    <html>
    <head><title>DesiCinema Stremio Addon</title>
    <style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#1a1a2e;color:#eee;margin:0} .box{text-align:center;padding:2rem} h1{color:#e94560} a{color:#0f3460;background:#e94560;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600}</style>
    </head>
    <body>
    <div class="box">
      <h1>DesiCinema Stremio Addon</h1>
      <p>Bollywood • Hollywood (Hindi Dubbed) • South Indian Movies</p>
      <p><a href="/manifest.json">Install Addon</a></p>
      <p><small>Or copy this URL into Stremio/Nuvio:</small><br>
      <code>${manifestUrl}</code></p>
    </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(` DesiCinema Stremio Addon running at http://localhost:${PORT}`);
  console.log(`   Manifest: http://localhost:${PORT}/manifest.json`);
});
