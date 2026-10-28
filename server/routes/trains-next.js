import { Router } from 'express';

const router = Router();
const overpassUrls = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
  'https://overpass.openstreetmap.ru/cgi/interpreter',
];
const railwayApiBaseUrl = 'https://railway-engine.apkscope.workers.dev/v1';
const providerCache = new Map();
const overpassCache = new Map();
const stationNetworkRadiusKm = 15;
const maxTimetableStations = 20;
const maxStatusLookupsPerRequest = 20;
let nextOverpassUrl = 0;
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

function normalizeName(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z\d]/g, '') : '';
}

function stationCodeFrom(tags = {}) {
  const code = tags['ref:IN'] || tags['railway:ref'] || tags.ref || tags.uic_ref;
  return typeof code === 'string' && /^[a-z\d]{2,5}$/i.test(code.trim())
    ? code.trim().toUpperCase()
    : '';
}

async function loadNearbyOverpassData(lat, lng, radiusKm) {
  const cacheKey = `${lat.toFixed(3)}:${lng.toFixed(3)}:${radiusKm}`;
  const cached = overpassCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error) throw cached.error;
    return cached.promise;
  }

  const promise = (async () => {
    const radiusMeters = Math.round(radiusKm * 1000);
    const query = `[out:json][timeout:8];nwr["railway"~"^(station|halt)$"](around:${radiusMeters},${lat},${lng});out center tags;way(around:${radiusMeters},${lat},${lng})["railway"~"^(rail|narrow_gauge|light_rail)$"];out geom;`;
    const errors = [];
    const firstUrl = nextOverpassUrl++ % overpassUrls.length;
    const attempts = Math.min(3, overpassUrls.length);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = overpassUrls[(firstUrl + attempt) % overpassUrls.length];
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': 'Trackside/1.0',
          },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(9000),
        });
        if (!response.ok) {
          throw new Error(`OpenStreetMap returned HTTP ${response.status}.`);
        }
        if (!response.headers.get('content-type')?.includes('json')) {
          throw new Error('OpenStreetMap returned a non-JSON response.');
        }
        const payload = await response.json();
        if (!Array.isArray(payload.elements)
          || !/^\d{4}-\d{2}-\d{2}T/.test(payload.osm3s?.timestamp_osm_base || '')) {
          throw new Error('OpenStreetMap returned invalid or incomplete station and railway data.');
        }
        return payload.elements;
      } catch (error) {
        errors.push(`${new URL(url).hostname}: ${error.message}`);
      }
    }

    throw new Error(`All OpenStreetMap Overpass servers failed (${errors.join('; ')}).`);
  })();

  overpassCache.set(cacheKey, { promise, expiresAt: Date.now() + 15 * 60 * 1000 });
  try {
    return await promise;
  } catch (error) {
    overpassCache.set(cacheKey, { error, expiresAt: Date.now() + 60 * 1000 });
    throw error;
  }
}

function stationCodeFromRecord(record) {
  if (!record || typeof record !== 'object') return '';
  return record.stationCode || record.stnCode || record.station_code || record.code
    || record.station?.stationCode || record.station?.stnCode || record.station?.station_code || record.station?.code
    || '';
}

function pickText(...values) {
  for (const value of values) {
    const text = typeof value === 'object' && value !== null
      ? value.name || value.stationName || value.stnName
      : value;
    if (typeof text === 'string' && text.trim() && text !== '--' && text !== '-') return text.trim();
  }
  return '';
}

