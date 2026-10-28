import { Router } from 'express';

const router = Router();
const overpassUrl = 'https://overpass-api.de/api/interpreter';
const railwayApiBaseUrl = 'https://railway-engine.apkscope.workers.dev/v1';
const providerCache = new Map();
const railwayCache = new Map();
const stationNetworkRadiusKm = 15;
const maxTimetableStations = 20;
const maxStatusLookupsPerRequest = 3;
const knownStations = [
  { name: 'Bhullanpur', code: 'BHLP', lat: 25.2874, lng: 82.9571 },
  { name: 'Banaras', code: 'BNRS', lat: 25.29975, lng: 82.971856 },
  { name: 'Hardattpur', code: 'HDT', lat: 25.2707, lng: 82.8813 },
  { name: 'Varanasi Junction', code: 'BSB', lat: 25.326901, lng: 82.986088 },
  { name: 'Varanasi City', code: 'BCY', lat: 25.334228, lng: 83.014224 },
  { name: 'Kashi', code: 'KEI', lat: 25.3268, lng: 83.0321 },
  { name: 'Raja Talab', code: 'RTB', lat: 25.2559, lng: 82.8158 },
  { name: 'Vyasnagar', code: 'VYN', lat: 25.2973, lng: 83.0716 },
  { name: 'Sarnath', code: 'SRNT', lat: 25.376058, lng: 83.032694 },
  { name: 'Block Hut B (BHB)', code: 'BHBV', lat: 25.274969, lng: 83.102303 },
];
function distanceKm(fromLat, fromLng, toLat, toLng) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latDelta = radians(toLat - fromLat);
  const lngDelta = radians(toLng - fromLng);
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(radians(fromLat)) * Math.cos(radians(toLat)) * Math.sin(lngDelta / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function railwayApiKey() {
  const apiKey = process.env.RAILWAY_API_KEY;
  if (!apiKey) {
    const error = new Error('Set RAILWAY_API_KEY in .env to load live train data.');
    error.statusCode = 503;
    throw error;
  }
  return apiKey;
}

async function fetchRailwayData(path, cacheMs = 0) {
  const cacheKey = path;
  const cached = providerCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const response = await fetch(`${railwayApiBaseUrl}${path}`, {
      headers: { 'x-api-key': railwayApiKey(), Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status !== 'SUCCESS') {
      const code = payload?.error?.code;
      const message = payload?.error?.message || `Train data API request failed (${response.status}).`;
      const error = new Error(response.status === 429 || code?.includes('RATE_LIMIT')
        ? 'Train data API rate limit reached. Wait before refreshing.'
        : message);
      error.statusCode = response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status;
      throw error;
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw new Error('Train data API returned an unsupported response.');
    }
    return payload.data;
  })();

  if (cacheMs > 0) providerCache.set(cacheKey, { promise, expiresAt: Date.now() + cacheMs });
  try {
    return await promise;
  } catch (error) {
    providerCache.delete(cacheKey);
    throw error;
  }
}

function stationCodeFrom(tags = {}) {
  const code = tags['ref:IN'] || tags['railway:ref'] || tags.ref || tags.uic_ref;
  return typeof code === 'string' && /^[a-z\d]{2,5}$/i.test(code.trim())
    ? code.trim().toUpperCase()
    : '';
}

async function findNearbyStations(lat, lng, radiusKm) {
  const radiusMeters = Math.round(radiusKm * 1000);
  const query = `[out:json][timeout:15];nwr["railway"~"^(station|halt)$"](around:${radiusMeters},${lat},${lng});out center tags;`;
  const fallbackStations = knownStations
    .map((station) => ({ ...station, distanceKm: distanceKm(lat, lng, station.lat, station.lng), fallback: true }))
    .filter((station) => station.distanceKm <= radiusKm);
  let elements = [];
  let overpassError;
  try {
    const response = await fetch(overpassUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Trackside/1.0',
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`OpenStreetMap station lookup failed (${response.status}).`);
    const payload = await response.json();
    if (!Array.isArray(payload.elements)) throw new Error('OpenStreetMap returned an invalid station list.');
    elements = payload.elements;
  } catch (error) {
    overpassError = error;
  }

  const stations = elements
    .map((element) => {
      const stationLat = Number(element.lat ?? element.center?.lat);
      const stationLng = Number(element.lon ?? element.center?.lon);
      if (!Number.isFinite(stationLat) || !Number.isFinite(stationLng)) return null;
      return {
        name: element.tags?.name || element.tags?.['name:en'] || 'Railway station',
        code: stationCodeFrom(element.tags),
        lat: stationLat,
        lng: stationLng,
        distanceKm: distanceKm(lat, lng, stationLat, stationLng),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  stations.push(...fallbackStations);
  const uniqueStations = [...new Map(stations.map((station) => [
    station.code || `${normalizeName(station.name)}:${station.lat.toFixed(4)}:${station.lng.toFixed(4)}`,
    station,
  ])).values()].sort((a, b) => a.distanceKm - b.distanceKm);

  if (!uniqueStations.length) {
    if (overpassError) {
      const message = overpassError.name === 'TimeoutError' || overpassError.name === 'AbortError'
        ? 'OpenStreetMap station lookup timed out. Check your connection and retry.'
        : overpassError instanceof TypeError
          ? 'Could not connect to OpenStreetMap. Check your internet connection or network restrictions.'
          : overpassError.message;
      const lookupError = new Error(message);
      lookupError.statusCode = 503;
      throw lookupError;
    }
    throw new Error(`No railway station was found within ${radiusKm} km.`);
  }

  const candidates = uniqueStations.slice(0, maxTimetableStations);
  const resolved = await mapInBatches(candidates, 4, async (candidate) => {
    if (candidate.code) return candidate;
    try {
      const code = await resolveStationCode(candidate.name);
      return code ? { ...candidate, code } : null;
    } catch (error) {
      console.warn(`Could not resolve a station code for ${candidate.name}: ${error.message}`);
      return null;
    }
  });
  const resolvedByKey = new Map(resolved.filter(Boolean).map((station) => [
    station.code || `${normalizeName(station.name)}:${station.lat.toFixed(4)}:${station.lng.toFixed(4)}`,
    station,
  ]));
  const mapStations = uniqueStations.map((candidate) => {
    const key = candidate.code || `${normalizeName(candidate.name)}:${candidate.lat.toFixed(4)}:${candidate.lng.toFixed(4)}`;
    return resolvedByKey.get(key) || candidate;
  });
  const supportedStations = mapStations.filter((station) => station.code);
  if (!supportedStations.length) {
    const error = new Error(`Could not resolve a station code for stations within ${radiusKm} km.`);
    error.statusCode = 503;
    throw error;
  }
  if (overpassError && fallbackStations.length) {
    console.warn(`OpenStreetMap lookup unavailable; using known station data near ${fallbackStations[0].name}.`);
  }
  return {
    stations: supportedStations,
    mapStations,
    totalStations: uniqueStations.length,
    lookupLimited: uniqueStations.length > maxTimetableStations,
    overpassUnavailable: Boolean(overpassError),
  };
}

function unwrapItems(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const data of [payload.data, payload]) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') continue;
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }
  }
  throw new Error('Train data API returned an unsupported response format.');
}

function normalizeName(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z\d]/g, '') : '';
}

