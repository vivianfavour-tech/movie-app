import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { featuredMovies, genreFilters, movies, type GenreFilter, type Movie } from "./data/movies";
import {
  getOmdbMovieDetails,
  searchOmdbMovies,
  type OmdbSearchItem,
} from "./api/omdb";

import "../styles.css";

const POSTER_BASE_URL = "https://image.tmdb.org/t/p/w500/";
const BACKDROP_BASE_URL = "https://image.tmdb.org/t/p/w1280/";

interface SearchResult {
  movie: Movie;
  isDirectMatch: boolean;
}

type OmdbSearchStatus = "idle" | "loading" | "ready" | "error" | "unconfigured";

interface OmdbSearchState {
  query: string;
  status: OmdbSearchStatus;
  results: Movie[];
  recommendations: Movie[];
  message: string;
}

const omdbApiKey = import.meta.env.VITE_OMDB_API_KEY?.trim() ?? "";

function normalise(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getMovieFields(movie: Movie): string {
  return normalise([
    movie.title,
    movie.description,
    ...movie.genres,
    ...movie.cast,
    ...movie.tags,
  ].join(" "));
}

function scoreQuery(movie: Movie, query: string): number {
  const cleanQuery = normalise(query);
  if (!cleanQuery) return 0;

  const cleanTitle = normalise(movie.title);
  const titleWords = cleanTitle.split(" ");
  const queryWords = cleanQuery.split(" ").filter((word) => word.length > 1);
  if (queryWords.length === 0) return 0;

  const fields = getMovieFields(movie);
  const fieldWords = new Set(fields.split(" "));
  const matchingWords = queryWords.filter((word) => fieldWords.has(word));

  if (cleanTitle === cleanQuery) return 100;
  if (cleanTitle.startsWith(cleanQuery)) return 85;
  if (cleanTitle.includes(cleanQuery)) return 72;
  if (matchingWords.length === 0) return 0;

  const titleMatches = queryWords.filter((word) => titleWords.includes(word)).length;
  const metadataMatches = queryWords.filter(
    (word) => fieldWords.has(word) && !titleWords.includes(word),
  ).length;

  return titleMatches * 23 + metadataMatches * 10;
}

function similarityScore(first: Movie, second: Movie): number {
  const sharedGenres = first.genres.filter((genre) => second.genres.includes(genre)).length;
  const sharedTags = first.tags.filter((tag) => second.tags.includes(tag)).length;
  const firstCast = first.cast.map(normalise);
  const sharedCast = second.cast.some((person) => firstCast.includes(normalise(person)));

  return sharedGenres * 4 + Math.min(sharedTags, 4) * 3 + (sharedCast ? 8 : 0);
}

function getRecommendations(seed: Movie, excludeTitles: ReadonlySet<string>): Movie[] {
  return movies
    .filter((movie) => !excludeTitles.has(normalise(movie.title)))
    .map((movie) => ({ movie, relatedness: similarityScore(seed, movie) }))
    .filter(({ relatedness }) => relatedness >= 4)
    .sort((first, second) => second.relatedness - first.relatedness
      || second.movie.popularity - first.movie.popularity)
    .map(({ movie }) => ({ ...movie, isFromOmdb: false }));
}

function parseYear(value: string): number | null {
  const match = value.match(/\b\d{4}\b/);
  return match ? Number(match[0]) : null;
}

function toOmdbMovie(item: OmdbSearchItem): Movie {
  return {
    title: item.Title,
    year: parseYear(item.Year),
    rating: null,
    genres: [],
    poster: "",
    posterUrl: item.Poster === "N/A" ? undefined : item.Poster,
    backdrop: "",
    description: "",
    cast: [],
    tags: [],
    popularity: 0,
    imdbId: item.imdbID,
    isFromOmdb: true,
    detailsLoaded: false,
  };
}

function applyOmdbDetails(movie: Movie, details: Awaited<ReturnType<typeof getOmdbMovieDetails>>): Movie {
  const rating = Number.parseFloat(details.imdbRating);

  return {
    ...movie,
    detailsLoaded: true,
    year: parseYear(details.Year),
    rating: Number.isFinite(rating) ? rating : null,
    genres: details.Genre === "N/A"
      ? []
      : details.Genre.split(",").map((genre) => genre.trim()).filter(Boolean),
    posterUrl: details.Poster === "N/A" ? undefined : details.Poster,
    description: details.Plot === "N/A" ? "" : details.Plot,
    cast: details.Actors === "N/A"
      ? []
      : details.Actors.split(",").map((person) => person.trim()).filter(Boolean),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error interrupted the OMDb search.";
}

function getRankedMovies(query: string): SearchResult[] {
  const directMatches = movies
    .map((movie) => ({ movie, relevance: scoreQuery(movie, query) }))
    .filter(({ relevance }) => relevance > 0)
    .sort((first, second) => second.relevance - first.relevance
      || second.movie.popularity - first.movie.popularity);

  if (directMatches.length === 0) return [];

  const exactMatch = directMatches.find(
    ({ movie }) => normalise(movie.title) === normalise(query),
  );
  const seedMovies = exactMatch
    ? [exactMatch.movie]
    : directMatches.slice(0, 3).map(({ movie }) => movie);
  const directTitles = new Set(directMatches.map(({ movie }) => movie.title));
  const recommendations = movies
    .filter((movie) => !directTitles.has(movie.title))
    .map((movie) => ({
      movie,
      relatedness: Math.max(...seedMovies.map((seed) => similarityScore(seed, movie))),
    }))
    .filter(({ relatedness }) => relatedness >= 4)
    .sort((first, second) => second.relatedness - first.relatedness
      || second.movie.popularity - first.movie.popularity);

  return [
    ...directMatches.map(({ movie }) => ({ movie, isDirectMatch: true })),
    ...recommendations.map(({ movie }) => ({ movie, isDirectMatch: false })),
  ];
}

function getGenresText(movie: Movie): string {
  if (movie.genres.length > 0) return movie.genres.slice(0, 2).join(" · ");
  return movie.detailsLoaded ? "Genre unavailable" : "Details loading…";
}

function readSavedMovies(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem("reelgood-watchlist") || "[]") as unknown;
    return Array.isArray(saved) && saved.every((title) => typeof title === "string")
      ? saved
      : [];
  } catch {
    return [];
  }
}