function pickTime(...values) {
  for (const value of values) {
    if (typeof value === 'string') {
      if (value.trim() && value !== '--' && value !== '-') return value.trim();
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const time = pickText(value.actual, value.expected, value.scheduled, value.time, value.value);
    if (time) return time;
  }
  return '';
}

function parseDelay(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim() || value === '--' || value === '-') return null;
  const match = value.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function getApiKey() {
  const key = process.env.RAILWAY_API_KEY;
  if (!key) {
    const error = new Error('Set RAILWAY_API_KEY in .env to load live train data.');
    error.statusCode = 503;
    throw error;
  }
  return key;
}

async function fetchRailwayData(path, cacheMs = 0) {
  const cached = providerCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const response = await fetch(`${railwayApiBaseUrl}${path}`, {
      headers: { 'x-api-key': getApiKey(), Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.status !== 'SUCCESS') {
      const error = new Error(response.status === 429 || payload?.error?.code?.includes('RATE_LIMIT')
        ? 'Train data API rate limit reached. Wait before refreshing.'
        : payload?.error?.message || `Train data API request failed (${response.status}).`);
      error.statusCode = response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status;
      throw error;
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw new Error('Train data API returned an unsupported response.');
    }
    return payload.data;
  })();

  if (cacheMs > 0) providerCache.set(path, { promise, expiresAt: Date.now() + cacheMs });
  try {
    return await promise;
  } catch (error) {
    providerCache.delete(path);
    throw error;
  }
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

async function resolveStationCode(name) {
  const data = await fetchRailwayData(`/stations/search?q=${encodeURIComponent(name)}&limit=5`, 24 * 60 * 60 * 1000);
  const matches = unwrapItems(data, ['stations', 'results', 'matches']);
  const requestedName = normalizeName(name);
  const match = matches.find((candidate) => {
    const candidateName = normalizeName(candidate.stationName || candidate.station_name || candidate.stnName || candidate.name || candidate.station?.name);
    return candidateName && (
      candidateName === requestedName
      || candidateName.includes(requestedName)
      || requestedName.includes(candidateName)
    );
  });
  return match ? String(stationCodeFromRecord(match)).toUpperCase() : '';
}

async function mapInBatches(items, batchSize, callback) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    results.push(...await Promise.all(items.slice(index, index + batchSize).map(callback)));
  }
  return results;
}

async function findNearbyStations(lat, lng, radiusKm) {
  const fallbackStations = knownStations
    .map((station) => ({ ...station, distanceKm: distanceKm(lat, lng, station.lat, station.lng), fallback: true }))
    .filter((station) => station.distanceKm <= radiusKm);
  let elements;
  let overpassError;

  try {
    elements = await loadNearbyOverpassData(lat, lng, radiusKm);
  } catch (error) {
    overpassError = error;
  }

  const osmStations = (elements || []).filter((element) => (
    element.tags?.railway === 'station' || element.tags?.railway === 'halt'
  )).map((element) => {
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
  }).filter(Boolean);

  const combined = [...osmStations, ...fallbackStations].sort((first, second) => first.distanceKm - second.distanceKm);
  const uniqueStations = [...new Map(combined.map((station) => [
    station.code || `${normalizeName(station.name)}:${station.lat.toFixed(4)}:${station.lng.toFixed(4)}`,
    station,
  ])).values()].sort((first, second) => first.distanceKm - second.distanceKm);

  if (!uniqueStations.length) {
    if (overpassError) {
      const message = overpassError.name === 'TimeoutError' || overpassError.name === 'AbortError'
        ? 'OpenStreetMap station lookup timed out. Check your connection and retry.'
        : overpassError instanceof TypeError
          ? 'Could not connect to OpenStreetMap. Check your internet connection or network restrictions.'
          : overpassError.message;
      const error = new Error(message);
      error.statusCode = 503;
      throw error;
    }
    throw new Error(`No railway station was found within ${radiusKm} km.`);
  }

  const candidates = uniqueStations.slice(0, maxTimetableStations);
  const resolved = await mapInBatches(candidates, 3, async (candidate) => {
    if (candidate.code) return candidate;
    try {
      const code = await resolveStationCode(candidate.name);
      return code ? { ...candidate, code } : null;
    } catch (error) {
      console.warn(`Could not resolve a station code for ${candidate.name}: ${error.message}`);
      return null;
    }
  });
  const resolvedByName = new Map(resolved.filter(Boolean).map((station) => [
    station.code || `${normalizeName(station.name)}:${station.lat.toFixed(4)}:${station.lng.toFixed(4)}`,
    station,
  ]));
  const mapStations = uniqueStations.map((candidate) => {
    const key = candidate.code || `${normalizeName(candidate.name)}:${candidate.lat.toFixed(4)}:${candidate.lng.toFixed(4)}`;
    return resolvedByName.get(key) || candidate;
  });
  const stations = mapStations.filter((station) => station.code);
  if (!stations.length) {
    const error = new Error(`Could not resolve a train-data station code for stations within ${radiusKm} km.`);
    error.statusCode = 503;
    throw error;
  }
  return {
    stations,
    mapStations,
    totalStations: uniqueStations.length,
    lookupLimited: uniqueStations.length > maxTimetableStations,
    overpassUnavailable: Boolean(overpassError),
    fallbackUsed: Boolean(overpassError && fallbackStations.length),
  };
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

function simplifyCoordinates(coordinates, maxPoints = 300) {
  if (coordinates.length <= maxPoints) return coordinates;
  const step = (coordinates.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, index) => coordinates[Math.round(index * step)]);
}

