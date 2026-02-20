////////////////////////////////////////////////////////////////////////////////
// 1. Map initialization (unchanged)
////////////////////////////////////////////////////////////////////////////////
mapboxgl.accessToken =
    'pk.eyJ1IjoidG90b2IxMjE3IiwiYSI6ImNsbXo4NHdocjA4dnEya215cjY0aWJ1cGkifQ.OMzA6Q8VnHLHZP-P8ACBRw';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/totob1217/cm3f0b1qp000v01rv4evcaegr',
    center: [0, 0],
    zoom: 4,
    pitch: 60,
    attributionControl: false
});

map.on('load', () => {
    // Start tracking once style is fully loaded
    startTrackingUserPosition();

    // Overpass & Nominatim calls every 4 seconds
    setInterval(performApiCalls, 4000);
});

// ————————————————————————————————————————————————————————————————
// 2. "Follow" Feature & Orientation Logic (unchanged except minor additions)
// ————————————————————————————————————————————————————————————————
let userPosition = null;  // updated by Geolocation
let isFollowing = false;
let latestAddress = null;
let latestMaxSpeed = null;
let currentSpeedLimit = null;

// store the last positions to compute heading
const MAX_POSITIONS = 5;
let lastPositions = [];

// NEW: We'll store extra info for speed calculation (time in ms).
// Instead of an array of just { lat, lng }, store { lat, lng, timestamp }.
function addPositionToHistory(lat, lng, timestamp) {
    lastPositions.push({ lat, lng, timestamp });
    if (lastPositions.length > MAX_POSITIONS) {
        lastPositions.shift();
    }
}

const recenterButton = document.getElementById('recenterButton');
recenterButton.addEventListener('click', () => {
    if (!isFollowing) {
        if (userPosition) {
            isFollowing = true;
            recenterButton.classList.add('invisible');
            map.flyTo({
                center: [userPosition.longitude, userPosition.latitude],
                zoom: 17,
                pitch: 60
            });
        } else {
            alert('User position not available yet.');
        }
    }
});

map.on('drag', () => {
    // user manually dragged => disable follow mode
    if (isFollowing) {
        isFollowing = false;
        recenterButton.classList.remove('invisible');
    }
});

// ————————————————————————————————————————————————————————————————
// Heading calculation helpers (unchanged)
// ————————————————————————————————————————————————————————————————
function computeSmoothedBearing() {
    // Need at least 2 points
    if (lastPositions.length < 2) {
        return map.getBearing();
    }
    const first = lastPositions[0];
    const last = lastPositions[lastPositions.length - 1];
    return computeBearing(first.lat, first.lng, last.lat, last.lng);
}

function computeBearing(lat1, lng1, lat2, lng2) {
    const toRad = x => x * Math.PI / 180.0;
    const toDeg = x => x * 180.0 / Math.PI;

    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lng2 - lng1);

    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
        Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    let θ = toDeg(Math.atan2(y, x));
    return (θ + 360) % 360; // normalize
}