function stationCodeFromRecord(record) {
  if (!record || typeof record !== 'object') return '';
  return record.stationCode || record.stnCode || record.station_code || record.code
    || record.station?.stationCode || record.station?.stnCode || record.station?.station_code || record.station?.code
    || '';
}

async function resolveStationCode(name) {
  const result = await fetchRailwayData(`/stations/search?q=${encodeURIComponent(name)}&limit=5`, 24 * 60 * 60 * 1000);
  const matches = unwrapItems(result, ['stations', 'results', 'matches']);
  const stationName = normalizeName(name);
  const match = matches.find((candidate) => {
    const candidateName = normalizeName(candidate.stationName || candidate.station_name || candidate.stnName || candidate.name || candidate.station?.name);
    return candidateName && (candidateName === stationName || candidateName.includes(stationName) || stationName.includes(candidateName));
  });
  return match ? String(stationCodeFromRecord(match)).toUpperCase() : '';
}

function pickText(...values) {
  for (const value of values) {
    const text = typeof value === 'object' && value !== null ? value.name || value.stationName || value.stnName : value;
    if (typeof text === 'string' && text.trim() && text !== '--' && text !== '-') return text.trim();
  }
  return '';
}

function scheduledValue(value) {
  if (typeof value === 'object' && value !== null) {
    return pickText(value.scheduled, value.scheduledTime, value.time, value.actual);
  }
  return pickText(value);
}

function actualValue(value) {
  if (typeof value === 'object' && value !== null) {
    return pickText(value.actual, value.actualTime, value.revised);
  }
  return '';
}

function parseDelay(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || value === '--' || value === '-') return null;
  const hoursAndMinutes = value.match(/^(-?)(\d{1,2}):(\d{2})\s*(?:h(?:rs?)?|hours?)\.?$/i);
  if (hoursAndMinutes) {
    return (hoursAndMinutes[1] === '-' ? -1 : 1)
      * (Number(hoursAndMinutes[2]) * 60 + Number(hoursAndMinutes[3]));
  }
  const clock = value.match(/^(-?)(\d{1,2}):(\d{2})$/);
  if (clock) return (clock[1] === '-' ? -1 : 1) * (Number(clock[2]) * 60 + Number(clock[3]));
  const minutes = value.match(/-?\d+/);
  return minutes ? Number(minutes[0]) : null;
}

