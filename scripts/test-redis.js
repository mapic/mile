var REDIS_PORT = '6379';
var REDIS_HOST = 'redislayers';
var REDIS_AUTH = '9p7bRrd7Zo9oFbxVJIhI09pBq6KiOBvU4C76SmzCkqKlEPLHVR02TN2I40lmT9WjxFiFuBOpC2BGwTnzKyYTkMAQ21toWguG7SZE';

// redis store for layers
var redisLayers = require('redis').createClient(REDIS_PORT, REDIS_HOST);
redisLayers.on('error', function (err) {console.log('Redis error: ', err);});
redisLayers.auth(REDIS_AUTH);

redisLayers.set('test', 'ok');

redisLayers.get('test', function (err, result) {
    if (result && !err) console.log('Redis is connected!', REDIS_HOST, REDIS_PORT);
    process.exit(err);
});