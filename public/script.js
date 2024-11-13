mapboxgl.accessToken = 'pk.eyJ1IjoidG90b2IxMjE3IiwiYSI6ImNsbXo4NHdocjA4dnEya215cjY0aWJ1cGkifQ.OMzA6Q8VnHLHZP-P8ACBRw';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/totob1217/cm3f0b1qp000v01rv4evcaegr',
    center: [0, 0],
    zoom: 4,
    pitch: 60
});

const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true
    },
    trackUserLocation: true,
    showUserHeading: true,
    fitBoundsOptions: {
        maxZoom: 17,
        pitch: 60
    }
});
const nav = new mapboxgl.NavigationControl();
const fullscreen = new mapboxgl.FullscreenControl();

map.addControl(geolocate);
map.addControl(nav);
map.addControl(fullscreen);

// Variables for device orientation
let deviceOrientation = null;
let isOrientationTracking = false;

// Function to request device orientation permission
function requestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires permission
        DeviceOrientationEvent.requestPermission()
            .then(permissionState => {
                if (permissionState === 'granted') {
                    enableOrientationTracking();
                }
            })
            .catch(console.error);
    } else {
        // Non iOS 13+ devices
        enableOrientationTracking();
    }
}

// Function to enable orientation tracking
function enableOrientationTracking() {
    isOrientationTracking = true;
    window.addEventListener('deviceorientation', handleOrientation);
}

// Function to handle orientation changes
function handleOrientation(event) {
    if (!isOrientationTracking) return;

    let heading = null;

    if (event.webkitCompassHeading) {
        // iOS devices
        heading = event.webkitCompassHeading;
    } else if (event.alpha) {
        // Android devices
        heading = 360 - event.alpha;
    }

    if (heading !== null) {
        // Update map bearing smoothly
        map.easeTo({
            bearing: heading,
            duration: 100
        });
    }
}

// Add orientation toggle button
const orientationButton = document.createElement('button');
orientationButton.className = 'mapboxgl-ctrl-icon orientation-button';
orientationButton.innerHTML = '🧭';
orientationButton.style.cssText = `
    position: absolute;
    bottom: 100px;
    right: 10px;
    z-index: 1;
    padding: 10px;
    background: white;
    border: none;
    border-radius: 4px;
    box-shadow: 0 0 0 2px rgba(0,0,0,0.1);
    cursor: pointer;
`;

orientationButton.addEventListener('click', () => {
    if (!isOrientationTracking) {
        requestOrientationPermission();
        orientationButton.style.backgroundColor = '#ccc';
    } else {
        isOrientationTracking = false;
        window.removeEventListener('deviceorientation', handleOrientation);
        orientationButton.style.backgroundColor = 'white';
        // Reset map bearing to north
        map.easeTo({
            bearing: 0,
            duration: 500
        });
    }
});

document.body.appendChild(orientationButton);