function hasStationStop(train, stationCode) {
  if (typeof train?.isHalt === 'boolean') return train.isHalt;
  const stopArrays = [train.stops, train.haltsOnly, train.halts, train.route];
  return stopArrays.some((stops) => Array.isArray(stops) && stops.some((stop) => (
    String(typeof stop === 'string' ? stop : stationCodeFromRecord(stop) || '').toUpperCase() === stationCode
  )));
}

function normalizeTrain(train) {
  const record = train?.train && typeof train.train === 'object' ? { ...train.train, ...train } : train;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Train data API returned an invalid train record.');
  }

  const arrival = record.arrival ?? record.arrivalTime ?? record.scheduledArrival;
  const departure = record.departure ?? record.departureTime ?? record.scheduledDeparture;
  const delay = parseDelay(record.delayMinutes ?? record.delayInMinutes ?? record.delay ?? arrival?.delay ?? departure?.delay);
  return {
    trainId: String(record.trainNumber || record.trainNo || record.train_number || record.number || record.trainInfo?.train_no || ''),
    trainName: pickText(record.trainName, record.name, record.train_name, record.trainInfo?.train_name) || 'Unknown train',
    source: pickText(record.sourceName, record.source, record.sourceStation, record.fromStation, record.from?.name, record.fromStationName, record.origin?.name, record.origin),
    destination: pickText(record.destName, record.destination, record.dest, record.destinationStation, record.toStation, record.to?.name, record.toStationName, record.destinationName, record.destination?.name),
    scheduledArrival: scheduledValue(arrival) || pickText(record.scheduledArrival, record.arrivalScheduled, record.arrivalTimeScheduled),
    actualArrival: actualValue(arrival) || pickText(record.actualArrival, record.revisedArrival, record.arrivalActual, record.arrivalTimeActual),
    expectedArrival: pickText(record.expectedArrival),
    scheduledDeparture: scheduledValue(departure) || pickText(record.scheduledDeparture, record.departureScheduled, record.departureTimeScheduled),
    actualDeparture: actualValue(departure) || pickText(record.actualDeparture, record.revisedDeparture, record.departureActual, record.departureTimeActual),
    expectedDeparture: pickText(record.expectedDeparture),
    delayMinutes: delay,
    platform: pickText(record.platform, record.platformNumber) || '—',
    stationLiveStatus: pickText(record.liveStatus),
    stopsHere: false,
  };
}

function routeStops(routeData) {
  if (Array.isArray(routeData.stops)) return routeData.stops;
  if (Array.isArray(routeData.route)) return routeData.route;
  throw new Error('RailRadar route response did not include stops. Confirm the `stops=true` response format.');
}

function routeCoordinates(routeData) {
  const geometryValue = routeData.geometry || routeData.geojson?.geometry || routeData.routeGeometry;
  const geometry = geometryValue?.type === 'Feature' ? geometryValue.geometry : geometryValue;
  if (geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates
      .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
      .map(([lng, lat]) => [Number(lat), Number(lng)]);
  }
  if (Array.isArray(routeData.coordinates)) {
    return routeData.coordinates
      .filter((point) => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
      .map(([lat, lng]) => [Number(lat), Number(lng)]);
  }
  return [];
}

async function fetchProvider(url, options) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      lastError = error;
      if (attempt === 1 || (!(error instanceof TypeError) && error.name !== 'TimeoutError')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

async function loadTrainRoute(trainNumber) {
  if (!process.env.RAILRADAR_API_KEY) {
    const error = new Error('Set RAILRADAR_API_KEY in .env to classify train stops and load route coordinates.');
    error.statusCode = 503;
    throw error;
  }

  const cached = routeCache.get(trainNumber);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const url = new URL(`${railRadarBaseUrl}/trains/${encodeURIComponent(trainNumber)}/route`);
    url.searchParams.set('format', 'geojson');
    url.searchParams.set('stops', 'true');
    const response = await fetchProvider(url, {
      headers: { Authorization: `Bearer ${process.env.RAILRADAR_API_KEY}` },
    });
    if (response.status === 429) {
      throw new Error('RailRadar request quota or rate limit exceeded. Check your plan quota and retry after it resets.');
    }
    if (!response.ok) throw new Error(`RailRadar route lookup failed for train ${trainNumber} (${response.status}).`);
    const payload = await response.json();
    if (payload.success === false) throw new Error(payload.error || `RailRadar could not load train ${trainNumber}'s route.`);
    const data = payload.data ?? payload;
    if (!data || typeof data !== 'object') throw new Error(`RailRadar returned an invalid route for train ${trainNumber}.`);
    return data;
  })();

  routeCache.set(trainNumber, { promise, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 });
  try {
    return await promise;
  } catch (error) {
    routeCache.delete(trainNumber);
    throw error;
  }
}

function coordinateDistanceKm(first, second) {
  return distanceKm(first[0], first[1], second[0], second[1]);
}

async function loadStationBoard(stationCode, hours) {
  const data = await fetchRailwayData(
    `/station/${encodeURIComponent(stationCode)}/live?hours=${hours}`,
    30 * 1000,
  );
  return {
    records: unwrapItems(data, ['trains', 'arrivals', 'departures']),
    observedAt: data.observedAt || null,
  };
}

