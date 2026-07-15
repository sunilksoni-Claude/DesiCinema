/**
 * DesiCinema.org scraper for Stremio addon.
 * Scrapes movie listings, metadata, and video sources.
 */
import * as cheerio from "cheerio";
import fetch from "node-fetch";

const BASE_URL = "https://www.desicinema.org";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const headers = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

/**
 * Fetch HTML from a URL with error handling.
 */
async function fetchHTML(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Scrape movie listings from /all-movies/page/N/
 * Returns array of { id, title, poster, year, quality, href }
 */
export async function fetchMovieListings(page = 1) {
  const url =
    page === 1
      ? `${BASE_URL}/all-movies/`
      : `${BASE_URL}/all-movies/page/${page}/`;

  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const movies = [];

  $("article.TPost.B").each((_, el) => {
    const $el = $(el);

    // The outer <a> wraps both the image and h2.Title
    const href = $el.find("a[href]").first().attr("href") || "";
    const title = $el.find("h2.Title").text().trim();

    // Poster - lazy-loaded via data-src
    const poster =
      $el.find("img").attr("data-src") ||
      $el.find("img").attr("src") ||
      "";

    // Year from .Qlty.Yr span (year is marked with Yr class)
    const year = $el.find("span.Yr, span.Qlty.Yr").text().trim() || "";

    // Quality from first .Qlty without .Yr class
    const quality = $el.find("span.Qlty:not(.Yr)").first().text().trim() || "";

    // Extract slug/id from href
    const slug = extractSlug(href);
    if (!slug || !title) return;

    movies.push({
      id: slug,
      title,
      poster: poster.startsWith("//") ? `https:${poster}` : poster,
      year,
      quality,
      href: href.startsWith("http") ? href : `${BASE_URL}${href}`,
    });
  });

  return movies;
}



/**
 * Scrape movie detail page for metadata and video embed URL.
 * Returns { id, title, poster, description, year, genres, cast, director, embedUrl }
 * Tries multiple URL patterns since desicinema uses both root and /movies/ paths.
 */
export async function fetchMovieDetail(slug) {
  // Try both URL patterns — WordPress sites may use either
  const urls = [
    `${BASE_URL}/${slug}/`,
    `${BASE_URL}/movies/${slug}/`,
  ];

  let html;
  let finalUrl;
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers, redirect: "follow" });
      if (res.ok) {
        html = await res.text();
        finalUrl = res.url;
        break;
      }
    } catch (_) {
      // try next URL
    }
  }

  if (!html) throw new Error(`Could not fetch movie detail for slug: ${slug}`);

  const $ = cheerio.load(html);

  // Title
  const title =
    $("h1.Title").text().trim() ||
    $("h2.Title").first().text().trim() ||
    $(".TPost .Title").first().text().trim();

  // Poster
  let poster =
    $(".Image img").attr("data-src") ||
    $(".Image img").attr("src") ||
    $("img.attachment-post-thumbnail").attr("data-src") ||
    $("img.attachment-post-thumbnail").attr("src") ||
    "";

  if (poster.startsWith("//")) poster = `https:${poster}`;

  // Description - get <p> that is NOT Director, Genre, or Cast
  const description = $(".Description > p")
    .filter((_, el) => {
      const cls = $(el).attr("class") || "";
      return !cls.match(/Director|Genre|Cast/i);
    })
    .first()
    .text()
    .trim();

  // Year from .Date span or meta
  const year =
    $("span.Date").text().trim() ||
    $(".Info span.Date").text().trim() ||
    "";

  // Genres from .Genre links/span
  const genres = [];
  $(".Description a[rel='tag'], p.Genre a, .Genre a").each((_, el) => {
    const g = $(el).text().trim();
    if (g) genres.push(g);
  });

  // Cast from .Cast span/links
  const cast = [];
  $("p.Cast a, .Cast a").each((_, el) => {
    const c = $(el).text().trim();
    if (c) cast.push(c);
  });

  // Director
  const director =
    $("p.Director a, .Director a").first().text().trim() ||
    $("p.Director").text().replace("Director:", "").trim() ||
    "";

  // Video embed URL - lazy-loaded iframe (use data-litespeed-src)
  let embedUrl =
    $("iframe[data-litespeed-src]").attr("data-litespeed-src") || "";

  // Also check for the toroFlix trailer as fallback
  let trailerUrl = "";
  const toroFlixMatch = html.match(/"trailer":"([^"]+)"/);
  if (toroFlixMatch) {
    const trailerHtml = toroFlixMatch[1]
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/");
    const trailerMatch = trailerHtml.match(/src="([^"]+)"/);
    if (trailerMatch) trailerUrl = trailerMatch[1];
  }

  // Extract trid from embed URL for later use
  let postId = "";
  const tridMatch = embedUrl.match(/[?&]trid=(\d+)/);
  if (tridMatch) postId = tridMatch[1];

  // Also get the embed servers info from data attributes
  const servers = [];
  $("[data-key]").each((_, el) => {
    const key = $(el).attr("data-key");
    const serverId = $(el).attr("data-id");
    const serverType = $(el).attr("data-typ");
    const label = $(el).text().trim();
    if (key !== undefined && serverId) {
      servers.push({
        key,
        id: serverId,
        type: serverType,
        label: label || `Server ${key}`,
      });
    }
  });

  // If no embedUrl found from iframe but we have server data
  if (!embedUrl && servers.length > 0) {
    const firstServer = servers[0];
    embedUrl = `${BASE_URL}/?trembed=${firstServer.key}&trid=${firstServer.id}&trtype=1`;
    postId = firstServer.id;
  }

  return {
    id: slug,
    title: title || slug.replace(/-/g, " "),
    poster,
    description,
    year,
    genres: [...new Set(genres)],
    cast: [...new Set(cast)],
    director,
    embedUrl,
    trailerUrl,
    postId,
    servers,
    finalUrl,
  };
}

