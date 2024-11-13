// Replace 'YOUR_MAPBOX_ACCESS_TOKEN' with your actual Mapbox access token
mapboxgl.accessToken = 'pk.eyJ1IjoidG90b2IxMjE3IiwiYSI6ImNsbXo4NHdocjA4dnEya215cjY0aWJ1cGkifQ.OMzA6Q8VnHLHZP-P8ACBRw';

const map = new mapboxgl.Map({
    container: 'map', // Container ID
    style: 'mapbox://styles/totob1217/cm3f0b1qp000v01rv4evcaegr', // mapbox://styles/mapbox/navigation-day-v1
    center: [0, 0], // Starting position [longitude, latitude]
    zoom: 15 // Starting zoom level
});

const geolocate = new mapboxgl.GeolocateControl({
    positionOptions: {
        enableHighAccuracy: true
    },
    trackUserLocation: true,
    showUserHeading: true
});

map.addControl(geolocate);

// Center the map on the user's location as soon as it's available
map.on('load', () => {
    geolocate.trigger();
});
