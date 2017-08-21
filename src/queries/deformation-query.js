// dependencies
var _ = require('lodash');
var pg = require('pg');
// var pg = require('pg').native;
var gm = require('gm');
var fs = require('fs-extra');
var kue = require('kue');
var path = require('path');
var zlib = require('zlib');
var uuid = require('uuid');
var async = require('async');
var redis = require('redis');
var carto = require('carto');
var forge = require('node-forge');
var mapnik = require('mapnik');
var colors = require('colors');
var cluster = require('cluster');
var mongoose = require('mongoose');
var request = require('request');
var numCPUs = require('os').cpus().length;
var exec = require('child_process').exec;
var sanitize = require("sanitize-filename");
var mercator = require('../sphericalmercator');
var geojsonArea = require('geojson-area');
var geojsonExtent = require('geojson-extent');
var topojson = require('topojson');
var moment = require('moment');
moment().utc();

// first run `npm install promise-polyfill --save
if (typeof Promise == 'undefined') {
  global.Promise = require('promise-polyfill')
}

// modules
var config = global.config;
var store  = require('../store');
var tools = require('../tools');

// global paths (todo: move to config)
var VECTORPATH = '/data/vector_tiles/';
var RASTERPATH = '/data/raster_tiles/';
var CUBEPATH   = '/data/cube_tiles/';
var GRIDPATH   = '/data/grid_tiles/';
var PROXYPATH  = '/data/proxy_tiles/';


var MAPIC_PGSQL_USERNAME = 'systemapic';
var MAPIC_PGSQL_PASSWORD = 'docker';

// postgis conn
var pgsql_options = {
    dbhost: 'postgis',
    dbuser: MAPIC_PGSQL_USERNAME,
    dbpass: MAPIC_PGSQL_PASSWORD
};

module.exports = snow_query = { 


    fetchRasterDeformation : function (req, res) {

        console.log('defo.fetchRasterDeformation()');
        console.log('req.body', req.body);

        // get options
        var options = req.body;
        var datasets = options.datasets;
        var point = options.point;
        var layer_id = options.layer_id;
        var ops = [];

        // sanity cheks
        if (!_.isArray(datasets)) return res.send({error : 'No datasets provided.'});
        if (_.isUndefined(point) || _.isNull(point)) return res.send({error : 'No point provided.'}); 
        if (!layer_id) return res.send({error : 'No layer_id provided.'});


        ops.push(function (callback) {
            store.layers.get(layer_id, function (err, layer) {
                if (err || !layer) return callback(err || 'no layer');
                callback(null, tools.safeParse(layer));
            });
        });

        ops.push(function (layer, callback) {

            var deformation_values = [];

            async.each(datasets, function (dataset, done) {

                var table = dataset.file_id;
                var date = dataset.date;
                var database = layer.options.database_name;

                // do sql query on postgis
                var GET_DATA_SCRIPT_PATH = 'src/bash-scripts/get_raster_deformation_value.sh';

                // st_extent script 
                var command = [
                    GET_DATA_SCRIPT_PATH,   // script
                    database,    // database name
                    table,   // table name
                    point.lng,
                    point.lat
                ].join(' ');

                // run query
                exec(command, {maxBuffer: 1024 * 1024 * 1000}, function (err, stdout, stdin) {
                    if (err) return done(err);

                    // parse results
                    var data = [];
                    var json = stdout.split('\n');
                    _.each(json, function (d) {
                        var line = tools.safeParse(d, true);
                        if (line && !_.isNull(line.st_value)) {
                            data.push(line);
                        }   
                    });

                    // int16 half: 32767
                    
                    var value = (_.isArray(data) && !_.isUndefined(data[0])) ? data[0].st_value : null;
                    deformation_values.push({
                        value : value,
                        date : date
                    });

                    // callback
                    done(null);
                });


            }, function (err, results) {
                callback(err, deformation_values);
            });

        });

        async.waterfall(ops, function (err, data) {
            if (err) console.log('async err', err);

            console.log('deformation_values: ', data);

            // done
            res.send({
                query : data,
                error : err
            });

        });


        // output format should be thus:

        // {
        //     "20130611": 0,
        //     "20130622": 0.083,
        //     "20130703": 0.196,
        //     "20130714": 0.317,
        //     "20130725": 0.42,
        //     "20130805": 0.489,
        //     "20130816": 0.522,
        //     "20130827": 0.538,
        //     "20130907": 0.576,
        //     "20130918": 0.675,
        //     "20130929": 0.873,
        //     "20131010": 1.189,
        //     "20131021": 1.609,
        //     "20131101": 2.073,
        //     "20140620": 2.094,
        //     "20140701": 2.233,
        //     "20140712": 2.429,
        //     "20140723": 2.654,
        //     "20140803": 2.871,
        //     "20140814": 3.049,
        //     "20140825": 3.17,
        //     "20140905": 3.232,
        //     "20141008": 3.238,
        //     "20141019": 3.261,
        //     "gid": 9006,
        //     "code": "9005",
        //     "lon": 14.294259,
        //     "lat": 66.2049106456587,
        //     "height": 529.67,
        //     "demerror": 4,
        //     "r": 0.937,
        //     "g": 1,
        //     "b": 0.059,
        //     "coherence": 0.958,
        //     "mvel": 2.4,
        //     "adisp": 0.202,
        //     "dtotal": 3.261,
        //     "d12mnd": 2.586,
        //     "d3mnd": 0.607,
        //     "d1mnd": 0.091,
        //     "geom": null,
        //     "the_geom_3857": null,
        //     "the_geom_4326": null,
        //     "lng": 14.2942593005056
        // }


    },



    utils : {

        geojsonFromGeometry : function (geometry) {
            if (!geometry) return false;

            var geojson = {
              "type": "FeatureCollection",
              "features": [
                {
                  "type": "Feature",
                  "properties": {},
                  "geometry": geometry
                }
              ]
            }
            return geojson;
        },

        // get PostGIS compatible GeoJSON
        retriveGeoJSON : function (geojson) {
            if (!geojson) return false;
            if (geojson.type == 'FeatureCollection') {
                try {
                    return JSON.stringify(geojson.features[0].geometry);
                } catch (e) {
                    return false;
                }

            } else if (geojson.type == 'Feature') {
                try {
                    return JSON.stringify(geojson.geometry);
                } catch (e) {
                    return false;
                }  
            } else {
                return false;
            }
        },



    }

}