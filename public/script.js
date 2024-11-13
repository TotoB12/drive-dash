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

map.on('load', () => {
    geolocate.trigger();
});

document.getElementById('track-orientation').addEventListener('click', () => {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        // For iOS 13+ devices
        DeviceOrientationEvent.requestPermission()
        .then(permissionState => {
            if (permissionState === 'granted') {
                window.addEventListener('deviceorientation', handleOrientation, true);
            } else {
                alert('Permission not granted for Device Orientation');
            }
        })
        .catch(console.error);
    } else {
        // Non-iOS devices
        window.addEventListener('deviceorientation', handleOrientation, true);
    }
});

function handleOrientation(event) {
    let heading;

    if (event.webkitCompassHeading) {
        // For iOS devices
        heading = event.webkitCompassHeading;
    } else if (event.absolute && event.alpha !== null) {
        // For Android devices
        heading = event.alpha;
    }

    if (typeof heading === 'number' && !isNaN(heading)) {
        map.setBearing(360 + heading);
    } else {
        console.warn('Heading information is not available.');
    }
}
