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

    // vector : {

    //     geojson : function (req, res) {
    //         return snow_query.vector.scf_single_mask(req, res);
    //     },

    //     scf_single_mask : function (req, res) {
    //         var options     = req.body;
    //         var query_type  = options.query_type;
    //         var cube_id     = options.cube_id;
    //         var mask_id     = options.mask_id;
    //         var year        = options.year;
    //         var force_query = options.options ? options.options.force_query : false;
    //         var ops         = [];

    //         if (!mask_id) return res.status(502).send({
    //             error : 'Need a mask to query.'
    //         });

    //         // check for already stored query
    //         var query_key = 'query:type' + query_type + ':' + cube_id + ':year-' + year + ':mask_id-' + mask_id;
    //         store.layers.get(query_key, function (err, stored_query) {

    //             // return stored query if any
    //             if (!err && stored_query && !force_query) return res.end(stored_query);

    //             // create and run new query
    //             snow_query.vector.create_scf_single_mask_query(options, function (err, query) {

    //                 // return to client
    //                 res.send(query);                      

    //             });
    //         });
    //     },

    //     create_scf_single_mask_query : function (options, done) {
    //         var query_type = options.query_type;
    //         var access_token = options.access_token;
    //         var cube_id = options.cube_id;
    //         var mask_id = options.mask_id;
    //         var query_type = options.query_type;
    //         var year = options.year;
    //         var day = options.day;
    //         var ops = [];

    //         // get cube
    //         ops.push(function (callback) {
    //             cubes.find(cube_id, callback);
    //         });

    //         // get relevant datasets to query, from [wu]
    //         ops.push(function (cube, callback) {

    //             // get cube datasets
    //             var datasets = cube.datasets;

    //             // filter cube's datasets for this year only
    //             var withinRange = _.filter(datasets, function (d, i) {
    //                 var current = moment.utc(d.timestamp).add(12, 'h'); // because original date in dataset is '2016-01-01T00:00:00+01:00' (ie. mindnight, but +1 timezone)
    //                 var before = moment.utc().year(year).dayOfYear(1).hour(1).minutes(0).seconds(0);
    //                 var after = moment.utc().year(year).endOf('year');
    //                 return (current.isSameOrAfter(before) && current.isSameOrBefore(after));
    //             });

    //             // get details on all datasets
    //             pile.POST(pile.routes.base + pile.routes.get_datasets, {
    //                 datasets : withinRange,
    //                 access_token : access_token,
    //             }, function (err, dataset_details){
    //                 callback(err, dataset_details, cube);
    //             });

    //         });

    //         // fix mask
    //         ops.push(function (dataset_details, cube, callback) {

    //             var options = {
    //                 datasets : dataset_details,
    //                 cube : cube
    //             }

    //             // find mask
    //             var mask = _.find(cube.masks, function (m) {
    //                 return m.id == mask_id;
    //             });

    //             if (!mask) return callback('Mask not available: ' + mask_id);

    //             // create geojson from geometry
    //             options.mask = mask.geometry;

    //             // continue
    //             callback(null, options);
           
    //         });

    //         ops.push(function (options, callback) {

    //             // query multiple datasets
    //             snow_query.vector.query_snow_cover_fraction_single_mask(options, callback);
              
    //         });
            
            
    //         async.waterfall(ops, function (err, scfs) {
    //             // catch errors
    //             if (err) return done(err);

    //             // save query to redis cache
    //             var query_key = 'query:type' + query_type + ':' + cube_id + ':year-' + year + ':mask_id-' + mask_id;
    //             store.layers.set(query_key, JSON.stringify(scfs), function (err) {
    //                 console.log('Stored query to disk @ ', query_key, err);

    //                 // done
    //                 done(null, scfs);
    //             });
    //         });

    //     },

    //     query_snow_cover_fraction_single_mask : function (options, done) {
    //         var datasets = options.datasets;
    //         var cube = options.cube;
    //         var mask = options.mask;
    //         var queryOptions;
    //         var n = 0;
    //         var query_results = [];

    //         // set query id
    //         var query_id = 'query-' + tools.getRandomChars(10);

    //         // query each dataset
    //         async.eachSeries(datasets, function (dataset, callback) {

    //             console.log('Querying...');

    //             var timestamp_dataset = _.find(cube.datasets, function (d) {
    //                 return d.id == dataset.table_name;
    //             })
    //             if(!timestamp_dataset) return callback(null);
    //             var dataset_date = timestamp_dataset.timestamp;

    //             // set query options
    //             queryOptions = {
    //                 dataset : dataset,
    //                 query_num : n++,
    //                 query_id : query_id,
    //                 dataset_date : dataset_date, // get date of dataset in cube, not timestamp of dataset
    //                 mask : mask,
    //             }

    //             // create query
    //             snow_query.vector.postgis_snowcover(queryOptions, function (err, pg_result) {
    //                 if (err) return callback(err);
                    
    //                 // get rows
    //                 var rows = pg_result.rows;

    //                 // calculate snow cover fraction
    //                 var averagePixelValue = snow_query.helpers.getSnowCoverFraction(rows);

    //                 // get date from cube dataset (not from dataset internal timestamp)
    //                 var cubeDatasetTimestamp = queryOptions.dataset_date;

    //                 // results
    //                 var scf_results = {
    //                     date : moment.utc(cubeDatasetTimestamp).hour(0).format(),
    //                     scf : averagePixelValue,
    //                     // rows : rows
    //                 };

    //                 // store in memory
    //                 query_results.push(scf_results);

    //                 // callback
    //                 callback(null);

    //             });

    //         }, function (err) {
    //             done(err, query_results);
    //         });

    //     },


    //     postgis_snowcover : function (options, done) {

    //         // options
    //         var dataset = options.dataset;
    //         var geojson = options.mask;
    //         var cube = options.cube;
    //         var query_id = options.query_id;
    //         var query_num = options.query_num;

    //         // get postgis compatible geojson
    //         var pg_geojson = snow_query.helpers.retriveGeoJSON(geojson);

    //         // set postgis options
    //         var pg_username = MAPIC_PGSQL_USERNAME;
    //         var pg_password = MAPIC_PGSQL_PASSWORD;
    //         var pg_database = dataset.database_name;

    //         // set connection string
    //         var conString = 'postgres://' + pg_username + ':' + pg_password + '@postgis/' + pg_database;

    //         // initialize a connection pool
    //         pg.connect(conString, function(err, client, pg_done) {
    //             if (err) return console.error('error fetching client from pool', err);

    //             // create query with geojson mask
    //             if (pg_geojson) {
                 
    //                 // raster (actually working)
    //                 // var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' AS A INNER JOIN ' + mask_dataset_id + ' AS B ON ST_Intersects(A.rast, B.rast), LATERAL ST_ValueCount(ST_Clip(A.rast,ST_Polygon(B.rast)), 1) AS pvc) as t;'
    //                 // with mask (current 'working' geojson)
    //                 // var query = "select row_to_json(t) from (SELECT rid, pvc FROM " + dataset.table_name + ", ST_ValueCount(rast,1) AS pvc WHERE st_intersects(st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857), rast)) as t;"
    //                 // debug test, make them similar
    //                 // var query = "select row_to_json(t) from (SELECT A.rid, pvc FROM " + dataset.table_name + " AS A INNER JOIN st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857) AS B ON ST_Intersects(A.rast, B.geom), LATERAL ST_ValueCount(ST_Clip(A.rast, B.geom), 1) AS pvc) as t;"
    //                 // var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' AS A INNER JOIN ' + mask_dataset_id + ' AS B ON ST_Intersects(A.rast, B.rast), LATERAL ST_ValueCount(ST_Clip(A.rast,ST_Polygon(B.rast)), 1) AS pvc) as t;'

    //                 // works
    //                 var query = "select row_to_json(t) from (SELECT A.rid, pvc FROM " + dataset.table_name + " AS A INNER JOIN st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857) AS B ON ST_Intersects(A.rast, B), LATERAL ST_ValueCount(ST_Clip(A.rast, B), 1) AS pvc) as t;"

    //             } else {
                 
    //                 // without mask
    //                 var query = "select row_to_json(t) from (SELECT rid, pvc FROM " + dataset.table_name + ", ST_ValueCount(rast,1) AS pvc ) as t;"
               
    //             }

    //             // query postgis
    //             client.query(query, function(err, pg_result) {
                   
    //                 // call `pg_done()` to release the client back to the pool
    //                 pg_done();

    //                 // return results
    //                 done(err, pg_result);
    //             });
    //         });
    //     },


    // },


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