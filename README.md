# Trackside

A MERN app that finds railway stations around the user's location, shows upcoming timetables, and estimates train positions on a map. The React client uses browser geolocation; the Express API uses the Railway Engine API and OpenStreetMap Overpass. MongoDB persistence is optional.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `RAILWAY_API_KEY` and optionally `MONGODB_URI`.
4. Run `npm run dev` and open the Vite URL shown in the terminal.

The app starts near Bhullanpur. Select **Use my current location** to request browser location permission and search around your coordinates. Location access requires localhost or HTTPS. The map shows railway stations and OpenStreetMap railway ways within 15 km. When Overpass station lookup is unavailable in the Varanasi/Bhullanpur area, the server can use a small set of known nearby stations.

## Station board and train routes

The backend gets live station boards and train status from the Railway Engine API for up to 20 nearby coded stations. The selected 2-, 4-, or 8-hour window limits map markers to trains with a station arrival/departure or live ETA inside that window. Changing the window clears the previous markers until matching results arrive. Hovering over a station shows its board trains, scheduled/expected/actual arrival and departure times, and next stop when available. Trains sharing a known current-to-next-station segment are placed in arrival-time order along that segment, with the earliest arrival nearest the destination. Hovering over a train shows its number, name, route, next stop, and ETA; clicking it scrolls to and expands its sidebar details. A provider-reported station is shown as a last reported station, not as GPS. Timetable and geometry estimates are explicitly labeled and should not be treated as exact train tracking.

- `RAILWAY_API_KEY` is provided by the Railway Engine API and is used by the server only.
- For a separate frontend/backend deployment, set `VITE_API_BASE_URL` in the Vercel project to the public Render backend origin (for example, `https://your-service.onrender.com`, with no trailing slash). Vite embeds `VITE_` variables into the frontend at build time, so redeploy after changing it. Leave it empty for local development, where Vite proxies `/api` to `http://localhost:4000`.
- Station boards and train status are cached in memory for 30 seconds. Nearby station and railway geometry are fetched together from Overpass, cached for 15 minutes on success, and retried against alternate Overpass mirrors if an endpoint is unavailable. If every mirror fails, that failure is cached for one minute to avoid repeatedly hitting overloaded public services; known Varanasi-area station coordinates remain the fallback, but railway geometry may be unavailable until an Overpass mirror responds. Train status checks are limited per refresh to avoid unnecessary provider requests.
- The red **STOP** badge indicates the API reports a stop at the station; yellow **PASS** is shown only when the API confirms the train passes without a stop. Unknown stop information is labeled **UNKNOWN**.
- `.env` is ignored by Git. Keep API keys there and never commit them.

## API

`GET /api/trains/nearby?lat=25.2901&lng=82.9515&hours=2` returns the nearest station, nearby stations and timetables, nearby OSM railway ways, and reported or estimated train positions. The `hours` value must be 2, 4, or 8.