async function loadNearbyRailways(lat, lng, radiusKm) {
  const elements = await loadNearbyOverpassData(lat, lng, radiusKm);
  const ways = elements.filter((element) => element.type === 'way'
    && ['rail', 'narrow_gauge', 'light_rail'].includes(element.tags?.railway)
    && Array.isArray(element.geometry));
  const railways = ways.slice(0, 400).map((element) => {
    const coordinates = element.geometry
      .filter((point) => Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lon)))
      .map((point) => [Number(point.lat), Number(point.lon)]);
    return { id: String(element.id), coordinates: simplifyCoordinates(coordinates, 160) };
  }).filter((railway) => railway.coordinates.length > 1);
  return { railways, truncated: ways.length > railways.length || ways.length > 400 };
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
      const dx = second[1] * scale - firstX;
      const dy = second[0] - firstY;
      const denominator = dx * dx + dy * dy;
      const fraction = denominator
        ? Math.max(0, Math.min(1, ((lng * scale - firstX) * dx + (lat - firstY) * dy) / denominator))
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
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  let timestamp = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute)
    - (5.5 * 60 * 60 * 1000);
  const halfDay = 12 * 60 * 60 * 1000;
  while (timestamp - now > halfDay) timestamp -= 24 * 60 * 60 * 1000;
  while (now - timestamp > halfDay) timestamp += 24 * 60 * 60 * 1000;
  return timestamp;
}

function eventTimes(event, now) {
  return [
    'expectedArrival',
    'expectedDeparture',
    'actualArrival',
    'actualDeparture',
    'scheduledArrival',
    'scheduledDeparture',
  ].map((key) => parseScheduleTime(event[key], now))
    .filter((timestamp) => timestamp != null);
}

function eventTime(event, now) {
  const times = eventTimes(event, now).sort((first, second) => first - second);
  return times.find((time) => time >= now) ?? times.at(-1) ?? null;
}

function stationEventTime(event, now = Date.now()) {
  return eventTime(event, now);
}

function nextStopForEvent(event, relatedEvents, status, now = Date.now()) {
  if (status?.nextStation) {
    return {
      code: String(status.nextStation.code || '').toUpperCase(),
      name: pickText(status.nextStation.name, status.nextStation.code),
      time: status.eta?.value || null,
      source: 'live-status',
    };
  }

  const currentTime = stationEventTime(event, now);
  if (currentTime == null) return null;
  const nextEvent = relatedEvents
    .map((candidate) => ({ candidate, time: stationEventTime(candidate, now) }))
    .filter(({ candidate, time }) => (
      candidate.stationCode !== event.stationCode
      && time != null
      && time > currentTime
    ))
    .sort((first, second) => first.time - second.time)[0];
  return nextEvent ? {
    code: nextEvent.candidate.stationCode,
    name: nextEvent.candidate.stationName,
    time: nextEvent.candidate.expectedArrival || nextEvent.candidate.expectedDeparture
      || nextEvent.candidate.scheduledArrival || nextEvent.candidate.scheduledDeparture,
    source: 'nearby-timetable',
  } : null;
}

function isWithinSelectedWindow(events, status, hours, now = Date.now()) {
  const end = now + hours * 60 * 60 * 1000;
  const hasUpcomingBoardEvent = events.some((event) => {
    return eventTimes(event, now).some((time) => time >= now && time <= end);
  });
  if (hasUpcomingBoardEvent) return true;

  if (status?.status === 'RUNNING') {
    const eta = Date.parse(status.eta?.value || '');
    return Number.isFinite(eta) && eta >= now && eta <= end;
  }
  return false;
}