function Brand({ small = false }: { small?: boolean }) {
  return (
    <a
      className={`brand${small ? " brand--small" : ""}`}
      href="#discover"
      aria-label="Reelgood home"
    >
      <span className="brand__mark" aria-hidden="true">r</span>
      <span>reel<span className="brand__accent">good</span></span>
      <span className="brand__period">.</span>
    </a>
  );
}

function MovieCard({
  movie,
  isDirectMatch,
  isSaved,
  onToggleSaved,
  index,
}: {
  movie: Movie;
  isDirectMatch: boolean;
  isSaved: boolean;
  onToggleSaved: (movie: Movie) => void;
  index: number;
}) {
  const [posterFailed, setPosterFailed] = useState(false);
  const posterUrl = movie.posterUrl
    ?? (movie.isFromOmdb ? "" : `${POSTER_BASE_URL}${movie.poster}`);

  return (
    <article
      className="movie-card"
      data-genre={movie.genres[0]?.toLowerCase() ?? "unknown"}
      style={{ animationDelay: `${Math.min(index * 28, 220)}ms` }}
    >
      <div className="movie-card__poster">
        {!posterFailed && posterUrl && (
          <img
            className="movie-card__poster-image"
            src={posterUrl}
            alt={`${movie.title} poster`}
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
          />
        )}
        {(posterFailed || !posterUrl) && (
          <span className="movie-card__poster-fallback" aria-hidden="true">
            <span>{movie.title.split(" ").map((word) => word[0]).join("").slice(0, 3)}</span>
            <span>{movie.title}</span>
          </span>
        )}
        <span className="movie-card__poster-scrim" aria-hidden="true" />
        <span className="movie-card__match">
          {isDirectMatch ? movie.isFromOmdb ? "OMDB RESULT" : "TITLE MATCH" : "SIMILAR PICK"}
        </span>
        <button
          className={`movie-card__save${isSaved ? " movie-card__save--saved" : ""}`}
          type="button"
          aria-label={`${isSaved ? "Remove" : "Add"} ${movie.title} ${isSaved ? "from" : "to"} your watchlist`}
          aria-pressed={isSaved}
          title={`${isSaved ? "Remove from" : "Add to"} watchlist`}
          onClick={() => onToggleSaved(movie)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 4.75A1.75 1.75 0 0 1 7.75 3h8.5A1.75 1.75 0 0 1 18 4.75V21l-6-4-6 4z" />
          </svg>
        </button>
        {movie.rating === null ? (
          <span className="movie-card__poster-rating movie-card__poster-rating--unavailable">
            IMDb: N/A
          </span>
        ) : (
          <span className="movie-card__poster-rating" aria-label={`IMDb rating ${movie.rating} out of 10`}>
            ★ {movie.rating.toFixed(1)}
          </span>
        )}
      </div>
      <div className="movie-card__info">
        <span className="movie-card__title" title={movie.title}>{movie.title}</span>
        <div className="movie-card__meta">
          <span>{movie.year ?? "Year unavailable"}</span>
          <span aria-hidden="true">·</span>
          <span className="movie-card__genre">{getGenresText(movie)}</span>
        </div>
        <p className="movie-card__match-reason">
          {isDirectMatch
            ? movie.description || "The movie you searched for"
            : movie.genres.length > 0
              ? `Also ${getGenresText(movie).toLowerCase()}`
              : movie.isFromOmdb
                ? getGenresText(movie)
                : "Related movie recommendation"}
        </p>
      </div>
    </article>
  );
}

function App() {
  const [search, setSearch] = useState("");
  const [activeGenre, setActiveGenre] = useState<GenreFilter>("All movies");
  const [activeFeatureIndex, setActiveFeatureIndex] = useState(0);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const [savedMovies, setSavedMovies] = useState(readSavedMovies);
  const [notice, setNotice] = useState("");
  const [omdbSearch, setOmdbSearch] = useState<OmdbSearchState>({
    query: "",
    status: omdbApiKey ? "idle" : "unconfigured",
    results: [],
    recommendations: [],
    message: "",
  });
  const searchInput = useRef<HTMLInputElement>(null);
  const activeFeature = featuredMovies[activeFeatureIndex];
  const query = search.trim();

  useEffect(() => {
    const carouselTimer = window.setInterval(() => {
      setActiveFeatureIndex((index) => (index + 1) % featuredMovies.length);
    }, 7500);

    return () => window.clearInterval(carouselTimer);
  }, []);

  useEffect(() => {
    setBackdropFailed(false);
  }, [activeFeature.title]);

  useEffect(() => {
    if (!query) {
      setOmdbSearch({
        query: "",
        status: omdbApiKey ? "idle" : "unconfigured",
        results: [],
        recommendations: [],
        message: "",
      });
      return;
    }

    if (!omdbApiKey) {
      setOmdbSearch({
        query,
        status: "unconfigured",
        results: [],
        recommendations: [],
        message: "",
      });
      return;
    }

    const controller = new AbortController();

    setOmdbSearch({
      query,
      status: "loading",
      results: [],
      recommendations: [],
      message: "",
    });

    const searchTimer = window.setTimeout(() => {
      void (async () => {
        try {
          const searchItems = await searchOmdbMovies(query, omdbApiKey, controller.signal);
          if (controller.signal.aborted) return;

          const results = searchItems.map(toOmdbMovie);
          setOmdbSearch({
            query,
            status: "loading",
            results,
            recommendations: [],
            message: "",
          });

          if (results.length === 0) {
            setOmdbSearch({
              query,
              status: "ready",
              results: [],
              recommendations: [],
              message: "",
            });
            return;
          }

          const detailedResults = await Promise.allSettled(
            searchItems.slice(0, 5).map((item) =>
              getOmdbMovieDetails(item.imdbID, omdbApiKey, controller.signal)),
          );
          if (controller.signal.aborted) return;

          let detailErrors = 0;
          let firstDetailError = "";
          const enrichedResults = results.map((movie, index) => {
            if (index >= detailedResults.length) return { ...movie, detailsLoaded: true };

            const detail = detailedResults[index];
            if (detail.status === "fulfilled") {
              return applyOmdbDetails(movie, detail.value);
            }

            detailErrors += 1;
            if (!firstDetailError) firstDetailError = getErrorMessage(detail.reason);
            return { ...movie, detailsLoaded: true };
          });

          const seedMovie = enrichedResults.find((movie) => movie.genres.length > 0);
          const excludedTitles = new Set(enrichedResults.map((movie) => normalise(movie.title)));
          const recommendations = seedMovie
            ? getRecommendations(seedMovie, excludedTitles)
            : [];
          const message = detailErrors > 0
            ? `Full details could not be loaded for ${detailErrors} result${detailErrors === 1 ? "" : "s"}: ${firstDetailError}`
            : "";

          setOmdbSearch({
            query,
            status: "ready",
            results: enrichedResults,
            recommendations,
            message,
          });
        } catch (error) {
          if (controller.signal.aborted) return;

          setOmdbSearch({
            query,
            status: "error",
            results: [],
            recommendations: [],
            message: getErrorMessage(error),
          });
        }
      })();
    }, 400);

    return () => {
      window.clearTimeout(searchTimer);
      controller.abort();
    };
  }, [query]);

  const displayedMovies = useMemo(() => {
    if (query) {
      if (
        omdbApiKey
        && normalise(omdbSearch.query) === normalise(query)
        && omdbSearch.status !== "error"
      ) {
        return [
          ...omdbSearch.results.map((movie) => ({ movie, isDirectMatch: true })),
          ...omdbSearch.recommendations.map((movie) => ({ movie, isDirectMatch: false })),
        ];
      }
      return getRankedMovies(query);
    }

    return movies
      .slice()
      .sort((first, second) => second.popularity - first.popularity)
      .map((movie) => ({ movie, isDirectMatch: false }));
  }, [query, omdbSearch]);

  const genreFilteredMovies = activeGenre === "All movies"
    ? displayedMovies
    : displayedMovies.filter(({ movie }) => movie.genres.includes(activeGenre));
  const visibleMovies = genreFilteredMovies.slice(0, 12);
  const hasCurrentApiSearch = Boolean(
    query && normalise(omdbSearch.query) === normalise(query),
  );
  const isOmdbLoading = Boolean(
    omdbApiKey && hasCurrentApiSearch && omdbSearch.status === "loading",
  );
  const currentOmdbError = omdbApiKey
    && hasCurrentApiSearch
    && (omdbSearch.status === "error" || omdbSearch.message)
    ? omdbSearch.message
    : "";

  function clearSearch() {
    setSearch("");
    setActiveGenre("All movies");
  }

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    document.querySelector("#movies")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function toggleSaved(movie: Movie) {
    const nextSavedMovies = savedMovies.includes(movie.title)
      ? savedMovies.filter((title) => title !== movie.title)
      : [...savedMovies, movie.title];

    setSavedMovies(nextSavedMovies);

    try {
      localStorage.setItem("reelgood-watchlist", JSON.stringify(nextSavedMovies));
      setNotice("");
    } catch {
      setNotice("Your browser couldn't save your watchlist. Check your storage settings and try again.");
    }
  }

  function showSimilarMovies() {
    setSearch(activeFeature.title);
    setActiveGenre("All movies");
    document.querySelector("#movies")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const resultsTitle = query
    ? `Movies related to “${query}”`
    : activeGenre === "All movies" ? "Trending this week" : `${activeGenre} favorites`;
  const resultsEyebrow = query && hasCurrentApiSearch && omdbSearch.status === "ready"
    ? "OMDb RESULTS & RELATED PICKS"
    : query
    ? activeGenre === "All movies" ? "MATCHES & RECOMMENDATIONS" : `MATCHES & ${activeGenre.toUpperCase()} PICKS`
    : activeGenre === "All movies" ? "HAND-PICKED FOR YOU" : `PICKS FOR ${activeGenre.toUpperCase()} FANS`;

  let emptyTitle = "No movies in this genre yet";
  let emptyDescription = "Try another genre, or explore all of this week's movies.";
  if (isOmdbLoading && displayedMovies.length === 0) {
    emptyTitle = "Searching OMDb…";
    emptyDescription = "Looking up movies and gathering recommendations.";
  } else if (query && hasCurrentApiSearch && omdbSearch.status === "ready" && omdbSearch.results.length === 0) {
    emptyTitle = `No movies found for “${query}”`;
    emptyDescription = "Try a different title or check the spelling.";
  } else if (query && displayedMovies.length === 0) {
    emptyTitle = "No matching movies found";
    emptyDescription = "Try a different title, or clear your search to see what's trending.";
  } else if (query && genreFilteredMovies.length === 0) {
    emptyTitle = `No ${activeGenre.toLowerCase()} matches for “${query}”`;
    emptyDescription = "Try another genre, or choose All movies to see every recommendation.";
  }

  return (
    <>
      <div className="ambient ambient--one" aria-hidden="true" />
      <div className="ambient ambient--two" aria-hidden="true" />

      <header className="topbar">
        <Brand />
        <nav className="topbar__nav" aria-label="Main navigation">
          <a className="topbar__link topbar__link--active" href="#discover">Discover</a>
          <a className="topbar__link" href="#movies">Movies</a>
        </nav>
        <a className="topbar__note" href="#movies">
          <span className="status-dot" aria-hidden="true" />
          Your next movie night starts here
        </a>
      </header>

      <main id="discover">
        <section className="hero" aria-labelledby="hero-title">
          <div
            className="hero__art"
            data-genre={activeFeature.genres[0].toLowerCase()}
            aria-hidden="true"
          >
            <img
              className={`hero__backdrop${backdropFailed ? " hero__backdrop--failed" : ""}`}
              src={`${BACKDROP_BASE_URL}${activeFeature.backdrop}`}
              alt=""
              onError={() => setBackdropFailed(true)}
            />
            <span className="hero__art-title">{activeFeature.title}</span>
          </div>
          <div className="hero__scrim" aria-hidden="true" />
          <div className="hero__content">
            <span className="eyebrow"><span className="eyebrow__line" /> YOUR FRONT-ROW SEAT</span>
            <p className="hero__kicker">
              {activeFeatureIndex === 0 ? "TONIGHT'S PICK" : "FEATURED PICK"}
            </p>
            <h1 id="hero-title">{activeFeature.title}</h1>
            <p className="hero__description">{activeFeature.description}</p>
            <div className="hero__details">
              <span className="hero__year">{activeFeature.year ?? "Year unavailable"}</span>
              <span className="detail-dot" aria-hidden="true" />
              <span>{getGenresText(activeFeature)}</span>
              <span className="detail-dot" aria-hidden="true" />
              <span className="hero__rating">
                ★ <span>{activeFeature.rating?.toFixed(1) ?? "N/A"}</span>
              </span>
            </div>
            <button className="button button--primary" type="button" onClick={showSimilarMovies}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
              Find similar movies
            </button>
          </div>
          <div className="hero__footer">
            <span className="hero__count">
              {String(activeFeatureIndex + 1).padStart(2, "0")} / {String(featuredMovies.length).padStart(2, "0")}
            </span>
            <div className="hero__dots" aria-label="Featured movies">
              {featuredMovies.map((movie, index) => (
                <button
                  className={`hero__dot${index === activeFeatureIndex ? " hero__dot--active" : ""}`}
                  type="button"
                  key={movie.title}
                  aria-label={`Show ${movie.title}`}
                  aria-pressed={index === activeFeatureIndex}
                  onClick={() => setActiveFeatureIndex(index)}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="discovery" id="movies" aria-labelledby="discovery-title">
          <div className="discovery__intro">
            <div>
              <p className="section-kicker"><span className="section-kicker__star">✳</span> A BETTER KIND OF BINGE</p>
              <h2 id="discovery-title">Find your next <span>favorite.</span></h2>
              <p className="discovery__subtitle">One good movie leads to another. Start with a title you love.</p>
            </div>
            <span className="discovery__aside">GOOD MOVIES. NO ENDLESS SCROLLING.</span>
          </div>

          <form className="search" role="search" onSubmit={handleSearchSubmit}>
            <svg className="search__icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.8" cy="10.8" r="6.8" />
              <path d="m16 16 4.5 4.5" />
            </svg>
            <label className="visually-hidden" htmlFor="movie-search">Search movies</label>
            <input
              ref={searchInput}
              id="movie-search"
              name="movie"
              type="search"
              placeholder="Type a movie you love — try Interstellar or The Batman"
              autoComplete="off"
              spellCheck={false}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && search) clearSearch();
              }}
            />
            {query ? (
              <button
                className="search__clear"
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  clearSearch();
                  searchInput.current?.focus();
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>
              </button>
            ) : (
              <kbd className="search__shortcut" aria-hidden="true">↵</kbd>
            )}
          </form>

          {!omdbApiKey ? (
            <aside className="api-notice" role="status">
              <span className="api-notice__icon" aria-hidden="true">i</span>
              <span>
                <strong>Live OMDb search is not configured.</strong>{" "}
                Add your API key to <code>.env.local</code> to search the full movie catalog.
                {" "}
                <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noreferrer">
                  Get a free OMDb key
                </a>
                . The sample movie collection still works.
              </span>
            </aside>
          ) : currentOmdbError ? (
            <aside className="api-notice api-notice--error" role="alert">
              <span className="api-notice__icon" aria-hidden="true">!</span>
              <span>
                <strong>OMDb:</strong> {currentOmdbError}
                {omdbSearch.status === "error" ? " Showing any matching movies from the sample collection." : ""}
              </span>
            </aside>
          ) : isOmdbLoading ? (
            <p className="api-search-status" role="status">
              <span className="loading-spinner" aria-hidden="true" />
              Searching OMDb for movies related to “{query}”…
            </p>
          ) : null}

          <div className="filters" aria-label="Filter by genre">
            {genreFilters.map((genre) => (
              <button
                className={`filter-chip${genre === activeGenre ? " filter-chip--active" : ""}`}
                type="button"
                key={genre}
                aria-pressed={genre === activeGenre}
                onClick={() => setActiveGenre(genre)}
              >
                {genre}
              </button>
            ))}
          </div>

          <div className="results-heading">
            <div>
              <span className="results-heading__eyebrow">{resultsEyebrow}</span>
              <h3 id="results-title">{resultsTitle}</h3>
            </div>
            <span className="results-heading__count" aria-live="polite">
              {visibleMovies.length} {visibleMovies.length === 1 ? "movie" : "movies"}
            </span>
          </div>

          {visibleMovies.length > 0 ? (
            <div className="movie-grid" aria-live="polite">
              {visibleMovies.map(({ movie, isDirectMatch }, index) => (
                <MovieCard
                  movie={movie}
                  isDirectMatch={isDirectMatch}
                  isSaved={savedMovies.includes(movie.title)}
                  onToggleSaved={toggleSaved}
                  index={index}
                  key={movie.title}
                />
              ))}
            </div>
          ) : isOmdbLoading ? (
            <div className="search-loading" role="status">
              <span className="loading-spinner" aria-hidden="true" />
              <span>Searching the OMDb movie catalog…</span>
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">⌕</span>
              <h3>{emptyTitle}</h3>
              <p>{emptyDescription}</p>
              <button className="button button--secondary" type="button" onClick={clearSearch}>
                Show trending movies
              </button>
            </div>
          )}

          {notice && <p className="visually-hidden" role="status">{notice}</p>}

          <footer className="footer">
            <Brand small />
            <span>Made for the love of a really good movie.</span>
            <span className="footer__year">YOUR NEXT FAVORITE IS OUT THERE <span aria-hidden="true">✳</span></span>
          </footer>
        </section>
      </main>
    </>
  );
}

export default App;
