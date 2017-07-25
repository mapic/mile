// dependencies
var _ = require('lodash');
var fs = require('fs-extra');
var kue = require('kue');
var path = require('path');
var zlib = require('zlib');
var async = require('async');
var redis = require('redis');
var carto = require('carto');
var mapnik = require('mapnik');
var colors = require('colors');
var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var mongoose = require('mongoose');
var request = require('request');

// config
// var config = require('../config/wu-config');
var config = require(process.env.PILE_CONFIG_PATH || '/mapic/config/mile.config.js');


// redis store for temp tokens and upload increments
var redisLayers = require('redis').createClient(config.redis.layers.port, config.redis.layers.host);
redisLayers.on('error', function (err) {console.log('Redis error: ', err);});
redisLayers.auth(config.redis.layers.auth);

// redis store for temp tokens and upload increments
var redisStats = require('redis').createClient(config.redis.stats.port, config.redis.stats.host);
redisStats.on('error', function (err) {console.log('Redis error: ', err);});
redisStats.auth(config.redis.stats.auth);
// redis store for temp tokens and upload increments
var redisTemp = require('redis').createClient(config.redis.temp.port, config.redis.temp.host);
redisTemp.on('error', function (err) {console.log('Redis error: ', err);});
redisTemp.auth(config.redis.temp.auth);


var whichRedis = process.argv[2];
var searchKeys = process.argv[3];

console.log('Searching redis instance', whichRedis, 'for key', searchKeys);

if (!whichRedis) {
	console.log('Please provide args: node search_redis_keys.js [layers|stats|temp] [searchKeys]')
	process.exit(1);
}

var r;

// which redis instance
if (whichRedis == 'layers') {
	r = redisLayers;
}
if (whichRedis == 'stats') {
	r = redisStats;
}
if (whichRedis == 'temp') {
	r = redisTemp;
}

r.select(2, function () {

    r.info(function (err, info) {
        console.log('info:', err, info);
    })
    

    var key = searchKeys ? searchKeys + '*' : '*';

    // search keys
    r.keys(key, function (err, keys) {
    	console.log('found keys: ', err, keys);

    	process.exit(0);
    });



})