function selectedWindowEvent(events, status, hours, now) {
  if (!isWithinSelectedWindow(events, status, hours, now)) return null;
  const end = now + hours * 60 * 60 * 1000;
  const boardEvent = events.flatMap((event) => eventTimes(event, now)
    .filter((time) => time >= now && time <= end)
    .map((time) => ({ event, time })))
    .sort((first, second) => first.time - second.time)[0];
  const eta = Date.parse(status?.eta?.value || '');
  if (Number.isFinite(eta) && eta >= now && eta <= end
    && (!boardEvent || eta < boardEvent.time)) {
    return { event: null, time: eta };
  }
  return boardEvent || null;
}

function hasStationStop(record) {
  if (typeof record.isHalt === 'boolean') return record.isHalt;
  for (const key of ['haltsOnly', 'stops', 'halts', 'route']) {
    if (Array.isArray(record[key])) return record[key].length > 0;
  }
  return null;
}

function normalizeTrain(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Train data API returned an invalid train record.');
  }
  const trainId = String(
    record.trainId || record.trainNumber || record.trainNo || record.train_number || record.number
    || record.train?.trainNumber || record.train?.trainNo || record.train?.number || record.train?.train_number || ''
  ).trim();
  if (!trainId) throw new Error('Train data API returned a train without a train number.');
  return {
    trainId,
    trainName: pickText(record.trainName, record.name, record.train_name, record.train?.trainName) || 'Unknown train',
    source: pickText(record.origin?.name, record.origin, record.sourceName, record.source, record.fromStation, record.from?.name),
    destination: pickText(record.destination?.name, record.destination, record.destName, record.dest, record.toStation, record.to?.name),
    scheduledArrival: pickTime(record.scheduledArrival, record.arrival?.scheduled, record.arrivalTime, record.arrival),
    actualArrival: pickTime(record.actualArrival, record.arrivalActual, record.arrival?.actual),
    expectedArrival: pickTime(record.expectedArrival, record.arrival?.expected),
    scheduledDeparture: pickTime(record.scheduledDeparture, record.departure?.scheduled, record.departureTime, record.departure),
    actualDeparture: pickTime(record.actualDeparture, record.departureActual, record.departure?.actual),
    expectedDeparture: pickTime(record.expectedDeparture, record.departure?.expected),
    delayMinutes: parseDelay(record.delayMinutes ?? record.delay ?? record.delayInMinutes),
    platform: pickText(record.platform, record.platformNumber) || '—',
    stationLiveStatus: pickText(record.liveStatus),
    stopsHere: hasStationStop(record),
  };
}

