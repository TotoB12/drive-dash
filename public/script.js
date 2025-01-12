////////////////////////////////////////////////////////////////////////////////
// 1. Map initialization
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

// Disable default Mapbox marker logo:
map.on('load', () => {
    // Start tracking once style is fully loaded
    startTrackingUserPosition();

    // Overpass & Nominatim calls every 4 seconds
    setInterval(performApiCalls, 4000);
});


// ————————————————————————————————————————————————————————————————
// 2. "Follow" Feature & Orientation Logic
// ————————————————————————————————————————————————————————————————
let userPosition = null;  // updated by Geolocation
let isFollowing = false;  
let latestAddress = null;
let latestMaxSpeed = null;
let currentSpeedLimit = null;

// store the last positions to compute heading
const MAX_POSITIONS = 5; 
let lastPositions = [];

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

function addPositionToHistory(lat, lng) {
    lastPositions.push({ lat, lng });
    if (lastPositions.length > MAX_POSITIONS) {
        lastPositions.shift();
    }
}

function computeSmoothedBearing() {
    // Need at least 2 points
    if (lastPositions.length < 2) {
        return map.getBearing();
    }
    const first = lastPositions[0];
    const last = lastPositions[lastPositions.length - 1];
    return computeBearing(first.lat, first.lng, last.lat, last.lng);
}

// Basic formula for bearing (degrees)
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


// ————————————————————————————————————————————————————————————————
// 3. Threebox & 3D Car Model
// ————————————————————————————————————————————————————————————————
let tb;       // Threebox instance
let userCar;  // The 3D model of the car

// Create a custom layer in Mapbox that uses Threebox
const customLayer = {
    id: '3d-car-layer',
    type: 'custom',
    renderingMode: '3d',

    // onAdd: create the Threebox scene & load your model
    onAdd: function (map, gl) {
        // 1) Create the Threebox instance
        tb = new Threebox(
            map,
            gl,
            {
                defaultLights: true
                // you could pass other threebox options here
            }
        );

        // 2) Load the car model from /models/mini.glb
        // Note: some 3D models face +Z by default, so we might rotate x=90 to make it upright
        tb.loadObj(
            {
                obj: '/models/mini.glb',   // path to your model
                type: 'gltf',
                scale: 7,                 // adjust scale to suit your needs
                units: 'meters',
                rotation: { x: 90, y: 0, z: 0 } 
            },
            function (model) {
                // Once loaded, store reference
                userCar = model;
                // Position the model at [0,0] initially or any default
                userCar.setCoords([0, 0]);
                // Add to the Threebox scene
                tb.add(userCar);
            }
        );
    },

    // render => called every frame. We must update Threebox scene
    render: function (gl, matrix) {
        tb.update();
    }
};

// Add the custom layer to the map so it can render in 3D
map.on('style.load', () => {
    map.addLayer(customLayer);
});

// Accessor for current user position
function getCurrentPosition() {
    return userPosition;
}


// ————————————————————————————————————————————————————————————————
// 4. Geolocation & Car Heading
// ————————————————————————————————————————————————————————————————
function startTrackingUserPosition() {
    if (!('geolocation' in navigator)) {
        alert('Geolocation is not supported by your browser');
        return;
    }
    navigator.geolocation.watchPosition(
        position => {
            const { latitude, longitude } = position.coords;
            userPosition = { latitude, longitude };

            // Add user position to history for heading calculation
            addPositionToHistory(latitude, longitude);

            // Rotate the model to the user heading & move it
            if (userCar) {
                // Place the car at the new position
                userCar.setCoords([longitude, latitude]);

                // Always rotate the car to the computed bearing
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
        },
        error => {
            console.error('Geolocation error:', error);
        },
        {
            enableHighAccuracy: true
        }
    );
}


// ————————————————————————————————————————————————————————————————
// 5. Overpass & Nominatim calls + UI updates
// ————————————————————————————————————————————————————————————————
async function performApiCalls() {
    const position = getCurrentPosition();
    if (!position) {
        console.log('Waiting for position...');
        return;
    }

    const { latitude, longitude } = position;

    // 5.1 Reverse-geocode to get street name
    const locationData = await fetchLocationData(latitude, longitude);
    console.log('Nominatim data:', locationData);

    if (locationData && locationData.address) {
        latestAddress = locationData.address;
    } else {
        latestAddress = null;
    }
    updateRoadDisplay();

    // 5.2 Overpass to get speed limit
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

// Simple fetch to Nominatim
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

// Simple fetch to Overpass
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
        // Fade from old to new
        if (currentSpeedLimit === null) {
            // no sign => immediate show
            speedLimitSign.src = `/images/speed-limit/us/${latestMaxSpeed}.svg`;
            speedLimitSign.classList.remove('hidden');
        } else {
            // sign => fade out, then change src, fade in
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
        // Hide sign
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