async function loadTrainStatus(trainNumber) {
  return fetchRailwayData(`/train/${encodeURIComponent(trainNumber)}/status`, 30 * 1000);
}

async function loadNearbyRailways(lat, lng, radiusKm) {
  const cacheKey = `${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}`;
  const cached = railwayCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const radiusMeters = Math.round(radiusKm * 1000);
    const query = `[out:json][timeout:15];way(around:${radiusMeters},${lat},${lng})["railway"~"^(rail|narrow_gauge|light_rail)$"];out geom;`;
    const response = await fetch(overpassUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Trackside/1.0',
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`OpenStreetMap railway lookup failed (${response.status}).`);
    const payload = await response.json();
    if (!Array.isArray(payload.elements)) throw new Error('OpenStreetMap returned invalid railway geometry.');

    const elements = payload.elements.filter((element) => element.type === 'way' && Array.isArray(element.geometry));
    const railways = elements.slice(0, 400).map((element) => {
      const coordinates = element.geometry
        .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
        .map((point) => [Number(point.lat), Number(point.lon)]);
      return { id: String(element.id), coordinates: simplifyCoordinates(coordinates, 160) };
    }).filter((railway) => railway.coordinates.length > 1);
    return { railways, truncated: elements.length > railways.length || elements.length > 400 };
  })();

  railwayCache.set(cacheKey, { promise, expiresAt: Date.now() + 30 * 60 * 1000 });
  try {
    return await promise;
  } catch (error) {
    railwayCache.delete(cacheKey);
    throw error;
  }
}

function nearestRailwayPoint(lat, lng, railways) {
  let closest = null;
  const scale = Math.cos((lat * Math.PI) / 180);
  for (const railway of railways) {
    const points = railway.coordinates;
    for (let index = 0; index < points.length - 1; index += 1) {
      const first = points[index];
      const second = points[index + 1];
      const firstX = first[1] * scale;
      const firstY = first[0];
      const secondX = second[1] * scale;
      const secondY = second[0];
      const targetX = lng * scale;
      const targetY = lat;
      const dx = secondX - firstX;
      const dy = secondY - firstY;
      const segmentLengthSquared = dx * dx + dy * dy;
      const fraction = segmentLengthSquared
        ? Math.max(0, Math.min(1, ((targetX - firstX) * dx + (targetY - firstY) * dy) / segmentLengthSquared))
        : 0;
      const candidate = [
        first[0] + (second[0] - first[0]) * fraction,
        first[1] + (second[1] - first[1]) * fraction,
      ];
      const separationKm = distanceKm(lat, lng, candidate[0], candidate[1]);
      if (!closest || separationKm < closest.separationKm) {
        closest = { lat: candidate[0], lng: candidate[1], separationKm };
      }
    }
  }
  return closest && closest.separationKm <= 1.5 ? closest : null;
}

function nearestCoordinateIndex(coordinates, point) {
  let nearestIndex = -1;
  let shortestDistance = Infinity;
  coordinates.forEach(([lat, lng], index) => {
    const distance = (lat - point[0]) ** 2 + (lng - point[1]) ** 2;
    if (distance < shortestDistance) {
      shortestDistance = distance;
      nearestIndex = index;
    }
  });
  return nearestIndex;
}

function pointBetweenCoordinates(coordinates, startIndex, endIndex, fraction) {
  const firstIndex = Math.min(startIndex, endIndex);
  const lastIndex = Math.max(startIndex, endIndex);
  if (firstIndex === lastIndex) return coordinates[firstIndex];

  const segments = [];
  let totalDistance = 0;
  for (let index = firstIndex; index < lastIndex; index += 1) {
    const segmentDistance = coordinateDistanceKm(coordinates[index], coordinates[index + 1]);
    segments.push(segmentDistance);
    totalDistance += segmentDistance;
  }
  if (totalDistance === 0) return coordinates[firstIndex];

  let remaining = totalDistance * Math.max(0, Math.min(1, fraction));
  for (let offset = 0; offset < segments.length; offset += 1) {
    if (remaining <= segments[offset] || offset === segments.length - 1) {
      const segmentFraction = segments[offset] ? remaining / segments[offset] : 0;
      const start = coordinates[firstIndex + offset];
      const end = coordinates[firstIndex + offset + 1];
      return [
        start[0] + (end[0] - start[0]) * segmentFraction,
        start[1] + (end[1] - start[1]) * segmentFraction,
      ];
    }
    remaining -= segments[offset];
  }
  return coordinates[lastIndex];
}