function trainPosition(status, events, stations, railways, center) {
  const updatedAt = status?.freshness?.observedAt || status?.observedAt || null;
  const directLat = Number(status?.position?.latitude);
  const directLng = Number(status?.position?.longitude);
  if (Number.isFinite(directLat) && Number.isFinite(directLng)
    && distanceKm(center.lat, center.lng, directLat, directLng) <= stationNetworkRadiusKm) {
    return {
      lat: directLat,
      lng: directLng,
      mode: 'live',
      label: 'Live train position reported by provider',
      updatedAt,
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
      updatedAt,
    };
  }

  const now = Date.now();
  const timedEvents = events.map((event) => ({ ...event, time: eventTime(event, now) }))
    .filter((event) => event.time != null
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
    const lat = start.stationLat + (end.stationLat - start.stationLat) * fraction;
    const lng = start.stationLng + (end.stationLng - start.stationLng) * fraction;
    const snapped = nearestRailwayPoint(lat, lng, railways);
    return {
      lat: snapped?.lat ?? lat,
      lng: snapped?.lng ?? lng,
      mode: 'predicted',
      label: snapped
        ? `Estimated on nearby railway between ${start.stationName} and ${end.stationName}`
        : `Estimated between ${start.stationName} and ${end.stationName}; railway geometry unavailable`,
      eventTime: end.expectedArrival || end.expectedDeparture || end.scheduledArrival || end.scheduledDeparture,
      updatedAt,
    };
  }

  const nextEvent = uniqueEvents.find((event) => event.time >= now) || uniqueEvents[0];
  const fallbackEvent = nextEvent || events
    .filter((event) => Number.isFinite(event.stationLat) && Number.isFinite(event.stationLng))
    .sort((first, second) => first.stationDistanceKm - second.stationDistanceKm)[0];
  if (!fallbackEvent) return null;
  const snapped = nearestRailwayPoint(fallbackEvent.stationLat, fallbackEvent.stationLng, railways);
  const point = snapped || { lat: fallbackEvent.stationLat, lng: fallbackEvent.stationLng };
  if (status?.status === 'NOT_STARTED') {
    const time = fallbackEvent.expectedArrival || fallbackEvent.expectedDeparture
      || fallbackEvent.scheduledArrival || fallbackEvent.scheduledDeparture;
    return {
      lat: point.lat,
      lng: point.lng,
      mode: 'scheduled',
      label: `Next scheduled stop: ${fallbackEvent.stationName}${time ? ` · ${time}` : ''}`,
      eventTime: time || null,
      updatedAt,
    };
  }
  return {
    lat: point.lat,
    lng: point.lng,
    mode: 'predicted',
    label: snapped
      ? `Estimated near ${fallbackEvent.stationName} on nearby railway`
      : `Timetable estimate near ${fallbackEvent.stationName}; railway geometry unavailable`,
    eventTime: fallbackEvent.expectedArrival || fallbackEvent.expectedDeparture || fallbackEvent.scheduledArrival || fallbackEvent.scheduledDeparture,
    updatedAt,
  };
}