/**
 * Resolve the embed URL to get the actual video iframe source.
 * This is a 2-step process:
 * 1. The embed URL returns an iframe pointing to the video host
 * 2. We extract that iframe src
 */
export async function fetchVideoSource(embedUrl) {
  if (!embedUrl) return null;

  try {
    const html = await fetchHTML(embedUrl);
    const $ = cheerio.load(html);

    // Find the inner iframe
    const iframeSrc = $(".Video iframe").attr("src") || $("iframe").first().attr("src") || "";

    if (iframeSrc) {
      return {
        url: iframeSrc,
        title: "DesiCinema",
      };
    }

    return null;
  } catch (e) {
    console.error(`Error fetching video source: ${e.message}`);
    return null;
  }
}

/**
 * Search movies on desicinema.org
 */
export async function searchMovies(query) {
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
  const html = await fetchHTML(url);
  const $ = cheerio.load(html);
  const movies = [];

  $("article.TPost.B").each((_, el) => {
    const $el = $(el);
    const href = $el.find("a[href]").first().attr("href") || "";
    const title = $el.find("h2.Title").text().trim();
    const poster =
      $el.find("img").attr("data-src") ||
      $el.find("img").attr("src") ||
      "";
    const year = $el.find("span.Date").text().trim() || "";
    const slug = extractSlug(href);

    if (slug && title) {
      movies.push({
        id: slug,
        title,
        poster: poster.startsWith("//") ? `https:${poster}` : poster,
        year,
        href: href.startsWith("http") ? href : `${BASE_URL}${href}`,
      });
    }
  });

  return movies;
}

/**
 * Extract slug from a desicinema.org URL.
 * E.g., "/virginia-woolfs-night-day/" -> "virginia-woolfs-night-day"
 */
function extractSlug(url) {
  if (!url) return "";
  // Remove query params and trailing slashes, extract last path segment
  const clean = url.split("?")[0].replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}
