export interface OmdbSearchItem {
  Title: string;
  Year: string;
  imdbID: string;
  Type: string;
  Poster: string;
}

export interface OmdbMovieDetails extends OmdbSearchItem {
  Genre: string;
  Plot: string;
  Actors: string;
  imdbRating: string;
}

interface OmdbSuccess<T> {
  Response: "True";
  Search?: T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSearchItem(value: unknown): value is OmdbSearchItem {
  return isRecord(value)
    && typeof value.Title === "string"
    && typeof value.Year === "string"
    && typeof value.imdbID === "string"
    && typeof value.Type === "string"
    && typeof value.Poster === "string";
}

function isMovieDetails(value: unknown): value is OmdbMovieDetails {
  return isSearchItem(value)
    && isRecord(value)
    && typeof value.Genre === "string"
    && typeof value.Plot === "string"
    && typeof value.Actors === "string"
    && typeof value.imdbRating === "string";
}

async function request<T>(
  params: URLSearchParams,
  signal: AbortSignal,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  const response = await fetch(`https://www.omdbapi.com/?${params.toString()}`, { signal });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`OMDb returned an unreadable response (HTTP ${response.status}).`, {
      cause: error,
    });
  }

  if (!isRecord(payload)) {
    throw new Error("OMDb returned an unexpected response. Please try again.");
  }

  if (payload.Response === "False") {
    const message = typeof payload.Error === "string" ? payload.Error : "OMDb request failed.";
    if (message === "Movie not found!" || message === "Series not found!") return null;
    throw new Error(message);
  }

  if (!response.ok) {
    throw new Error(`OMDb returned HTTP ${response.status}. Please try again.`);
  }

  if (payload.Response !== "True" || !validate(payload)) {
    throw new Error("OMDb returned incomplete movie data. Please try again.");
  }

  return payload;
}

function createParams(apiKey: string): URLSearchParams {
  return new URLSearchParams({ apikey: apiKey });
}

export async function searchOmdbMovies(
  query: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<OmdbSearchItem[]> {
  const params = createParams(apiKey);
  params.set("s", query);
  params.set("type", "movie");

  const result = await request(
    params,
    signal,
    (value): value is OmdbSuccess<OmdbSearchItem> =>
      isRecord(value)
      && value.Response === "True"
      && Array.isArray(value.Search)
      && value.Search.every(isSearchItem),
  );

  if (!result) return [];
  return result.Search ?? [];
}

export async function getOmdbMovieDetails(
  imdbId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<OmdbMovieDetails> {
  const params = createParams(apiKey);
  params.set("i", imdbId);
  params.set("plot", "short");

  const result = await request(
    params,
    signal,
    (value): value is OmdbMovieDetails =>
      isMovieDetails(value),
  );

  if (!result) {
    throw new Error("OMDb couldn't find details for this movie.");
  }

  return result;
}