function positionBetweenAnchors(anchors, coordinates, value, field) {
  if (!Number.isFinite(value) || !anchors.length) return null;
  const ordered = anchors
    .filter((anchor) => Number.isFinite(anchor[field]))
    .sort((a, b) => a[field] - b[field]);
  if (!ordered.length) return null;
  if (value <= ordered[0][field]) {
    return coordinates[ordered[0].coordinateIndex];
  }
  if (value >= ordered[ordered.length - 1][field]) {
    return coordinates[ordered[ordered.length - 1].coordinateIndex];
  }

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (value < start[field] || value > end[field]) continue;
    const span = end[field] - start[field];
    const fraction = span ? (value - start[field]) / span : 0;
    return pointBetweenCoordinates(coordinates, start.coordinateIndex, end.coordinateIndex, fraction);
  }
  return null;
}

function parseScheduleTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed) && /[T-]/.test(value)) return parsed;

  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (minute > 59 || hour > (period ? 12 : 23) || hour < (period ? 1 : 0)) return null;
  if (period) hour = (hour % 12) + (period === 'PM' ? 12 : 0);

  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const parts = Object.fromEntries(dateParts.map(({ type, value: partValue }) => [type, partValue]));
  let timestamp = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute) - (5.5 * 60 * 60 * 1000);
  const halfDay = 12 * 60 * 60 * 1000;
  while (timestamp - now > halfDay) timestamp -= 24 * 60 * 60 * 1000;
  while (now - timestamp > halfDay) timestamp += 24 * 60 * 60 * 1000;
  return timestamp;
}

function scheduleTimestamp(stop, keys, now) {
  for (const key of keys) {
    const timestamp = parseScheduleTime(stop[key], now);
    if (timestamp != null) return timestamp;
  }
  return null;
}

