import { useEffect, useRef, useState } from 'react';
import { divIcon } from 'leaflet';
import { CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { LocateFixed, MapPin, Navigation, Radio, RefreshCw, TrainFront, Wifi } from 'lucide-react';

const DEFAULT_CENTER = { lat: 25.2874, lng: 82.9571 };
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const TRAIN_MARKER_ICON = divIcon({
  className: 'train-marker-icon',
  html: '<span class="train-marker-glyph" aria-hidden="true">🚆</span>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

function MapFocus({ center }) {
  const map = useMap();

  useEffect(() => {
    map.flyTo([center.lat, center.lng], Math.max(map.getZoom(), 13), { duration: 0.8 });
  }, [center, map]);

  return null;
}

function App() {
  const [center, setCenter] = useState(DEFAULT_CENTER);
  const [hasLocated, setHasLocated] = useState(false);
  const [station, setStation] = useState(null);
  const [stations, setStations] = useState([]);
  const [trains, setTrains] = useState([]);
  const [trainPositions, setTrainPositions] = useState([]);
  const [timeWindow, setTimeWindow] = useState(null);
  const [railways, setRailways] = useState([]);
  const [trainSegments, setTrainSegments] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [hours, setHours] = useState(2);
  const [selectedTrain, setSelectedTrain] = useState(null);
  const [expandedTrain, setExpandedTrain] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const trainRowRefs = useRef(new Map());
  const loadRequestId = useRef(0);

  useEffect(() => {
    if (!expandedTrain) return;
    requestAnimationFrame(() => {
      trainRowRefs.current.get(expandedTrain)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [expandedTrain]);

  async function loadTrains(nextCenter = center, nextHours = hours) {
    const requestId = ++loadRequestId.current;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ lat: nextCenter.lat, lng: nextCenter.lng, hours: nextHours });
      const response = await fetch(`${API_BASE_URL}/api/trains/nearby?${query}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load nearby trains.');
      if (requestId !== loadRequestId.current) return;
      setTrains(payload.trains);
      setStation(payload.station);
      setStations(payload.stations || []);
      setTrainPositions(payload.trainPositions || []);
      setTimeWindow(payload.timeWindow || null);
      setRailways(payload.railways || []);
      setTrainSegments(payload.trainSegments || []);
      setWarnings(payload.warnings || []);
      setUpdatedAt(new Date(payload.updatedAt));
    } catch (loadError) {
      if (requestId !== loadRequestId.current) return;
      setError(loadError.message);
    } finally {
      if (requestId === loadRequestId.current) setLoading(false);
    }
  }

  useEffect(() => {
    loadTrains(DEFAULT_CENTER, hours);
  }, []);

  function locateMe() {
    if (!navigator.geolocation) {
      setError('Location is not available in this browser.');
      return;
    }
    setLocating(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const nextCenter = { lat: coords.latitude, lng: coords.longitude };
        setCenter(nextCenter);
        setHasLocated(true);
        setSelectedTrain(null);
        setLocating(false);
        loadTrains(nextCenter, hours);
      },
      (locationError) => {
        setError(locationError.code === 1 ? 'Location permission was denied. You can enable it in browser settings.' : 'Could not get your location. Try again in a moment.');
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  }

  function changeHours(value) {
    const nextHours = Number(value);
    setHours(nextHours);
    setTrainPositions([]);
    setTrainSegments([]);
    setTimeWindow(null);
    loadTrains(center, nextHours);
  }

  const now = Date.now();
  const windowEnd = Date.parse(timeWindow?.end || '');
  const visibleTrainPositions = trainPositions.filter((train) => {
    const eventTime = Date.parse(train.windowEventTime || '');
    return Number.isFinite(eventTime) && eventTime >= now && eventTime <= windowEnd;
  });
  const boardStations = stations.filter((nearbyStation) => nearbyStation.boardAvailable);
  const isCompactMap = window.matchMedia('(max-width: 760px)').matches;
  const locationLabel = hasLocated ? `${center.lat.toFixed(3)}°, ${center.lng.toFixed(3)}°` : 'Default view · Bhullanpur';

  function focusTrainInSidebar(trainId, stationCode) {
    const entryId = `${stationCode}-${trainId}`;
    setSelectedTrain(trainId);
    setExpandedTrain(entryId);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Trackside home">
          <span className="brand-mark"><TrainFront size={19} strokeWidth={2.4} /></span>
          <span>trackside<span className="brand-period">.</span></span>
        </a>
        <div className="topbar-center"><span className="live-dot" /> NEARBY NETWORK</div>
        <div className="mode-pill mode-live"><Radio size={14} /> LIVE STATION BOARD</div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="station-board-heading">
            <p className="eyebrow">STATION BOARD</p>
            <h1>{station?.name || 'Nearby trains'}</h1>
            <p className="panel-intro">{station ? `${station.code} · ${station.distanceKm.toFixed(1)} km from you${station.fallback ? ' · local station fallback' : ''}` : 'Arrivals and trains passing this station'}</p>
          </div>

          <div className="board-controls">
            <button className="locate-button" onClick={locateMe} disabled={locating}>
              <LocateFixed size={16} />
              <span>{locating ? 'Finding location…' : 'Use my location'}</span>
              {!locating && <Navigation className="locate-arrow" size={14} />}
            </button>
            <div className="location-line"><MapPin size={14} /><span>{locationLabel}</span></div>
            <div className="time-window">
              <span className="time-window-label">SHOW NEXT</span>
              <div className="range-options" role="group" aria-label="Train time window">
                {[2, 4, 8].map((windowHours) => (
                  <button key={windowHours} className={hoursClass(hours, windowHours)} onClick={() => changeHours(windowHours)}>{windowHours}h</button>
                ))}
              </div>
            </div>
          </div>

          <div className="results-heading">
            <div><p className="eyebrow">NEXT {hours} {hours === 1 ? 'HOUR' : 'HOURS'} · {boardStations.length} STATIONS</p><h2>{loading ? 'Updating board' : `${visibleTrainPositions.length} trains on map`}</h2></div>
            <button className="icon-button" onClick={() => loadTrains(center, hours)} disabled={loading} aria-label="Refresh nearby trains" title="Refresh nearby trains"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
          </div>

          {error && <div className="error-message" role="alert">{error}</div>}
          {warnings.length > 0 && <div className="board-warning" role="status">{warnings.slice(0, 2).join(' ')}</div>}

          <div className="train-list" aria-live="polite">
            {loading && trains.length === 0 && <div className="empty-state">Scanning the tracks<span className="loading-line" /></div>}
            {!loading && !error && trains.length === 0 && <div className="empty-state">No trains expected at this station in the next {hours} {hours === 1 ? 'hour' : 'hours'}.</div>}
            {boardStations.map((boardStation) => {
              const stationTrains = trains.filter((train) => train.stationCode === boardStation.code);
              return (
                <section className="station-timetable" key={boardStation.code}>
                  <div className="station-timetable-heading">
                    <div><strong>{boardStation.name}</strong><span>{boardStation.code} · {boardStation.distanceKm.toFixed(1)} km</span></div>
                    <small>{stationTrains.length} {stationTrains.length === 1 ? 'train' : 'trains'}</small>
                  </div>
                  {stationTrains.length === 0 && <p className="station-no-trains">No trains in this time window.</p>}
                  {stationTrains.map((train) => {
                    const trainPosition = visibleTrainPositions.find((candidate) => candidate.trainId === train.trainId);
                    const position = trainPosition?.position;
                    const entryId = `${train.stationCode}-${train.trainId}`;
                    const isExpanded = expandedTrain === entryId;
                    return (
                      <div
                        key={entryId}
                        className="train-entry"
                        ref={(element) => {
                          if (element) trainRowRefs.current.set(entryId, element);
                          else trainRowRefs.current.delete(entryId);
                        }}
                      >
                        <button
                          className={`timetable-row ${selectedTrain === train.trainId ? 'timetable-row-selected' : ''}`}
                          aria-expanded={isExpanded}
                          onClick={() => {
                            setSelectedTrain(train.trainId);
                            setExpandedTrain(isExpanded ? null : entryId);
                          }}
                        >
                          <span className="timetable-copy">
                            <span className="timetable-destination">{train.destination || train.source || 'Station service'}</span>
                            <span className="timetable-train-name"><TrainFront size={14} /><strong>{train.trainId}</strong><span> - </span>{train.trainName}</span>
                            <span className="timetable-details">
                              <span className={`stop-badge ${train.stopsHere == null ? 'stop-badge-unknown' : train.stopsHere ? 'stop-badge-stop' : 'stop-badge-pass'}`}>{train.stopsHere == null ? 'UNKNOWN' : train.stopsHere ? 'STOP' : 'PASS'}</span>
                              <span>Platform {train.platform || '—'}</span>
                              {train.delayMinutes != null && <span className={train.delayMinutes > 0 ? 'delay-late' : 'delay-ontime'}>{train.delayMinutes > 0 ? `${train.delayMinutes} min late` : train.delayMinutes < 0 ? `${Math.abs(train.delayMinutes)} min early` : 'On time'}</span>}
                              {train.trainStatus && <span>{train.trainStatus}</span>}
                              {position && <span className={position.mode === 'live' ? 'position-live' : position.mode === 'reported' ? 'position-reported' : 'position-predicted'}>{position.mode === 'live' ? 'LIVE' : position.mode === 'reported' ? 'REPORTED' : position.mode === 'scheduled' ? 'SCHEDULED' : 'EST'}</span>}
                            </span>
                          </span>
                          <span className="timetable-times">
                            <strong>{formatBoardTime(train.scheduledArrival || train.scheduledDeparture)}</strong>
                            <span className={train.delayMinutes > 0 ? 'delay-late' : 'delay-ontime'}>{formatBoardTime(train.actualArrival || train.expectedArrival || train.actualDeparture || train.expectedDeparture) || (train.delayMinutes === 0 ? 'On time' : '—')}</span>
                            <small>{train.expectedArrival || train.expectedDeparture ? 'EXPECTED' : train.scheduledArrival || train.actualArrival ? 'ARRIVAL' : 'DEPARTURE'}</small>
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="train-detail-dropdown">
                            <span><strong>Route</strong>{train.source || 'Unknown origin'} → {train.destination || 'Unknown destination'}</span>
                            <span><strong>Next stop</strong>{train.nextStation?.name || 'Not available'}</span>
                            <span><strong>ETA</strong>{formatBoardTime(trainPosition?.windowEventTime || train.nextStation?.time || position?.eventTime) || 'Not available'}</span>
                            <span><strong>At {train.stationName}</strong>{formatBoardTime(train.actualArrival || train.expectedArrival || train.scheduledArrival || train.actualDeparture || train.expectedDeparture || train.scheduledDeparture) || 'Time unavailable'}</span>
                            <span><strong>Platform / delay</strong>{train.platform || '—'} · {train.delayMinutes == null ? 'Delay unavailable' : train.delayMinutes > 0 ? `${train.delayMinutes} min late` : train.delayMinutes < 0 ? `${Math.abs(train.delayMinutes)} min early` : 'On time'}</span>
                            {trainPosition && <span><strong>Position</strong>{trainPosition.position?.label || trainPosition.liveStatus}</span>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>

          <footer className="sidebar-footer">
            <span className="connection"><Wifi size={14} /> {loading ? 'UPDATING' : 'SYSTEM READY'}</span>
            <span>{updatedAt ? `UPDATED ${updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'WAITING FOR DATA'}</span>
          </footer>
        </aside>

        <div className="map-area">
          <MapContainer
            center={[DEFAULT_CENTER.lat, DEFAULT_CENTER.lng]}
            zoom={13}
            zoomControl={false}
            className="map"
          >
            <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapFocus center={station || center} />
            <CircleMarker center={[center.lat, center.lng]} radius={8} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#316d5a', fillOpacity: 1 }}>
              <Popup>{hasLocated ? 'Your location' : 'Default map location'}</Popup>
            </CircleMarker>
            {railways.map((railway) => (
              <Polyline
                key={`railway-${railway.id}`}
                positions={railway.coordinates}
                pathOptions={{ color: '#577d91', weight: 2, opacity: 0.48 }}
              />
            ))}
            {trainSegments.map((segment) => (
              <Polyline
                key={`train-segment-${segment.id}`}
                positions={segment.coordinates}
                pathOptions={{
                  color: '#89958e',
                  weight: 3,
                  opacity: 0.62,
                  dashArray: segment.estimated ? '5 7' : undefined,
                }}
              />
            ))}
            {stations.filter((nearbyStation) => Number.isFinite(nearbyStation.lat) && Number.isFinite(nearbyStation.lng)).map((nearbyStation) => {
              const tooltipId = nearbyStation.code || `${nearbyStation.name}-${nearbyStation.lat}-${nearbyStation.lng}`;
              const estimatedPopupHeight = 99 + (nearbyStation.trains?.length || 0) * 55;
              const popupOffset = isCompactMap ? 0 : Math.min(270, estimatedPopupHeight);
              return (
                <CircleMarker
                  key={`station-${tooltipId}`}
                  center={[nearbyStation.lat, nearbyStation.lng]}
                  pane="tooltipPane"
                  radius={nearbyStation.code === station?.code ? 10 : 8}
                  pathOptions={{ color: '#ffffff', weight: 2, fillColor: nearbyStation.code === station?.code ? '#db513d' : '#547a8c', fillOpacity: 0.95 }}
                  eventHandlers={{ mouseover: (event) => event.target.openPopup() }}
                >
                  <Popup offset={[0, popupOffset]} closeButton={false} className="station-map-tooltip">
                    <div className="station-tooltip-content">
                      <span className="station-tooltip-heading">{nearbyStation.name} · {nearbyStation.code || 'Station'}</span>
                      <span className="station-tooltip-caption">Trains listed at this station</span>
                      {nearbyStation.trains?.length
                        ? nearbyStation.trains.map((train) => (
                          <span className="station-tooltip-train" key={`${nearbyStation.code}-${train.trainId}`}>
                            <strong>#{train.trainId} · {train.trainName}</strong>
                            <span>Arrival: {formatStationTime(train.arrival)}</span>
                            <span>Departure: {formatStationTime(train.departure)}</span>
                            <span>Next stop: {train.nextStation?.name || 'Not available'}</span>
                            {train.stopsHere == null && <small>Stop status not provided</small>}
                          </span>
                        ))
                        : <span className="station-tooltip-empty">No train board entries in this time window.</span>}
                      <span className="station-tooltip-caption">{nearbyStation.distanceKm.toFixed(1)} km away · {nearbyStation.trainCount || 0} timetable entries</span>
                    </div>
                  </Popup>
                </CircleMarker>
              );
            })}
            {visibleTrainPositions.filter((train) => (
              train.position
              && Number.isFinite(train.position.lat)
              && Number.isFinite(train.position.lng)
            )).map((train) => (
              <Marker
                key={`train-${train.trainId}`}
                position={[train.position.lat, train.position.lng]}
                icon={TRAIN_MARKER_ICON}
                title={`Train ${train.trainId} ${train.trainName}`}
                eventHandlers={{ click: () => focusTrainInSidebar(train.trainId, train.stationCode) }}
              >
                <Tooltip direction="top" offset={[0, -7]} opacity={0.96} className="train-map-tooltip">
                  <span className="train-tooltip-heading">#{train.trainId} · {train.trainName}</span>
                  <span className="train-tooltip-route">{train.source || 'Unknown origin'} → {train.destination || 'Unknown destination'}</span>
                  <span className="train-tooltip-next">Next stop: {train.nextStation?.name || 'Not available'}</span>
                  <span className="train-tooltip-next">ETA: {formatBoardTime(train.windowEventTime || train.nextStation?.time || train.position.eventTime) || 'Not available'}</span>
                  {train.segmentOrder && <span className="train-tooltip-next">Arrival order: {train.segmentOrder} of {train.segmentTrainCount}</span>}
                  <span className="train-tooltip-estimate">{train.position.mode === 'live' ? 'Live provider position' : train.position.mode === 'reported' ? 'Last reported station' : train.position.mode === 'scheduled' ? 'Scheduled stop · not current position' : 'Estimated position'}</span>
                </Tooltip>
              </Marker>
            ))}
          </MapContainer>
          <div className="map-caption"><span className="map-caption-dot" /> {station ? `${station.name} · ${station.code} · ${stations.length} stations` : 'FINDING NEAREST STATION'}</div>
          <div className="map-legend"><span><i className="legend-station" /> Stations</span><span><i className="legend-estimated" /> Train estimate</span><span><i className="legend-track" /> Train track</span></div>
          <div className="map-attribution"><span>MAP DATA</span> OPENSTREETMAP · RAILWAY API</div>
        </div>
      </section>
    </main>
  );
}

function hoursClass(current, value) {
  return `range-option ${current === value ? 'range-option-active' : ''}`;
}

function formatBoardTime(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const time = value.trim();
  if (/[T-]/.test(time) && Number.isFinite(Date.parse(time))) {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(new Date(time));
  }
  const match = time.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return time;
  const hour = Number(match[1]);
  const period = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${match[2]} ${period}`;
}

function formatStationTime(times) {
  if (!times || typeof times !== 'object') return 'Not available';
  const values = [
    ['Actual', times.actual],
    ['Expected', times.expected],
    ['Scheduled', times.scheduled],
  ].filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label, value]) => `${label} ${formatBoardTime(value)}`);
  return values.length ? values.join(' · ') : 'Not available';
}

export default App;