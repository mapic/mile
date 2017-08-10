// dependencies
var _ = require('lodash');
var fs = require('fs-extra');
var kue = require('kue');
var path = require('path');
var zlib = require('zlib');
var uuid = require('uuid');
var async = require('async');
var redis = require('redis');
var carto = require('carto');
var mapnik = require('mapnik');
var colors = require('colors');
var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
// var mongoose = require('mongoose');
var request = require('request');

// global paths
var VECTORPATH   = '/data/vector_tiles/';
var RASTERPATH   = '/data/raster_tiles/';
var GRIDPATH     = '/data/grid_tiles/';

var mile_settings = {
    store : 'disk' // or redis
}

var silentLog = function (err) {
    if (err) console.log(err);
}

var MAPIC_REDIS_AUTH = process.env.MAPIC_REDIS_AUTH;
var MAPIC_REDIS_PORT = process.env.MAPIC_REDIS_PORT || 6379;
var MAPIC_REDIS_DB   = process.env.MAPIC_REDIS_DB || 1;

var redis_instances = {};
_.each(['redisLayers', 'redisStats', 'redisTemp'], function (i) {

    // connect redis
    var redis_connect_string = _.toLower(i);
    redis_instances[i] = redis.createClient(MAPIC_REDIS_PORT, redis_connect_string, {detect_buffers : true});

    // auth redis
    async.retry({times: 100, interval: 2000}, connectRedis.bind(this, i), function (err, results) {
        redis_instances[i].on('error', silentLog);
        redis_instances[i].select(MAPIC_REDIS_DB, silentLog)
        console.log('Connected to', i);
    });
});
function connectRedis (i, callback) {
    try {
        redis_instances[i].auth(MAPIC_REDIS_AUTH, function (err) {
            callback(err);
        });
    } catch (e) {
        callback(e);
    }
}


module.exports = store = { 

    layers : redis_instances['redisLayers'],
    temp : redis_instances['redisTemp'],
    stats : redis_instances['redisStats'],

    // save tiles generically
    _saveVectorTile : function (tile, params, done) {
        if (mile_settings.store == 'redis') return store._saveVectorTileRedis(tile, params, done);
        if (mile_settings.store == 'disk')  return store._saveVectorTileDisk(tile, params, done);
        return done('mile_settings.store not set!');
    },
    _readVectorTile : function (params, done) {
        if (mile_settings.store == 'redis') return store._readVectorTileRedis(params, done);
        if (mile_settings.store == 'disk')  return store._readVectorTileDisk(params, done);
        return done('mile_settings.store not set!');
    },
    _saveRasterTile : function (tile, params, done) {
        if (mile_settings.store == 'redis') return store._saveRasterTileRedis(tile, params, done);
        if (mile_settings.store == 'disk')  return store._saveRasterTileDisk(tile, params, done);
        return done('mile_settings.store not set!');
    },
    _readRasterTile : function (params, done) {
        if (mile_settings.store == 'redis') return store._readRasterTileRedis(params, done);
        if (mile_settings.store == 'disk')  return store._readRasterTileDisk(params, done);
        return done('mile_settings.store not set!');
    },






    // read/write to redis
    _saveVectorTileRedis : function (tile, params, done) {
        // save png to redis
        var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        var key = new Buffer(keyString);
        store.layers.set(key, tile.getData(), done);
    },
    _readVectorTileRedis : function (params, done) {
        var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        var key = new Buffer(keyString);
        store.layers.get(key, done);
    },
    _saveRasterTileRedis : function (tile, params, done) {
        // save png to redis
        var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        var key = new Buffer(keyString);
        store.layers.set(key, tile.encodeSync('png'), done);
    },
    _readRasterTileRedis : function (params, done) {
        var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        var key = new Buffer(keyString);
        store.layers.get(key, done);
    },

    



    // read/write to disk
    _saveVectorTileDisk : function (tile, params, done) {
        var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.pbf';
        var path = VECTORPATH + keyString;
        fs.outputFile(path, tile.getData(), done);
    },
    _readVectorTileDisk : function (params, done) {
        var keyString = 'vector_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.pbf';
        var path = VECTORPATH + keyString;
        fs.readFile(path, function (err, buffer) {
            if (err) return done(null);
            done(null, buffer);
        });
    },
    _saveRasterTileDisk : function (tile, params, done) {
        var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';
        console.log('created', keyString);
        var path = RASTERPATH + keyString;
        tile.encode('png8', function (err, buffer) {
            fs.outputFile(path, buffer, function (err) {
                done(null);
            });
        });
    },
    _readRasterTileDisk : function (params, done) {
        var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';
        var path = RASTERPATH + keyString;
        fs.readFile(path, function (err, buffer) {
            if (err) return done(null);
            done(null, buffer);
        });
    },


    // get grid tiles from redis
    getGridTile : function (params, done) {
        var keyString = 'grid_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        store.layers.get(keyString, done);
    },



}