function trainPosition(routeData, liveData, timetableEvents = []) {
  const coordinates = routeCoordinates(routeData);
  if (coordinates.length < 2) return null;

  const geoStops = routeStops(routeData)
    .map((stop) => {
      const code = String(stationCodeFromRecord(stop)).toUpperCase();
      const lat = Number(stop.lat ?? stop.latitude);
      const lng = Number(stop.lng ?? stop.lon ?? stop.longitude);
      if (!code || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { code, name: pickText(stop.name, stop.stationName, stop.station_name), lat, lng };
    })
    .filter(Boolean);
  const liveStops = Array.isArray(liveData?.route) ? liveData.route : [];
  const liveStopsByCode = new Map(liveStops.map((stop) => [String(stationCodeFromRecord(stop)).toUpperCase(), stop]));
  const anchors = geoStops.map((stop) => {
    const liveStop = liveStopsByCode.get(stop.code) || {};
    return {
      ...stop,
      ...liveStop,
      code: stop.code,
      name: stop.name || pickText(liveStop.stationName, liveStop.name),
      coordinateIndex: nearestCoordinateIndex(coordinates, [stop.lat, stop.lng]),
      distance: Number(liveStop.distance),
    };
  }).filter((anchor) => anchor.coordinateIndex >= 0);

  const currentLocation = liveData?.currentLocation;
  const currentCode = String(currentLocation?.stationCode || '').toUpperCase();
  const currentStop = anchors.find((anchor) => anchor.code === currentCode);
  if (currentStop) {
    return {
      lat: currentStop.lat,
      lng: currentStop.lng,
      mode: liveData?.isLive ? 'live' : 'predicted',
      label: `At ${currentStop.name || currentCode}`,
      updatedAt: liveData?.lastUpdatedAt || null,
    };
  }

  const progressKm = Number(currentLocation?.distanceFromOriginKm);
  const distancePosition = positionBetweenAnchors(anchors, coordinates, progressKm, 'distance');
  if (distancePosition) {
    return {
      lat: distancePosition[0],
      lng: distancePosition[1],
      mode: liveData?.isLive ? 'live' : 'predicted',
      label: liveData?.isLive ? 'Live track position' : 'Estimated from route progress',
      updatedAt: liveData?.lastUpdatedAt || null,
    };
  }

  const timedAnchors = anchors.map((anchor) => {
    const now = Date.now();
    const departure = scheduleTimestamp(anchor, ['actualDeparture', 'scheduledDeparture'], now);
    const arrival = scheduleTimestamp(anchor, ['actualArrival', 'scheduledArrival'], now);
    return {
      ...anchor,
      time: departure ?? arrival,
      arrivalTime: arrival,
      departureTime: departure,
    };
  }).filter((anchor) => anchor.time != null).sort((a, b) => a.sequence - b.sequence);
  const now = Date.now();

  for (let index = 0; index < timedAnchors.length - 1; index += 1) {
    const start = timedAnchors[index];
    const end = timedAnchors[index + 1];
    const startTime = start.departureTime ?? start.arrivalTime;
    const endTime = end.arrivalTime ?? end.departureTime;
    if (startTime == null || endTime == null || endTime <= startTime || now < startTime || now > endTime) continue;
    const point = pointBetweenCoordinates(
      coordinates,
      start.coordinateIndex,
      end.coordinateIndex,
      (now - startTime) / (endTime - startTime),
    );
    return {
      lat: point[0],
      lng: point[1],
      mode: 'predicted',
      label: 'Estimated from timetable',
      updatedAt: liveData?.lastUpdatedAt || null,
    };
  }

  const stationAnchors = timetableEvents.map((event) => {
    const anchor = anchors.find((candidate) => candidate.code === event.stationCode);
    if (!anchor) return null;
    const timestamp = scheduleTimestamp(event, ['actualArrival', 'actualDeparture', 'scheduledArrival', 'scheduledDeparture'], now);
    return {
      ...anchor,
      time: timestamp,
      eventStationName: event.stationName,
      eventTimeText: event.actualArrival || event.actualDeparture || event.scheduledArrival || event.scheduledDeparture,
    };
  }).filter((anchor) => anchor && anchor.time != null)
    .sort((a, b) => a.sequence - b.sequence || a.time - b.time);

  for (let index = 0; index < stationAnchors.length - 1; index += 1) {
    const start = stationAnchors[index];
    const end = stationAnchors[index + 1];
    if (end.time <= start.time || now < start.time || now > end.time) continue;
    const point = pointBetweenCoordinates(
      coordinates,
      start.coordinateIndex,
      end.coordinateIndex,
      (now - start.time) / (end.time - start.time),
    );
    return {
      lat: point[0],
      lng: point[1],
      mode: 'predicted',
      label: `Estimated between ${start.name} and ${end.name}`,
      updatedAt: liveData?.lastUpdatedAt || null,
    };
  }

  const nextEvent = stationAnchors.find((anchor) => anchor.time >= now);
  if (nextEvent) {
    return {
      lat: nextEvent.lat,
      lng: nextEvent.lng,
      mode: 'predicted',
      label: `Scheduled at ${nextEvent.eventStationName} · ${nextEvent.eventTimeText}`,
      eventTime: nextEvent.eventTimeText,
      updatedAt: liveData?.lastUpdatedAt || null,
    };
  }

  const nextStop = timedAnchors.find((stop) => stop.time >= now);
  if (nextStop) {
    return {
      lat: nextStop.lat,
      lng: nextStop.lng,
      mode: 'predicted',
      label: `Next scheduled stop: ${nextStop.name || nextStop.code}`,
      updatedAt: liveData.lastUpdatedAt || null,
    };
  }
  return null;
}

function timetableTrainPosition(status, timetableEvents, stations, railways, center) {
  const observationTime = status?.freshness?.observedAt || status?.observedAt || null;
  const apiPosition = status?.position;
  const directLat = Number(apiPosition?.latitude);
  const directLng = Number(apiPosition?.longitude);
  if (Number.isFinite(directLat) && Number.isFinite(directLng)
    && distanceKm(center.lat, center.lng, directLat, directLng) <= stationNetworkRadiusKm) {
    return {
      lat: directLat,
      lng: directLng,
      mode: 'live',
      label: 'Live train position reported by provider',
      updatedAt: observationTime,
    };
  }

  const stationByCode = new Map(stations.map((station) => [String(station.code || '').toUpperCase(), station]));
  const currentStation = status?.currentStation;
  const currentCode = String(currentStation?.code || '').toUpperCase();
  const current = stationByCode.get(currentCode);
  if (current && Number.isFinite(current.lat) && Number.isFinite(current.lng)) {
    const snapped = nearestRailwayPoint(current.lat, current.lng, railways);
    const point = snapped || current;
    return {
      lat: point.lat,
      lng: point.lng,
      mode: 'reported',
      label: `Last reported at ${current.name || currentStation.name || currentCode}`,
      updatedAt: observationTime,
    };
  }

  const now = Date.now();
  const timedEvents = timetableEvents.map((event) => ({
    ...event,
    time: scheduleTimestamp(event, [
      'expectedArrival',
      'expectedDeparture',
      'actualArrival',
      'actualDeparture',
      'scheduledArrival',
      'scheduledDeparture',
    ], now),
  })).filter((event) => event.time != null
    && Number.isFinite(event.stationLat)
    && Number.isFinite(event.stationLng))
    .sort((first, second) => first.time - second.time);
  const uniqueEvents = timedEvents.filter((event, index) => (
    index === 0 || event.stationCode !== timedEvents[index - 1].stationCode
  ));

  for (let index = 0; index < uniqueEvents.length - 1; index += 1) {
    const start = uniqueEvents[index];
    const end = uniqueEvents[index + 1];
    if (end.time <= start.time || now < start.time || now > end.time) continue;
    const fraction = (now - start.time) / (end.time - start.time);
    const interpolatedLat = start.stationLat + (end.stationLat - start.stationLat) * fraction;
    const interpolatedLng = start.stationLng + (end.stationLng - start.stationLng) * fraction;
    const snapped = nearestRailwayPoint(interpolatedLat, interpolatedLng, railways);
    if (snapped) {
      return {
        lat: snapped.lat,
        lng: snapped.lng,
        mode: 'predicted',
        label: `Estimated on nearby railway between ${start.stationName} and ${end.stationName}`,
        eventTime: end.expectedArrival || end.expectedDeparture || end.scheduledArrival || end.scheduledDeparture,
        updatedAt: observationTime,
      };
    }
  }

  const nextEvent = uniqueEvents.find((event) => event.time >= now) || uniqueEvents[0];
  if (!nextEvent) return null;
  const snapped = nearestRailwayPoint(nextEvent.stationLat, nextEvent.stationLng, railways);
  const point = snapped || { lat: nextEvent.stationLat, lng: nextEvent.stationLng };
  return {
    lat: point.lat,
    lng: point.lng,
    mode: 'predicted',
    label: snapped
      ? `Estimated at ${nextEvent.stationName} on nearby railway`
      : `Scheduled at ${nextEvent.stationName}; railway geometry unavailable`,
    eventTime: nextEvent.expectedArrival || nextEvent.expectedDeparture || nextEvent.scheduledArrival || nextEvent.scheduledDeparture,
    updatedAt: observationTime,
  };
}

function simplifyCoordinates(coordinates, maxPoints = 300) {
  if (coordinates.length <= maxPoints) return coordinates;
  const step = (coordinates.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => coordinates[Math.round(index * step)]);
}

async function mapInBatches(items, batchSize, callback) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    results.push(...await Promise.all(batch.map(callback)));
  }
  return results;
}

