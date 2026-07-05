(() => {
    'use strict';

    const MAPBOX_ACCESS_TOKEN = 'pk.eyJ1IjoidG90b2IxMjE3IiwiYSI6ImNsbXo4NHdocjA4dnEya215cjY0aWJ1cGkifQ.OMzA6Q8VnHLHZP-P8ACBRw';
    const MAPBOX_STYLE = 'mapbox://styles/totob1217/cm3f0b1qp000v01rv4evcaegr';
    const MINI_MODEL_URL = new URL('/models/mini.glb', window.location.href).href;
    const DEFAULT_CENTER = [2.3522, 48.8566]; // Paris, used until GPS is available.
    const DEFAULT_ZOOM = 12;
    const FOLLOW_ZOOM = 17;
    const API_INTERVAL_MS = 6000;
    const API_TIMEOUT_MS = 7000;
    const GPS_PROMPT_HIDE_MS = 8000;
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
    let tb = null;
    let userCar = null;
    let userPosition = null;
    let isFollowing = false;
    let miniCooperLoadState = 'idle';
    let latestRoadLabel = '';
    let latestSpeedLimitMph = null;
    let currentSpeedLimitMph = null;
    let apiTimer = null;
    let statusHideTimer = null;
    let geoWatchId = null;
    let initialLocationRequestInFlight = false;
    let locationPermissionState = 'unknown';
    let apiCallInFlight = false;
    const lastPositions = [];

    function supportsWebGL() {
        try {
            if (window.mapboxgl?.supported) {
                return window.mapboxgl.supported({ failIfMajorPerformanceCaveat: false });
            }
            const canvas = document.createElement('canvas');
            return Boolean(
                window.WebGLRenderingContext &&
                (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
            );
        } catch (_) {
            return false;
        }
    }

    function setStatus(message, variant = 'info', options = {}) {
        const { autoHideMs = null } = options;

        if (statusHideTimer) {
            window.clearTimeout(statusHideTimer);
            statusHideTimer = null;
        }

        elements.statusBanner.classList.remove('auto-hide');
        elements.statusBanner.style?.removeProperty?.('--status-auto-hide-ms');

        if (!message) {
            elements.statusBanner.textContent = '';
            elements.statusBanner.classList.add('hidden');
            return;
        }

        elements.statusBanner.textContent = message;
        elements.statusBanner.dataset.variant = variant;
        elements.statusBanner.classList.remove('hidden');

        if (autoHideMs) {
            elements.statusBanner.style?.setProperty?.('--status-auto-hide-ms', `${autoHideMs}ms`);
            // Restart the CSS animation even when the same message is shown twice.
            void elements.statusBanner.offsetWidth;
            elements.statusBanner.classList.add('auto-hide');
            statusHideTimer = window.setTimeout(() => {
                elements.statusBanner.classList.add('hidden');
                elements.statusBanner.classList.remove('auto-hide');
                statusHideTimer = null;
            }, autoHideMs);
        }
    }

    function hideStatusSoon(delay = 2500) {
        setStatus(elements.statusBanner.textContent, elements.statusBanner.dataset.variant || 'info', {
            autoHideMs: delay
        });
    }

    function createFallbackMap(message) {
        elements.map.classList.add('map-fallback');
        elements.map.innerHTML = `
            <div class="fallback-card">
                <strong>Map preview unavailable</strong>
                <span>${message}</span>
            </div>
        `;
        setStatus(message, 'warning', { autoHideMs: 9000 });
    }

    function initMap() {
        if (!window.mapboxgl) {
            createFallbackMap('Mapbox did not load. Check your connection and refresh.');
            return;
        }

        window.mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

        if (!supportsWebGL()) {
            createFallbackMap('WebGL is disabled in this browser, so the map cannot render here. GPS and speed still work.');
            return;
        }

        try {
            map = new mapboxgl.Map({
                container: elements.map,
                style: MAPBOX_STYLE,
                center: DEFAULT_CENTER,
                zoom: DEFAULT_ZOOM,
                pitch: 60,
                bearing: 0,
                antialias: true,
                attributionControl: false,
                cooperativeGestures: false,
                dragPan: true,
                scrollZoom: true,
                boxZoom: true,
                dragRotate: true,
                keyboard: true,
                doubleClickZoom: true,
                touchZoomRotate: true,
                touchPitch: true
            });

            enableMapInteractions();
            map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'bottom-right');
            map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-left');

            map.once('load', () => {
                addMiniCooperLayer();
            });
            map.once('idle', () => {
                addMiniCooperLayer();
            });

            map.on('style.load', () => {
                window.setTimeout(addMiniCooperLayer, 0);
            });

            ['dragstart', 'drag', 'zoomstart', 'rotatestart', 'pitchstart', 'boxzoomstart'].forEach(eventName => {
                map.on(eventName, pauseFollowingForManualMapMove);
            });
            map.on('movestart', pauseFollowingForManualMapMove);

            map.on('error', event => {
                const message = event?.error?.message || 'Map error';
                console.warn('Mapbox error:', message);
                setStatus('Map data is having trouble loading. Retrying…', 'warning', {
                    autoHideMs: 4500
                });
            });
        } catch (error) {
            console.error('Map initialization failed:', error);
            createFallbackMap('Map initialization failed. GPS and speed still work.');
        }
    }

    const miniCooperLayer = {
        id: '3d-car-layer',
        type: 'custom',
        renderingMode: '3d',

        onAdd(mapInstance, gl) {
            if (!window.Threebox) {
                console.warn('Threebox is not available; the Mini Cooper model cannot render.');
                setStatus('The Mini Cooper model could not load.', 'warning', {
                    autoHideMs: 5000
                });
                return;
            }

            miniCooperLoadState = 'loading';
            tb = new window.Threebox(mapInstance, gl, { defaultLights: true });
            window.tb = tb;
            tb.loadObj(
                {
                    obj: MINI_MODEL_URL,
                    type: 'gltf',
                    scale: 7,
                    units: 'meters',
                    rotation: { x: 90, y: 0, z: 0 }
                },
                model => {
                    userCar = model;
                    miniCooperLoadState = 'ready';
                    const coords = userPosition
                        ? [userPosition.longitude, userPosition.latitude]
                        : DEFAULT_CENTER;
                    userCar.setCoords(coords);
                    userCar.setRotation({ z: computeSmoothedBearing() });
                    tb.add(userCar);
                    mapInstance.triggerRepaint?.();
                }
            );
        },

        render() {
            if (tb) {
                tb.update();
            }
        }
    };

    function addMiniCooperLayer() {
        if (!map || !map.isStyleLoaded?.() || map.getLayer(miniCooperLayer.id)) {
            return;
        }

        try {
            map.addLayer(miniCooperLayer);
            miniCooperLoadState = 'layer-added';
        } catch (error) {
            console.warn('Mini Cooper layer could not be added:', error);
            miniCooperLoadState = 'failed';
            setStatus('The Mini Cooper model could not load.', 'warning', {
                autoHideMs: 5000
            });
        }
    }

    function enableMapInteractions() {
        if (!map) {
            return;
        }

        [
            'dragPan',
            'scrollZoom',
            'boxZoom',
            'dragRotate',
            'keyboard',
            'doubleClickZoom',
            'touchZoomRotate',
            'touchPitch'
        ].forEach(controlName => {
            map[controlName]?.enable?.();
        });
    }

    function pauseFollowingForManualMapMove(event) {
        const isManualMove = Boolean(event?.originalEvent) || event?.type === 'drag';
        if (!isManualMove || !isFollowing) {
            return;
        }

        isFollowing = false;
        updateRecenterButton();
    }

    function updateRecenterButton() {
        const hasPosition = Boolean(userPosition);
        elements.recenterButton.disabled = !hasPosition;
        elements.recenterButton.classList.toggle('invisible', !hasPosition || isFollowing);
        elements.recenterButton.title = hasPosition
            ? 'Recenter on your current location'
            : 'Waiting for GPS before recentering';
    }

    function recenterOnUser({ animate = true } = {}) {
        if (!userPosition) {
            setStatus('Waiting for a GPS fix before recentering…', 'warning', { autoHideMs: 4500 });
            return;
        }

        isFollowing = true;
        updateRecenterButton();

        if (!map) {
            setStatus('GPS acquired. Map is unavailable in this browser.', 'warning', {
                autoHideMs: 5000
            });
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

        const moveToUser = map.flyTo || map.easeTo || map.jumpTo;
        moveToUser.call(map, camera);
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

    function updateVehiclePosition() {
        if (!userPosition) {
            return;
        }

        const coords = [userPosition.longitude, userPosition.latitude];
        const bearing = computeSmoothedBearing();

        if (userCar) {
            userCar.setCoords(coords);
            userCar.setRotation({ z: bearing });
            return;
        }

        // Do not create the old 2D marker fallback. If the Mini is still loading,
        // keep the map clean until the 3D model is ready.
        addMiniCooperLayer();
    }

    function updateUserPosition(position) {
        const { latitude, longitude } = position.coords;
        const timestamp = position.timestamp || Date.now();

        userPosition = { latitude, longitude };
        addPositionToHistory(latitude, longitude, timestamp);
        updateSpeedDisplay(position);
        updateRecenterButton();
        updateVehiclePosition();

        if (isFollowing) {
            recenterOnUser({ animate: lastPositions.length > 1 });
        }

        if (lastPositions.length === 1) {
            setStatus('GPS acquired. Drive safely.', 'success', { autoHideMs: 2200 });
            performApiCalls();
        }
    }

    function handleGeolocationError(error) {
        console.warn('Geolocation error:', error);
        elements.speedValue.textContent = '--';
        updateRecenterButton();

        const messages = {
            1: 'Location permission is blocked. Enable it in your browser to follow your drive.',
            2: 'Location is temporarily unavailable. I’ll keep retrying in the background.',
            3: 'Still waiting for GPS. If your browser asks, allow location access.'
        };
        setStatus(messages[error.code] || 'Unable to read location. I’ll keep retrying.', 'warning', {
            autoHideMs: error.code === 1 ? 9000 : 6500
        });
    }

    function hasGeolocationSupport() {
        return 'geolocation' in navigator;
    }

    function getGeoOptions() {
        return {
            enableHighAccuracy: true,
            maximumAge: 1000,
            timeout: 12000
        };
    }

    function startPositionWatch() {
        if (!hasGeolocationSupport() || geoWatchId !== null) {
            return;
        }

        geoWatchId = navigator.geolocation.watchPosition(
            updateUserPosition,
            handleGeolocationError,
            getGeoOptions()
        );
    }

    function handleInitialLocationSuccess(position) {
        initialLocationRequestInFlight = false;
        locationPermissionState = 'granted';
        updateUserPosition(position);
        startPositionWatch();
    }

    function handleInitialLocationError(error) {
        initialLocationRequestInFlight = false;
        if (error.code === 1) {
            locationPermissionState = 'denied';
        }
        handleGeolocationError(error);
    }

    function requestInitialLocation() {
        if (!hasGeolocationSupport() || initialLocationRequestInFlight) {
            return;
        }

        initialLocationRequestInFlight = true;
        setStatus('Requesting location permission…', 'info', { autoHideMs: GPS_PROMPT_HIDE_MS });

        // Match the original app behavior: request location immediately on page load
        // so the browser permission dialog appears without requiring an in-page button.
        navigator.geolocation.getCurrentPosition(
            handleInitialLocationSuccess,
            handleInitialLocationError,
            getGeoOptions()
        );
    }

    async function initializeLocationFlow() {
        if (!hasGeolocationSupport()) {
            setStatus('This browser does not support geolocation.', 'warning', { autoHideMs: 9000 });
            return;
        }

        try {
            if (navigator.permissions?.query) {
                const permission = await navigator.permissions.query({ name: 'geolocation' });
                locationPermissionState = permission.state;

                if (permission.state === 'granted') {
                    setStatus('Getting a GPS fix…', 'info', { autoHideMs: 5000 });
                    startPositionWatch();
                } else if (permission.state === 'denied') {
                    setStatus('Location permission is blocked. Enable it in browser/site settings, then reload.', 'warning', {
                        autoHideMs: 9000
                    });
                } else {
                    requestInitialLocation();
                }

                permission.onchange = () => {
                    locationPermissionState = permission.state;
                    if (permission.state === 'granted') {
                        setStatus('Location permission granted. Getting a GPS fix…', 'success', {
                            autoHideMs: 3500
                        });
                        startPositionWatch();
                    } else if (permission.state === 'denied') {
                        setStatus('Location permission is blocked. Enable it in browser/site settings, then reload.', 'warning', {
                            autoHideMs: 9000
                        });
                    } else {
                        requestInitialLocation();
                    }
                };
                return;
            }
        } catch (error) {
            console.warn('Permission status lookup failed:', error);
        }

        requestInitialLocation();
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
            setStatus('Road data is temporarily unavailable.', 'warning', { autoHideMs: 3500 });
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
    initializeLocationFlow();
    startRoadPolling();

    window.driveDash = {
        getState: () => ({
            hasMap: Boolean(map),
            hasMiniCooper: Boolean(userCar),
            miniCooperLoadState,
            hasFallbackMarker: false,
            hasUserPosition: Boolean(userPosition),
            isFollowing,
            latestRoadLabel,
            latestSpeedLimitMph,
            currentSpeedLimitMph,
            locationPermissionState,
            geoWatchActive: geoWatchId !== null,
            initialLocationRequestInFlight,
            statusVisible: !elements.statusBanner.classList.contains('hidden'),
            statusText: elements.statusBanner.textContent
        }),
        parseMaxSpeedToMph
    };
})();