function positionTrainGroups(trainPositions, trainEvents, statuses, stations, railways, now) {
  const stationByCode = new Map(stations.map((station) => [String(station.code || '').toUpperCase(), station]));
  const groups = new Map();
  const trainSegmentById = new Map();

  for (const train of trainPositions) {
    const relatedEvents = trainEvents.get(train.trainId) || [];
    const status = statuses.get(train.trainId);
    let segment = null;
    const currentCode = String(status?.currentStation?.code || '').toUpperCase();
    const nextCode = String(status?.nextStation?.code || '').toUpperCase();
    if (status?.status === 'RUNNING' && currentCode && nextCode) {
      const start = stationByCode.get(currentCode);
      const end = stationByCode.get(nextCode);
      if (start && end) {
        segment = {
          start,
          end,
          arrivalTime: Date.parse(status.eta?.value || '') || Infinity,
          nextStation: { code: nextCode, name: pickText(status.nextStation.name, end.name) },
        };
      }
    }

    if (!segment) {
      const orderedEvents = relatedEvents
        .map((event) => ({ event, time: stationEventTime(event, now) }))
        .filter(({ time }) => time != null)
        .sort((first, second) => first.time - second.time);
      for (let index = 0; index < orderedEvents.length - 1; index += 1) {
        const startEvent = orderedEvents[index];
        const endEvent = orderedEvents[index + 1];
        if (startEvent.event.stationCode === endEvent.event.stationCode
          || startEvent.time > now
          || endEvent.time <= now) continue;
        const start = stationByCode.get(startEvent.event.stationCode);
        const end = stationByCode.get(endEvent.event.stationCode);
        if (!start || !end) continue;
        segment = {
          start,
          end,
          arrivalTime: endEvent.time,
          nextStation: { code: end.code, name: end.name },
        };
        break;
      }
    }

    if (!segment) continue;
    const key = `${segment.start.code}>${segment.end.code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ train, segment });
    trainSegmentById.set(train.trainId, { key, segment });
  }

  const segments = [];
  for (const [key, entries] of groups) {
    entries.sort((first, second) => first.segment.arrivalTime - second.segment.arrivalTime
      || first.train.trainId.localeCompare(second.train.trainId));
    const first = entries[0].segment.start;
    const last = entries[0].segment.end;
    const firstPoint = nearestRailwayPoint(first.lat, first.lng, railways) || first;
    const lastPoint = nearestRailwayPoint(last.lat, last.lng, railways) || last;
    segments.push({
      id: key,
      from: first.name,
      to: last.name,
      estimated: true,
      coordinates: [[firstPoint.lat, firstPoint.lng], [lastPoint.lat, lastPoint.lng]],
    });

    entries.forEach(({ train, segment }, index) => {
      const fraction = (entries.length - index) / (entries.length + 1);
      const lat = firstPoint.lat + (lastPoint.lat - firstPoint.lat) * fraction;
      const lng = firstPoint.lng + (lastPoint.lng - firstPoint.lng) * fraction;
      const snapped = nearestRailwayPoint(lat, lng, railways);
      train.position = {
        lat: snapped?.lat ?? lat,
        lng: snapped?.lng ?? lng,
        mode: 'predicted',
        label: `Estimated between ${segment.start.name} and ${segment.end.name} · arrival order ${index + 1} of ${entries.length}`,
        updatedAt: train.liveUpdatedAt || null,
        eventTime: Number.isFinite(segment.arrivalTime) ? new Date(segment.arrivalTime).toISOString() : null,
      };
      train.nextStation = segment.nextStation;
      train.segmentOrder = index + 1;
      train.segmentTrainCount = entries.length;
    });
  }

  return segments;
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
    return res.status(400).json({ error: 'Hours must be 2, 4, or 8.' });
  }

  try {
    getApiKey();
    const warnings = [];
    const center = { lat, lng };
    const [network, railwayResult] = await Promise.all([
      findNearbyStations(lat, lng, stationNetworkRadiusKm),
      loadNearbyRailways(lat, lng, stationNetworkRadiusKm)
        .catch((error) => {
          warnings.push(`OpenStreetMap railway geometry unavailable: ${error.message}`);
          return { railways: [], truncated: false };
        }),
    ]);
    const station = network.stations[0];
    if (network.overpassUnavailable) {
      warnings.push('OpenStreetMap station lookup is unavailable; the nearby station list may be incomplete.');
    }
    if (network.fallbackUsed) {
      warnings.push('Using known Varanasi-area station coordinates because OpenStreetMap station lookup failed.');
    }
    if (network.lookupLimited) {
      warnings.push(`Station lookup found ${network.totalStations} nearby stations; timetable coverage is limited to the ${maxTimetableStations} closest coded stations.`);
    }
    if (railwayResult.truncated) {
      warnings.push('OpenStreetMap returned many railway ways; only the first 400 are shown.');
    }

    const boardStations = network.stations.slice(0, maxTimetableStations);
    const boards = await mapInBatches(boardStations, 2, async (boardStation) => {
      try {
        const board = await loadStationBoard(boardStation.code, hours);
        return { station: boardStation, ...board };
      } catch (error) {
        return { station: boardStation, records: [], error };
      }
    });
    const primaryBoard = boards.find((board) => board.station.code === station.code);
    if (!primaryBoard || primaryBoard.error) {
      throw new Error(`${station.name} (${station.code}) live board failed: ${primaryBoard?.error?.message || 'No response from the provider.'}`);
    }
    for (const board of boards) {
      if (board.error) warnings.push(`${board.station.name} (${board.station.code}) live board failed: ${board.error.message}`);
    }

    const stationByCode = new Map(network.mapStations.map((item) => [String(item.code || '').toUpperCase(), item]));
    const events = [];
    const trainEvents = new Map();
    for (const board of boards) {
      if (board.error) continue;
      for (const record of board.records) {
        try {
          if (record.liveStatus === 'departed') continue;
          const normalized = normalizeTrain(record);
          const event = {
            ...normalized,
            stationCode: board.station.code,
            stationName: board.station.name,
            stationLat: board.station.lat,
            stationLng: board.station.lng,
            stationDistanceKm: board.station.distanceKm,
            boardObservedAt: board.observedAt,
          };
          events.push(event);
          if (!trainEvents.has(normalized.trainId)) trainEvents.set(normalized.trainId, []);
          trainEvents.get(normalized.trainId).push(event);
        } catch (error) {
          warnings.push(`${board.station.name} returned an invalid train record: ${error.message}`);
        }
      }
    }

    const trainIds = [...trainEvents.keys()];
    if (trainIds.length > maxStatusLookupsPerRequest) {
      warnings.push(`Live status is checked for up to ${maxStatusLookupsPerRequest} trains per refresh to limit provider requests.`);
    }
    const statuses = new Map();
    const statusTrainIds = trainIds.slice(0, maxStatusLookupsPerRequest);
    for (let index = 0; index < statusTrainIds.length; index += 4) {
      const results = await Promise.all(statusTrainIds.slice(index, index + 4).map(async (trainId) => {
        try {
          return { trainId, status: await loadTrainStatus(trainId) };
        } catch (error) {
          return { trainId, error };
        }
      }));
      let rateLimited = false;
      for (const result of results) {
        if (result.error) {
          warnings.push(`Train ${result.trainId} live status unavailable: ${result.error.message}`);
          rateLimited ||= result.error.statusCode === 429;
        } else {
          statuses.set(result.trainId, result.status);
        }
      }
      if (rateLimited) break;
    }

    for (const event of events) {
      const currentStatus = statuses.get(event.trainId);
      event.trainStatus = currentStatus?.status || null;
      event.nextStation = nextStopForEvent(
        event,
        trainEvents.get(event.trainId) || [],
        currentStatus,
      );
    }

    const now = Date.now();
    const trainPositions = trainIds.map((trainId) => ({
      trainId,
      windowEvent: selectedWindowEvent(
        trainEvents.get(trainId) || [],
        statuses.get(trainId),
        hours,
        now,
      ),
    })).filter(({ windowEvent }) => windowEvent).map(({ trainId, windowEvent }) => {
      const relatedEvents = trainEvents.get(trainId);
      const firstEvent = relatedEvents[0];
      const status = statuses.get(trainId);
      const normalized = normalizeTrain(firstEvent);
      const statusPosition = trainPosition(status, relatedEvents, [...stationByCode.values()], railwayResult.railways, center);
      const currentStatusCode = String(status?.currentStation?.code || '').toUpperCase();
      const nextStopEvent = relatedEvents.find((event) => event.stationCode === currentStatusCode)
        || relatedEvents
          .map((event) => ({ event, time: stationEventTime(event) }))
          .filter(({ time }) => time != null)
          .sort((first, second) => first.time - second.time)[0]?.event
        || firstEvent;
      return {
        ...normalized,
        trainId: normalized.trainId || trainId,
        stationCode: firstEvent.stationCode,
        routeCoordinates: [],
        position: statusPosition ? {
          ...statusPosition,
          eventTime: new Date(windowEvent.time).toISOString(),
        } : null,
        windowEventTime: new Date(windowEvent.time).toISOString(),
        nextStation: nextStopForEvent(nextStopEvent, relatedEvents, status),
        liveStatus: status?.status || firstEvent.stationLiveStatus || 'timetable-estimate',
        liveUpdatedAt: status?.freshness?.observedAt || status?.observedAt || null,
      };
    });
    const trainSegments = positionTrainGroups(
      trainPositions,
      trainEvents,
      statuses,
      [...stationByCode.values()],
      railwayResult.railways,
      Date.now(),
    );

    const stationMarkers = network.mapStations.map((mapStation) => ({
      ...mapStation,
      trainCount: events.filter((event) => event.stationCode === mapStation.code).length,
      boardAvailable: boardStations.some((boardStation) => boardStation.code === mapStation.code),
      trains: events
        .filter((event) => event.stationCode === mapStation.code && event.stopsHere !== false)
        .map((event) => ({
          trainId: event.trainId,
          trainName: event.trainName,
          source: event.source,
          destination: event.destination,
          arrival: {
            actual: event.actualArrival,
            expected: event.expectedArrival,
            scheduled: event.scheduledArrival,
          },
          departure: {
            actual: event.actualDeparture,
            expected: event.expectedDeparture,
            scheduled: event.scheduledDeparture,
          },
          stopsHere: event.stopsHere,
          nextStation: event.nextStation,
        })),
    }));
    return res.json({
      source: 'live',
      station,
      stations: stationMarkers,
      trains: events,
      trainPositions,
      trainSegments,
      timeWindow: {
        start: new Date(now).toISOString(),
        end: new Date(now + hours * 60 * 60 * 1000).toISOString(),
      },
      railways: railwayResult.railways,
      center,
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