// NEW: Distance helper (Haversine or simpler lat/lng distance)
function computeDistance(lat1, lng1, lat2, lng2) {
    const R = 6371e3; // meters
    const toRad = x => x * Math.PI / 180.0;
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δφ = toRad(lat2 - lat1);
    const Δλ = toRad(lng2 - lng1);

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ————————————————————————————————————————————————————————————————
// 3. Threebox & 3D Car Model (unchanged)
// ————————————————————————————————————————————————————————————————
let tb;
let userCar;

const customLayer = {
    id: '3d-car-layer',
    type: 'custom',
    renderingMode: '3d',

    onAdd: function (map, gl) {
        tb = new Threebox(map, gl, { defaultLights: true });

        tb.loadObj(
            {
                obj: '/models/mini.glb',
                type: 'gltf',
                scale: 7,
                units: 'meters',
                rotation: { x: 90, y: 0, z: 0 }
            },
            function (model) {
                userCar = model;
                userCar.setCoords([0, 0]);
                tb.add(userCar);
            }
        );
    },

    render: function (gl, matrix) {
        tb.update();
    }
};

map.on('style.load', () => {
    map.addLayer(customLayer);
});

function getCurrentPosition() {
    return userPosition;
}

// ————————————————————————————————————————————————————————————————
// 4. Geolocation & Car Heading + Speed
// ————————————————————————————————————————————————————————————————
function startTrackingUserPosition() {
    if (!('geolocation' in navigator)) {
        alert('Geolocation is not supported by your browser');
        return;
    }

    navigator.geolocation.watchPosition(
        position => {
            const { latitude, longitude, speed } = position.coords;
            const timestamp = position.timestamp;
            userPosition = { latitude, longitude };

            // Add user position to history for heading AND speed calculation
            addPositionToHistory(latitude, longitude, timestamp);

            // Rotate the model to the user heading & move it
            if (userCar) {
                userCar.setCoords([longitude, latitude]);
                const bearing = computeSmoothedBearing();
                userCar.setRotation({ z: bearing });
            }

            // If in follow mode, recenter map & rotate camera
            if (isFollowing && userCar) {
                const bearing = computeSmoothedBearing();
                map.easeTo({
                    center: [longitude, latitude],
                    zoom: 17,
                    pitch: 60,
                    bearing: bearing,
                    duration: 500
                });
            }

            // NEW: Compute and update speed in mph
            updateSpeedDisplay(position);
        },
        error => {
            console.error('Geolocation error:', error);
        },
        {
            enableHighAccuracy: true
        }
    );
}

// NEW: Function to compute and display speed.
function updateSpeedDisplay(position) {
    const speedDisplay = document.getElementById('speedDisplay');

    // 1) If position.coords.speed is available (m/s):
    let speedMps = position.coords.speed; // might be null or undefined
    let speedMph = 0;

    if (speedMps !== null && speedMps !== undefined && !isNaN(speedMps)) {
        // Convert m/s to mph
        speedMph = speedMps * 2.23694;
    } else {
        // 2) Fallback approach: use last positions with timestamps
        if (lastPositions.length >= 2) {
            const prev = lastPositions[lastPositions.length - 2];
            const curr = lastPositions[lastPositions.length - 1];

            const distMeters = computeDistance(prev.lat, prev.lng, curr.lat, curr.lng);
            const timeSeconds = (curr.timestamp - prev.timestamp) / 1000.0;

            if (timeSeconds > 0) {
                const speedMpsFallback = distMeters / timeSeconds;
                speedMph = speedMpsFallback * 2.23694;
            }
        }
    }

    // Round to 0 decimal or 1 decimal if you prefer
    speedMph = Math.round(speedMph);

    // Update display
    speedDisplay.textContent = `${speedMph} mph`;
}

// ————————————————————————————————————————————————————————————————
// 5. Overpass & Nominatim calls + UI updates (unchanged)
// ————————————————————————————————————————————————————————————————
async function performApiCalls() {
    const position = getCurrentPosition();
    if (!position) {
        console.log('Waiting for position...');
        return;
    }

    const { latitude, longitude } = position;
    const locationData = await fetchLocationData(latitude, longitude);
    console.log('Nominatim data:', locationData);

    if (locationData && locationData.address) {
        latestAddress = locationData.address;
    } else {
        latestAddress = null;
    }
    updateRoadDisplay();

    if (locationData && locationData.osm_id) {
        const wayData = await fetchWayData(locationData.osm_id);
        console.log('Overpass data:', wayData);

        if (wayData && wayData.elements && wayData.elements.length > 0) {
            const wayElement = wayData.elements[0];
            if (wayElement.tags && wayElement.tags.maxspeed) {
                const maxspeedStr = wayElement.tags.maxspeed;
                const maxspeedNum = parseInt(maxspeedStr.match(/\d+/));
                if (!isNaN(maxspeedNum)) {
                    latestMaxSpeed = maxspeedNum;
                } else {
                    latestMaxSpeed = null;
                }
            } else {
                latestMaxSpeed = null;
            }
        } else {
            latestMaxSpeed = null;
        }
    } else {
        latestMaxSpeed = null;
    }
    updateSpeedLimitDisplay();
}

async function fetchLocationData(lat, lon) {
    try {
        const response = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`
        );
        return await response.json();
    } catch (error) {
        console.error('Nominatim API error:', error);
        return null;
    }
}

async function fetchWayData(osmId) {
    try {
        const response = await fetch(
            `https://overpass.private.coffee/api/interpreter?data=[out:json];way(${osmId});out tags;`
        );
        return await response.json();
    } catch (error) {
        console.error('Overpass API error:', error);
        return null;
    }
}

function updateRoadDisplay() {
    const roadDisplay = document.getElementById('roadDisplay');
    if (latestAddress && latestAddress.road) {
        roadDisplay.textContent = latestAddress.road;
        roadDisplay.style.display = 'block';
    } else {
        roadDisplay.style.display = 'none';
    }
}

function updateSpeedLimitDisplay() {
    const speedLimitSign = document.getElementById('speedLimitSign');

    if (latestMaxSpeed === currentSpeedLimit) {
        return;
    }

    if (latestMaxSpeed !== null) {
        if (currentSpeedLimit === null) {
            speedLimitSign.src = `/images/speed-limit/us/${latestMaxSpeed}.svg`;
            speedLimitSign.classList.remove('hidden');
        } else {
            speedLimitSign.addEventListener(
                'transitionend',
                function handleTransitionEnd() {
                    speedLimitSign.src = `/images/speed-limit/us/${latestMaxSpeed}.svg`;
                    speedLimitSign.classList.remove('hidden');
                    speedLimitSign.removeEventListener('transitionend', handleTransitionEnd);
                },
                { once: true }
            );
            speedLimitSign.classList.add('hidden');
        }
    } else {
        speedLimitSign.addEventListener(
            'transitionend',
            function handleTransitionEnd() {
                speedLimitSign.src = '';
                speedLimitSign.removeEventListener('transitionend', handleTransitionEnd);
            },
            { once: true }
        );
        speedLimitSign.classList.add('hidden');
    }

    currentSpeedLimit = latestMaxSpeed;
}
