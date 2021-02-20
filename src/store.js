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
var request = require('request');

// global paths
var VECTORPATH   = '/data/vector_tiles/';
var RASTERPATH   = '/data/raster_tiles/';
var GRIDPATH     = '/data/grid_tiles/';

var mile_settings = {
    // store : 'disk' // or redis or s3
    store : 's3' // or redis or s3
}

if (process.env.TRAVIS) {
    mile_settings.store = 'disk';
}

var silentLog = function (err) {
    if (err) console.log(err);
}


var MAPIC_REDIS_AUTH = process.env.MAPIC_REDIS_AUTH;
var MAPIC_REDIS_PORT = process.env.MAPIC_REDIS_PORT || 6379;
var MAPIC_REDIS_DB   = process.env.MAPIC_REDIS_DB || 1;

// aws access keys (used automatically from ENV)
process.env.AWS_ACCESS_KEY_ID       = process.env.MAPIC_AWS_S3_ACCESSKEYID      || process.env.MAPIC_AWS_ACCESSKEYID;
process.env.AWS_SECRET_ACCESS_KEY   = process.env.MAPIC_AWS_S3_SECRETACCESSKEY  || process.env.MAPIC_AWS_SECRETACCESSKEY;

if (!process.env.TRAVIS) {

    try {
        var AWS = require('aws-sdk');
        var s3 = new AWS.S3({region: 'eu-central-1'});
        var bucketName = 'mapic-s3.' + process.env.MAPIC_DOMAIN;
    } catch (e) {
        console.log('AWS error: ', e);
    };

    // Call S3 to list current buckets
    s3.listBuckets(function(err, data) {
        if (err) return console.log("Error", err);
        
        // look for bucket
        var bucketFound = _.find(data.Buckets, function (b) {
            return b.Name == bucketName;
        });

        // check for bucket
        if (!_.isUndefined(bucketFound)) return console.log('Using S3 Bucket @', bucketFound.Name);

        // create bucket
        s3.createBucket({
            Bucket : bucketName,
            // Region : 'eu-central-1'
        }, function(err, data) {
            if (err) return console.log("Error", err);
            console.log("Created S3 bucket @", data.Location);
        });
    });

}

var redis_instances = {};
_.each(['redis'], function (i) {
    async.retry({times: 100, interval: 2000}, connectRedis.bind(this, i), function (err, results) {
        redis_instances[i].on('error', silentLog);
        redis_instances[i].select(MAPIC_REDIS_DB, silentLog)
        console.log('Connected to Redis @', i);
    });
});
function connectRedis (i, callback) {
    var redis_connect_string = _.toLower(i);
    redis_instances[i] = redis.createClient(MAPIC_REDIS_PORT, redis_connect_string, {detect_buffers : true});
    redis_instances[i].auth(MAPIC_REDIS_AUTH, callback);
}





module.exports = store = { 

    layers : redis_instances['redis'],
    stats : redis_instances['redis'],

    // route to storage backend
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
        if (mile_settings.store == 's3')    return store._saveRasterTileS3(tile, params, done);
        return done('mile_settings.store not set!');
    },
    _readRasterTile : function (params, done) {
        if (mile_settings.store == 'redis') return store._readRasterTileRedis(params, done);
        if (mile_settings.store == 'disk')  return store._readRasterTileDisk(params, done);
        if (mile_settings.store == 's3')    return store._readRasterTileS3(params, done);
        return done('mile_settings.store not set!');
    },
    saveGridTile : function (key, data, done) {
        if (mile_settings.store == 's3') return store._saveGridTileS3(key, data, done);
        store._saveGridTileRedis(key, data, done); // old default
    },
    getGridTile : function (params, done) {
        if (mile_settings.store == 's3') return store._getGridTileS3(params, done);
        store._getGridTileRedis(params, done); // old default
    },


    safeParse : function (string) {
        try {
            var obj = JSON.parse(string);
            return obj;
        } catch (e) {
            console.log('safeParse failed!', string);
            return false;
        }
    },

    // read/write to AWS S3
    _saveRasterTileS3 : function (tile, params, done) {
        var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';
        tile.encode('png8', function (err, buffer) {
            s3.putObject({
                Bucket: bucketName,
                Key: keyString,
                Body: buffer
            }, function (err, response) {
                done(null);
            });
        });
    },
    _readRasterTileS3 : function (params, done) {
        var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';
        var params = {Bucket: bucketName, Key: keyString};
        s3.getObject(params, function(err, data) {
            // console.log('err, data', err, data);
            if (err || !data) return done(null);
            done(null, data.Body);
        });
    },
    _saveGridTileS3 : function (key, data, done) {
        s3.putObject({
            Bucket: bucketName,
            Key: key,
            Body: data
        }, function (err, response) {
            done(null);
        });
    },
    _getGridTileS3 : function (params, done) {
        var keyString = 'grid_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        var params = {Bucket: bucketName, Key: keyString};
        s3.getObject(params, function(err, data) {
            if (err || !data) return done(null);
            done(null, data.Body);
        });
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
    _saveGridTileRedis : function (key, data, done) {
        store.layers.set(key, data, done);
    },
    _getGridTileRedis : function (params, done) {
        var keyString = 'grid_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        store.layers.get(keyString, done);
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

}
