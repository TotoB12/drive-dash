(() => {
    'use strict';

    const DEFAULT_CENTER = [2.3522, 48.8566]; // Paris, used until GPS is available.
    const DEFAULT_ZOOM = 12;
    const FOLLOW_ZOOM = 17;
    const API_INTERVAL_MS = 6000;
    const API_TIMEOUT_MS = 7000;
    const MAX_POSITIONS = 6;
    const METERS_PER_SECOND_TO_MPH = 2.23694;
    const KPH_TO_MPH = 0.621371;
    const AVAILABLE_SPEED_LIMIT_SIGNS = new Set([
        0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 40, 45,
        50, 55, 60, 65, 70, 75, 80
    ]);

    const elements = {
        map: document.getElementById('map'),
        speedValue: document.getElementById('speedValue'),
        speedLimitSign: document.getElementById('speedLimitSign'),
        roadDisplay: document.getElementById('roadDisplay'),
        recenterButton: document.getElementById('recenterButton'),
        statusBanner: document.getElementById('statusBanner')
    };

    let map = null;
    let userMarker = null;
    let userPosition = null;
    let isFollowing = true;
    let latestRoadLabel = '';
    let latestSpeedLimitMph = null;
    let currentSpeedLimitMph = null;
    let apiTimer = null;
    let statusHideTimer = null;
    let apiCallInFlight = false;
    const lastPositions = [];

    function supportsWebGL() {
        try {
            const canvas = document.createElement('canvas');
            return Boolean(
                window.WebGLRenderingContext &&
                (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
            );
        } catch (_) {
            return false;
        }
    }

    function setStatus(message, variant = 'info') {
        if (statusHideTimer) {
            window.clearTimeout(statusHideTimer);
            statusHideTimer = null;
        }
        elements.statusBanner.textContent = message;
        elements.statusBanner.dataset.variant = variant;
        elements.statusBanner.classList.remove('hidden');
    }

    function hideStatusSoon(delay = 2500) {
        if (statusHideTimer) {
            window.clearTimeout(statusHideTimer);
        }
        statusHideTimer = window.setTimeout(() => {
            elements.statusBanner.classList.add('hidden');
            statusHideTimer = null;
        }, delay);
    }

    function createFallbackMap(message) {
        elements.map.classList.add('map-fallback');
        elements.map.innerHTML = `
            <div class="fallback-card">
                <strong>Map preview unavailable</strong>
                <span>${message}</span>
            </div>
        `;
        setStatus(message, 'warning');
    }

    function initMap() {
        if (!window.maplibregl) {
            createFallbackMap('Map library did not load. Check your connection and refresh.');
            return;
        }

        if (!supportsWebGL()) {
            createFallbackMap('WebGL is disabled in this browser, so the map cannot render here. GPS and speed still work.');
            return;
        }

        try {
            map = new maplibregl.Map({
                container: elements.map,
                style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
                center: DEFAULT_CENTER,
                zoom: DEFAULT_ZOOM,
                pitch: 45,
                attributionControl: false
            });

            map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
            map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

            map.on('load', () => {
                setStatus('Waiting for GPS permission…');
            });

            map.on('dragstart', () => {
                isFollowing = false;
                updateRecenterButton();
            });

            map.on('error', event => {
                const message = event?.error?.message || 'Map error';
                console.warn('MapLibre error:', message);
                setStatus('Map data is having trouble loading. Retrying…', 'warning');
            });
        } catch (error) {
            console.error('Map initialization failed:', error);
            createFallbackMap('Map initialization failed. GPS and speed still work.');
        }
    }

    function createUserMarker() {
        const markerElement = document.createElement('div');
        markerElement.className = 'car-marker';
        markerElement.setAttribute('aria-label', 'Current position');
        markerElement.innerHTML = `
            <svg viewBox="0 0 48 48" role="img" aria-hidden="true">
                <path d="M24 3 40 42 24 34 8 42 24 3Z" />
            </svg>
        `;
        return new maplibregl.Marker({ element: markerElement, rotationAlignment: 'map' });
    }

    function updateRecenterButton() {
        elements.recenterButton.disabled = !userPosition;
        elements.recenterButton.classList.toggle('invisible', isFollowing && Boolean(userPosition));
    }

    function recenterOnUser({ animate = true } = {}) {
        if (!userPosition) {
            setStatus('Waiting for a GPS fix before recentering…', 'warning');
            return;
        }

        isFollowing = true;
        updateRecenterButton();

        if (!map) {
            setStatus('GPS acquired. Map is unavailable in this browser.', 'warning');
            return;
        }

        const bearing = computeSmoothedBearing();
        const camera = {
            center: [userPosition.longitude, userPosition.latitude],
            zoom: FOLLOW_ZOOM,
            pitch: 60,
            bearing,
            duration: animate ? 650 : 0
        };

        if (animate) {
            map.easeTo(camera);
        } else {
            map.jumpTo(camera);
        }
    }

    function addPositionToHistory(latitude, longitude, timestamp) {
        lastPositions.push({ latitude, longitude, timestamp });
        if (lastPositions.length > MAX_POSITIONS) {
            lastPositions.shift();
        }
    }

    function computeSmoothedBearing() {
        if (lastPositions.length < 2) {
            return map?.getBearing?.() || 0;
        }

        const first = lastPositions[0];
        const last = lastPositions[lastPositions.length - 1];
        return computeBearing(first.latitude, first.longitude, last.latitude, last.longitude);
    }

    function computeBearing(lat1, lon1, lat2, lon2) {
        const toRad = degrees => degrees * Math.PI / 180;
        const toDeg = radians => radians * 180 / Math.PI;
        const phi1 = toRad(lat1);
        const phi2 = toRad(lat2);
        const deltaLambda = toRad(lon2 - lon1);
        const y = Math.sin(deltaLambda) * Math.cos(phi2);
        const x = Math.cos(phi1) * Math.sin(phi2) -
            Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
    }

    function computeDistanceMeters(lat1, lon1, lat2, lon2) {
        const earthRadiusMeters = 6371e3;
        const toRad = degrees => degrees * Math.PI / 180;
        const phi1 = toRad(lat1);
        const phi2 = toRad(lat2);
        const deltaPhi = toRad(lat2 - lat1);
        const deltaLambda = toRad(lon2 - lon1);
        const a = Math.sin(deltaPhi / 2) ** 2 +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
        return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function deriveSpeedMph(position) {
        const gpsSpeed = position.coords.speed;
        if (Number.isFinite(gpsSpeed) && gpsSpeed >= 0) {
            return gpsSpeed * METERS_PER_SECOND_TO_MPH;
        }

        if (lastPositions.length < 2) {
            return 0;
        }

        const previous = lastPositions[lastPositions.length - 2];
        const current = lastPositions[lastPositions.length - 1];
        const elapsedSeconds = (current.timestamp - previous.timestamp) / 1000;
        if (elapsedSeconds <= 0) {
            return 0;
        }

        const distanceMeters = computeDistanceMeters(
            previous.latitude,
            previous.longitude,
            current.latitude,
            current.longitude
        );
        return distanceMeters / elapsedSeconds * METERS_PER_SECOND_TO_MPH;
    }

    function updateSpeedDisplay(position) {
        const speedMph = deriveSpeedMph(position);
        const rounded = speedMph < 0.5 ? 0 : Math.min(Math.round(speedMph), 199);
        elements.speedValue.textContent = String(rounded);
    }

    function updateUserPosition(position) {
        const { latitude, longitude } = position.coords;
        const timestamp = position.timestamp || Date.now();

        userPosition = { latitude, longitude };
        addPositionToHistory(latitude, longitude, timestamp);
        updateSpeedDisplay(position);
        updateRecenterButton();

        if (map && window.maplibregl) {
            if (!userMarker) {
                userMarker = createUserMarker().setLngLat([longitude, latitude]).addTo(map);
            } else {
                userMarker.setLngLat([longitude, latitude]);
            }
            userMarker.setRotation(computeSmoothedBearing());
        }

        if (isFollowing) {
            recenterOnUser({ animate: lastPositions.length > 1 });
        }

        if (lastPositions.length === 1) {
            setStatus('GPS acquired. Drive safely.', 'success');
            hideStatusSoon();
            performApiCalls();
        }
    }

    function handleGeolocationError(error) {
        console.warn('Geolocation error:', error);
        elements.speedValue.textContent = '--';
        updateRecenterButton();

        const messages = {
            1: 'Location permission was denied. Enable it to follow your drive.',
            2: 'Location is temporarily unavailable. Retrying…',
            3: 'Timed out while getting location. Retrying…'
        };
        setStatus(messages[error.code] || 'Unable to read location. Retrying…', 'warning');
    }

    function startTrackingUserPosition() {
        if (!('geolocation' in navigator)) {
            setStatus('This browser does not support geolocation.', 'warning');
            return;
        }

        setStatus('Waiting for GPS permission…');
        navigator.geolocation.watchPosition(
            updateUserPosition,
            handleGeolocationError,
            {
                enableHighAccuracy: true,
                maximumAge: 1000,
                timeout: 10000
            }
        );
    }

    function buildRoadLabel(address = {}) {
        return address.road || address.pedestrian || address.footway ||
            address.cycleway || address.path || address.neighbourhood || '';
    }

    function parseMaxSpeedToMph(value) {
        if (value === null || value === undefined) {
            return null;
        }

        const normalized = String(value).toLowerCase().trim();
        if (!normalized || /(none|signals|walk|variable|implicit)/.test(normalized)) {
            return null;
        }

        const match = normalized.match(/\d+(?:\.\d+)?/);
        if (!match) {
            return null;
        }

        const numeric = Number(match[0]);
        if (!Number.isFinite(numeric) || numeric <= 0) {
            return null;
        }

        // OSM maxspeed values are km/h unless explicitly marked as mph.
        const mph = normalized.includes('mph') ? numeric : numeric * KPH_TO_MPH;
        return Math.round(mph);
    }

    function nearestAvailableSpeedSign(speedMph) {
        if (speedMph === null) {
            return null;
        }

        let best = null;
        let bestDelta = Infinity;
        for (const candidate of AVAILABLE_SPEED_LIMIT_SIGNS) {
            const delta = Math.abs(candidate - speedMph);
            if (delta < bestDelta) {
                best = candidate;
                bestDelta = delta;
            }
        }
        return best;
    }

    function updateRoadDisplay() {
        if (latestRoadLabel) {
            elements.roadDisplay.textContent = latestRoadLabel;
            elements.roadDisplay.classList.remove('hidden');
        } else {
            elements.roadDisplay.textContent = '';
            elements.roadDisplay.classList.add('hidden');
        }
    }

    function updateSpeedLimitDisplay() {
        if (latestSpeedLimitMph === currentSpeedLimitMph) {
            return;
        }

        currentSpeedLimitMph = latestSpeedLimitMph;
        const signValue = nearestAvailableSpeedSign(latestSpeedLimitMph);

        if (signValue === null) {
            elements.speedLimitSign.alt = 'Speed limit unknown';
            elements.speedLimitSign.src = 'images/speed-limit/us/blank.svg';
            elements.speedLimitSign.classList.add('hidden');
            return;
        }

        elements.speedLimitSign.alt = `Speed limit ${latestSpeedLimitMph} mph`;
        elements.speedLimitSign.title = `Speed limit ${latestSpeedLimitMph} mph`;
        elements.speedLimitSign.src = `images/speed-limit/us/${signValue}.svg`;
        elements.speedLimitSign.classList.remove('hidden');
    }

    async function fetchJsonWithTimeout(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);

        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            return await response.json();
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    async function fetchLocationData(latitude, longitude) {
        const params = new URLSearchParams({
            format: 'jsonv2',
            lat: latitude,
            lon: longitude,
            zoom: '18',
            addressdetails: '1',
            extratags: '1'
        });
        return fetchJsonWithTimeout(`https://nominatim.openstreetmap.org/reverse?${params}`);
    }

    async function fetchNearbyWayData(latitude, longitude, osmId, osmType) {
        const selectors = [];

        if (String(osmType).toLowerCase() === 'way' && osmId) {
            selectors.push(`way(${osmId});`);
        }

        selectors.push(`way(around:35,${latitude},${longitude})["highway"]["maxspeed"];`);

        const data = `[out:json][timeout:6];(${selectors.join('')});out tags center 1;`;
        const params = new URLSearchParams({ data });
        return fetchJsonWithTimeout(`https://overpass.private.coffee/api/interpreter?${params}`);
    }

    async function performApiCalls() {
        if (!userPosition || apiCallInFlight) {
            return;
        }

        apiCallInFlight = true;
        const { latitude, longitude } = userPosition;

        try {
            const locationData = await fetchLocationData(latitude, longitude);
            latestRoadLabel = buildRoadLabel(locationData?.address);

            const directSpeedLimit = parseMaxSpeedToMph(locationData?.extratags?.maxspeed);
            if (directSpeedLimit !== null) {
                latestSpeedLimitMph = directSpeedLimit;
            } else {
                const wayData = await fetchNearbyWayData(
                    latitude,
                    longitude,
                    locationData?.osm_id,
                    locationData?.osm_type
                );
                const wayWithSpeed = wayData?.elements?.find(element => element.tags?.maxspeed);
                latestSpeedLimitMph = parseMaxSpeedToMph(wayWithSpeed?.tags?.maxspeed);
            }

            updateRoadDisplay();
            updateSpeedLimitDisplay();
        } catch (error) {
            console.warn('Road/speed-limit lookup failed:', error);
            setStatus('Road data is temporarily unavailable.', 'warning');
            hideStatusSoon(3500);
        } finally {
            apiCallInFlight = false;
        }
    }

    function startRoadPolling() {
        if (apiTimer) {
            window.clearInterval(apiTimer);
        }
        apiTimer = window.setInterval(performApiCalls, API_INTERVAL_MS);
    }

    elements.recenterButton.addEventListener('click', () => recenterOnUser());

    initMap();
    startTrackingUserPosition();
    startRoadPolling();

    // Tiny debug/test surface for local QA without exposing implementation globally.
    window.driveDash = {
        getState: () => ({
            hasMap: Boolean(map),
            hasUserPosition: Boolean(userPosition),
            isFollowing,
            latestRoadLabel,
            latestSpeedLimitMph,
            currentSpeedLimitMph
        }),
        parseMaxSpeedToMph
    };
})();
