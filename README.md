# Reelgood

A responsive React and TypeScript movie discovery app powered by the OMDb API.

## Run locally

1. Install dependencies: `npm install`
2. Get a free OMDb API key at <https://www.omdbapi.com/apikey.aspx>.
3. Copy `.env.example` to `.env.local` and replace `your_omdb_api_key` with your key.
4. Start the app: `npm run dev`.

Restart the development server after changing `.env.local`. Without an API key, the
app still works with its sample movie collection and explains how to enable OMDb search.

## API key security

This app calls OMDb from the browser. Vite embeds `VITE_` environment variables in
the client bundle, so the API key is visible to visitors and must never be treated as
a private server-side secret. Keep `.env.local` out of version control. For a public
production deployment, move OMDb requests behind a server-side proxy and store the
key in that server's environment instead.
