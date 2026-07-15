import { fetchMovieListings, fetchMovieDetail } from "./scraper.js";

console.log("=== Testing fetchMovieListings ===");
try {
  const movies = await fetchMovieListings(1);
  console.log("Movies found:", movies.length);
  console.log("First:", JSON.stringify(movies[0], null, 2));
  if (movies.length > 1) {
    console.log("Second title:", movies[1]?.title, "| quality:", movies[1]?.quality, "| year:", movies[1]?.year);
  }

  // Test meta
  console.log("\n=== Testing fetchMovieDetail ===");
  const detail = await fetchMovieDetail(movies[0].id);
  console.log("Detail:", JSON.stringify({
    title: detail.title,
    year: detail.year,
    embedUrl: detail.embedUrl?.substring(0, 80),
    genres: detail.genres,
    cast: detail.cast?.slice(0, 3),
    finalUrl: detail.finalUrl
  }, null, 2));
} catch (e) {
  console.error("Error:", e.message);
}