router.get('/nearby', async (req, res, next) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusKm = Number(req.query.radiusKm ?? 8);
  const hours = Number(req.query.hours ?? 2);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Provide valid latitude and longitude.' });
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 1 || radiusKm > 50) {
    return res.status(400).json({ error: 'Radius must be between 1 and 50 km.' });
  }
  if (![2, 4, 8].includes(hours)) {
    return res.status(400).json({ error: 'Hours must be 2, 4, or 8 to match the station timetable API.' });
  }

  try {
    configureRailkit();
    const network = await findNearbyStations(lat, lng, stationNetworkRadiusKm);
    const station = network.stations[0];
    const warnings = [];
    if (network.overpassUnavailable) {
      warnings.push('OpenStreetMap is unavailable; the nearby station list may be incomplete.');
    }
    if (network.lookupLimited) {
      warnings.push(`Station lookup found ${network.totalStations} nearby stations; timetable coverage is limited to the ${maxTimetableStations} closest coded stations.`);
    }

    let primaryResult;
    try {
      primaryResult = await liveAtStation(station.code, hours);
    } catch (error) {
      throw new Error(`${station.name} (${station.code}) timetable failed: ${error.message}`);
    }
    const primaryRecords = unwrapItems(primaryResult, ['trains', 'upcomingTrains', 'trainsAtStation', 'arrivals', 'departures']);
    const primaryTrainIds = [...new Set(primaryRecords.map((record) => String(
      record?.trainNumber || record?.trainNo || record?.train_number || record?.number || record?.trainInfo?.train_no || '',
    )).filter(Boolean))];
    if (primaryTrainIds.length > maxRouteLookupsPerRequest) {
      warnings.push(`Route lookup is limited to ${maxRouteLookupsPerRequest} trains per refresh to conserve the monthly RailRadar quota.`);
    }
    const routeLookupTrainIds = primaryTrainIds.slice(0, maxRouteLookupsPerRequest);
    const primaryRoutes = await mapInBatches(routeLookupTrainIds, 2, async (trainId) => {
      try {
        return { trainId, route: await loadTrainRoute(trainId) };
      } catch (error) {
        warnings.push(`Train ${trainId} route unavailable while finding connected stations: ${error.message}`);
        return { trainId, route: null };
      }
    });

    const routeStations = [];
    for (const { route } of primaryRoutes) {
      if (!route) continue;
      try {
        for (const stop of routeStops(route)) {
          const code = String(stationCodeFromRecord(stop)).toUpperCase();
          const stopLat = Number(stop.lat ?? stop.latitude);
          const stopLng = Number(stop.lng ?? stop.lon ?? stop.longitude);
          if (!code || !Number.isFinite(stopLat) || !Number.isFinite(stopLng)) continue;
          const stopDistanceKm = distanceKm(lat, lng, stopLat, stopLng);
          if (stopDistanceKm > stationNetworkRadiusKm) continue;
          routeStations.push({
            name: pickText(stop.name, stop.stationName, stop.station_name) || code,
            code,
            lat: stopLat,
            lng: stopLng,
            distanceKm: stopDistanceKm,
            fromTrainRoute: true,
          });
        }
      } catch (error) {
        warnings.push(`A train route could not be used to discover nearby stations: ${error.message}`);
      }
    }

    const combinedStations = [...network.mapStations, ...routeStations];
    const stationsByCode = new Map();
    const stationsWithoutCode = [];
    for (const candidate of combinedStations) {
      if (candidate.code) {
        const existing = stationsByCode.get(candidate.code);
        if (!existing || candidate.distanceKm < existing.distanceKm) stationsByCode.set(candidate.code, candidate);
      } else {
        stationsWithoutCode.push(candidate);
      }
    }
    const stations = [...stationsByCode.values(), ...stationsWithoutCode]
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const codedStations = [...stationsByCode.values()].sort((a, b) => a.distanceKm - b.distanceKm);
    const boardStations = codedStations.slice(0, maxTimetableStations);
    if (codedStations.length > maxTimetableStations && !network.lookupLimited) {
      warnings.push(`Showing timetables for the ${maxTimetableStations} closest coded stations out of ${codedStations.length}.`);
    }

    const boards = [{
      station,
      records: primaryRecords,
    }, ...await mapInBatches(boardStations.filter((candidate) => candidate.code !== station.code), 2, async (boardStation) => {
      try {
        const result = await liveAtStation(boardStation.code, hours);
        return {
          station: boardStation,
          records: unwrapItems(result, ['trains', 'upcomingTrains', 'trainsAtStation', 'arrivals', 'departures']),
        };
      } catch (error) {
        return { station: boardStation, records: [], error };
      }
    })];
    for (const board of boards) {
      if (board.error) warnings.push(`${board.station.name} (${board.station.code}) timetable failed: ${board.error.message}`);
    }

    const events = [];
    const trainRecords = new Map();
    const trainEvents = new Map();
    for (const board of boards) {
      for (const record of board.records) {
        try {
          const normalized = normalizeTrain(record);
          if (!normalized.trainId) throw new Error('RailKit returned a train without a train number.');
          const event = {
            ...normalized,
            stationCode: board.station.code,
            stationName: board.station.name,
            stationLat: board.station.lat,
            stationLng: board.station.lng,
            stationDistanceKm: board.station.distanceKm,
            stopsHere: hasStationStop(record, board.station.code),
          };
          events.push(event);
          if (!trainEvents.has(normalized.trainId)) trainEvents.set(normalized.trainId, []);
          trainEvents.get(normalized.trainId).push(event);
          if (!trainRecords.has(normalized.trainId)) trainRecords.set(normalized.trainId, record);
        } catch (error) {
          warnings.push(`${board.station.name} returned an invalid train record: ${error.message}`);
        }
      }
    }

    const trainIds = [...trainRecords.keys()];
    const primaryRouteById = new Map(primaryRoutes.filter((item) => item.route).map((item) => [item.trainId, item.route]));
    const trainDetails = await mapInBatches(trainIds, 2, async (trainId) => {
      const route = primaryRouteById.get(trainId) || null;
      const record = trainRecords.get(trainId);
      let position = null;
      let stops = [];
      let coordinates = [];
      if (route) {
        try {
          stops = routeStops(route);
          coordinates = routeCoordinates(route);
          position = trainPosition(route, null, trainEvents.get(trainId));
        } catch (error) {
          warnings.push(`Train ${trainId} route could not be mapped: ${error.message}`);
        }
      }
      if (!position) {
        const event = (trainEvents.get(trainId) || []).find((timetableEvent) => (
          Number.isFinite(timetableEvent.stationLat) && Number.isFinite(timetableEvent.stationLng)
        ));
        if (event) {
          position = {
            lat: event.stationLat,
            lng: event.stationLng,
            mode: 'predicted',
            label: `Timetable event at ${event.stationName}`,
            eventTime: event.actualArrival || event.actualDeparture || event.scheduledArrival || event.scheduledDeparture || null,
            updatedAt: null,
          };
        }
      }
      return {
        trainId,
        train: normalizeTrain(record),
        routeStops: stops,
        routeCoordinates: simplifyCoordinates(coordinates),
        position,
        liveStatus: 'timetable-estimate',
        liveUpdatedAt: null,
      };
    });
    const trainDetailsById = new Map(trainDetails.map((detail) => [detail.trainId, detail]));
    for (const event of events) {
      const details = trainDetailsById.get(event.trainId);
      if (details) {
        event.stopsHere = event.stopsHere || details.routeStops.some((stop) => (
          String(stationCodeFromRecord(stop)).toUpperCase() === event.stationCode
        ));
      }
    }

    const stationMarkers = stations.map((mapStation) => ({
      ...mapStation,
      trainCount: events.filter((event) => event.stationCode === mapStation.code).length,
      boardAvailable: boardStations.some((boardStation) => boardStation.code === mapStation.code),
    }));
    const trainPositions = trainDetails.map(({ trainId, train, routeCoordinates: coordinates, position, liveStatus, liveUpdatedAt }) => ({
      ...train,
      trainId,
      routeCoordinates: coordinates,
      position,
      liveStatus,
      liveUpdatedAt,
    }));

    return res.json({
      source: 'live',
      station,
      stations: stationMarkers,
      trains: events,
      trainPositions,
      center: { lat, lng },
      stationNetworkRadiusKm,
      hours,
      warnings,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
