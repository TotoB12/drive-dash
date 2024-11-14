mapboxgl.accessToken = 'pk.eyJ1IjoidG90b2IxMjE3IiwiYSI6ImNsbXo4NHdocjA4dnEya215cjY0aWJ1cGkifQ.OMzA6Q8VnHLHZP-P8ACBRw';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/totob1217/cm3f0b1qp000v01rv4evcaegr',
    center: [0, 0],
    zoom: 4,
    pitch: 60
});

let deviceOrientation = null;
let isTracking = false;

let userMarker = null;
let userPosition = null;

const orientationButton = document.getElementById('orientationButton');
const recenterButton = document.getElementById('recenterButton');

function requestDeviceOrientation() {
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ devices need to request permission
        DeviceOrientationEvent.requestPermission()
            .then(response => {
                if (response === 'granted') {
                    enableDeviceOrientation();
                }
            })
            .catch(console.error);
    } else {
        // Non iOS 13+ devices
        enableDeviceOrientation();
    }
}

function enableDeviceOrientation() {
    isTracking = true;
    window.addEventListener('deviceorientation', handleDeviceOrientation);
}

function handleDeviceOrientation(event) {
    if (!isTracking) return;

    let heading = null;

    if (event.webkitCompassHeading) {
        // iOS devices
        heading = event.webkitCompassHeading;
    } else if (event.alpha) {
        // Android devices
        heading = 360 - event.alpha;
    }

    if (heading !== null) {
        map.easeTo({
            bearing: heading,
            duration: 500
        });
    }
}

orientationButton.addEventListener('click', () => {
    if (!isTracking) {
        requestDeviceOrientation();
        orientationButton.style.backgroundColor = '#ccc';
    } else {
        isTracking = false;
        window.removeEventListener('deviceorientation', handleDeviceOrientation);
        orientationButton.style.backgroundColor = 'white';
    }
});

recenterButton.addEventListener('click', () => {
    if (userPosition) {
        map.flyTo({
            center: [userPosition.longitude, userPosition.latitude],
            zoom: 17,
            pitch: 60
        });
    } else {
        alert('User position not available yet.');
    }
});

map.on('load', () => {
    startTrackingUserPosition();
    setInterval(performApiCalls, 2000);
});

function startTrackingUserPosition() {
    if ('geolocation' in navigator) {
        navigator.geolocation.watchPosition(
            position => {
                const { latitude, longitude } = position.coords;
                userPosition = { latitude, longitude };

                if (!userMarker) {
                    userMarker = new mapboxgl.Marker()
                        .setLngLat([longitude, latitude])
                        .addTo(map);
                } else {
                    userMarker.setLngLat([longitude, latitude]);
                }
            },
            error => {
                console.error('Geolocation error:', error);
            },
            {
                enableHighAccuracy: true
            }
        );
    } else {
        alert('Geolocation is not supported by your browser');
    }
}

function getCurrentPosition() {
    return userPosition;
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

async function performApiCalls() {
    const position = getCurrentPosition();
    if (!position) {
        console.log('Waiting for position...');
        return;
    }

    const locationData = await fetchLocationData(position.latitude, position.longitude);
    console.log('Nominatim data:', locationData);

    if (locationData && locationData.osm_id) {
        const wayData = await fetchWayData(locationData.osm_id);
        console.log('Overpass data:', wayData);
    }
}