// dependencies
var _ = require('lodash');
var pg = require('pg').native;
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
var mercator = require('./sphericalmercator');
var geojsonArea = require('geojson-area');
var geojsonExtent = require('geojson-extent');
var topojson = require('topojson');
var moment = require('moment');

// modules
var config = global.config;
var store  = require('./store');
var tools = require('./tools');

// custom query plugin: snow cover fraction
var snow_query = require('./queries/snow-query');

// register mapnik plugins
mapnik.register_default_fonts();
mapnik.register_default_input_plugins();

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

module.exports = cubes = { 

    create : function (req, res) {
        var options = req.body;

        // default cube options
        var defaultOptions = {
            cube_id : 'cube-' + uuid.v4(),
            timestamp : moment().valueOf(),
            createdBy : req.user.uuid,
            style : options.style || '#layer { raster-opacity: 1; }',
            quality : options.quality || 'png32',
            datasets : _.isArray(options.datasets) ? options.datasets : [] // ensure array
        };

        // combine options (latter overrides former)
        var cube = _.extend(options, defaultOptions);

        // save cube
        cubes.save(cube, function (err) {
            if (err) return res.status(400).send(err);

            // return cube
            res.send(cube);
        });
    },

    get : function (req, res) {
        
        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide a dataset id'})
        
        // get uuid
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id'})

        // get cube
        cubes.find(cube_id, function (err, cube) {
            if (err) return res.status(400).send({error : 'No such cube_id'}) 
            res.send(cube);
        });
    },

    add : function (req, res) {

        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide a dataset id', error_code : 1});

        // get cube_id
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id', error_code : 2});

        // get datasets
        var datasets = options.datasets;
        if (!datasets.length) return res.status(400).send({error : 'Please provide datasets', error_code : 3});

        // todo: verify correct format of datasets. add test.

        var ops = [];

        // get cube
        ops.push(function (callback) {
            cubes.find(cube_id, callback);
        });

        ops.push(function (cube, callback) {

            // add datasets to array
            datasets.forEach(function (d) {

                // mark last modified
                d.lastModified = moment().valueOf();

                // add to cube
                cube.datasets.push(d);
            });

            // mark changed
            cube.timestamp = moment().valueOf();

            // save
            cubes.save(cube, callback);
        });
           
        // run ops
        async.waterfall(ops, function (err, updated_cube) {
            if (err) return res.status(400).send({error : err.message}) 

            // return updated cube
            res.send(updated_cube);
        });
    },

    remove : function (req, res) {

        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide a dataset id', error_code : 1});

        // get cube_id
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id', error_code : 2});

        // get datasets
        var datasets = options.datasets;
        if (!datasets.length) return res.status(400).send({error : 'Please provide a dataset id', error_code : 3});

        var ops = [];

        // get cube
        ops.push(function (callback) {
            cubes.find(cube_id, callback);
        });

        ops.push(function (cube, callback) {

            // remove datasets from array
            datasets.forEach(function (d) {
                _.remove(cube.datasets, {id : d.id});
            });

            // mark changed
            cube.timestamp = moment().valueOf();

            // save
            cubes.save(cube, callback);
        });
           
        // run ops
        async.waterfall(ops, function (err, updated_cube) {
            if (err) return res.status(400).send({error : err.message}) 

            // return updated cube
            res.send(updated_cube);
        });
    },

    update : function (req, res) {

        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide a dataset id', error_code : 1});

        // get cube_id
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id', error_code : 2});

        var ops = [];

        // remove access token
        delete options.access_token;

        // get cube
        ops.push(function (callback) {
            cubes.find(cube_id, callback);
        });

        // update cube
        ops.push(function (cube, callback) {

            // add options to existing cube
            var updated_cube = _.extend(cube, options);

            // mark changed
            updated_cube.timestamp = moment().valueOf();;

            // save
            cubes.save(updated_cube, callback);
        });
           
        // run ops
        async.waterfall(ops, function (err, updated_cube) {
            if (err) return res.status(400).send({error : err.message}) 

            // return updated cube
            res.send(updated_cube);
        });
    },

    // replace datasets @ same date
    replace : function (req, res) {

        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide a dataset id', error_code : 1});

        // get cube_id
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id', error_code : 2});

        // get datasets
        var datasets = options.datasets;
        if (!datasets.length) return res.status(400).send({error : 'Please provide datasets', error_code : 3});

        // todo: verify correct format of datasets. add test.
        // todo: security: only be able to replace own cubes

        var ops = [];
        

        // get cube
        ops.push(function (callback) {
            cubes.find(cube_id, callback);
        });

        ops.push(function (cube, callback) {
            if (!cube) return callback({message : 'No such cube.'});

            // add datasets to array
            datasets.forEach(function (d) {

                // { 
                //     id: 'file_ckvuatwfkqpyzjxjpygj',
                //     description: 'Filename: snow.raster.2.200.tif',
                //     timestamp: 'Fri May 20 2016 11:33:20 GMT+0000 (UTC)',
                //     granularity: 'day',
                //     lastModified : 1479343760651
                // }

                // get moment() datestamp of dataset to add
                var datestamp = moment(d.timestamp);

                // check if dataset exists at same time, by resolution
                // todo: make this more pluggable
                options.replaceKey = options.replaceKey || 'timestamp';
                var granularity = d.granularity || 'day'; // time resolution
                var dataset_index = -1; // default

                // find dataset to replace based on replaceKey
                if (options.replaceKey == 'timestamp') {   
                             
                    dataset_index = _.findIndex(cube.datasets, function (cd) {
                        return moment(cd.timestamp).isSame(datestamp, granularity);
                    });
                
                // catch-all
                } else {
                    dataset_index = -1;
                }

                // if exists, replace
                if (dataset_index > -1) {

                    // replace dataset
                    cube.datasets[dataset_index] = d;

                } else {

                    // doesn't exist, so just add 
                    cube.datasets.push(d);
                }

                // mark lastModified on dataset
                d.lastModified = moment().valueOf();

                // mark cube changed
                cube.timestamp = moment().valueOf();
                // cube.lastModified = moment().valueOf(); // todo: rename timestamp to lastModified

            });

            // sort by sortBy key (can be a function)
            options.sortBy = function (a) {
                var sortBy = moment(a.timestamp);
                return sortBy.valueOf(); // unix time
            };
            if (options.sortBy) {
                // sort datasets by datestamp
                cube.datasets = _.sortBy(cube.datasets, options.sortBy);
            }

            // save
            cubes.save(cube, callback);

        });
           
        // run ops
        async.waterfall(ops, function (err, updated_cube) {
            if (err) return res.status(400).send({error : err.message}) 

            // return updated cube
            res.send(updated_cube);

        });
    },

    mask : function (req, res) {

        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide an options object', error_code : 2});

        // get mask
        var mask = options.mask;
        if (!mask) return res.status(400).send({error : 'Please provide a mask', error_code : 2});

        // get cube_id
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id', error_code : 2});

        // get access token
        var access_token = options.access_token;

        var ops = {};

        // get cube
        ops.cube = function (callback) {
            cubes.find(cube_id, callback);
        };


        // geojson string
        if (mask.type == 'geojson') {

            // debug: keep as geojson
            ops.mask = function (callback) {
                var prepared_mask = {
                    type : 'geojson',
                    geometry : mask.geometry,
                    // title : mask.title,
                    // description : mask.description
                    meta : mask.meta,
                    data : mask.data,
                }
                callback(null, prepared_mask);
            }

            // // convert geojson to topojson
            // ops.mask = function (callback) {

            //     // parse geojson string
            //     var collection = tools.safeParse(mask.geometry);

            //     // throw on failed parsing
            //     if (!collection) return callback({error : 'Invalid GeoJSON', error_code : 3});

            //     // convert
            //     var topology = topojson.topology({collection: collection}, {
            //         verbose : true,
            //         id : function (d) {
            //             return d.properties.ID; // hardcoded for snow! todo: add to options
            //         },
            //         'property-transform': function (feature) {
            //             return feature.properties;
            //         }
            //     });

            //     // mask to save
            //     var prepared_mask = {
            //         type : 'topojson',
            //         geometry : topology
            //     }

            //     // return topojson
            //     callback(null, prepared_mask);
            // };
           

        // topojson string
        } else if (mask.type == 'topojson') {

            // convert geojson to topojson
            ops.mask = function (callback) {

                // return topojson
                var topology = mask.geometry;

                // throw on failed parsing
                if (!topology) return callback({error : 'Invalid TopoJSON', error_code : 3});

                // mask to save
                var prepared_mask = {
                    type : 'topojson',
                    geometry : topology,
                    // title : mask.title,
                    // description : mask.description
                    meta : mask.meta,
                    data : mask.data,
                }

                // return topology
                callback(null, prepared_mask);
            };


        // mask from existing dataset
        } else if (mask.type == 'postgis-vector') {

            // convert geojson to topojson
            ops.mask = function (callback) {

                // get dataset id
                var dataset_id = mask.dataset_id;

                // sanity check dataset_id
                if (!_.isString(dataset_id) || _.size(dataset_id) < 20 || _.size(dataset_id) > 30) {
                    return callback({error : 'Invalid dataset_id', error_code : 3});
                }

                // get dataset as geojson from API
                var url = 'http://engine:3001/v2/data/geojson?dataset_id=' + dataset_id + '&access_token=' + access_token;
                request(url, function (error, response, body) {
                    if (!response || error) return callback({error : 'Unauthorized', error_code : 3});

                    // parse
                    var collection = tools.safeParse(body);

                    // verify
                    if (!collection) return callback({error : 'Invalid GeoJSON', error_code : 5});

                    // convert to topojson
                    var topology = topojson.topology({collection: collection}, {
                        verbose : true,
                        id : function (d) {
                            return d.properties.ID; // hardcoded for snow! todo: add to options
                        },
                        'property-transform': function (feature) {
                            return feature.properties;
                        }
                    });

                    // mask to save
                    var prepared_mask = {
                        type : 'topojson',
                        geometry : topology
                    }

                    // return topojson
                    callback(null, prepared_mask);

                });
            };

        // mask from raster
        } else if (mask.type == 'postgis-raster') {

            ops.mask = function (callback) {

                // get dataset id
                var dataset_id = mask.dataset_id;

                // mask to save
                var prepared_mask = {
                    type : 'postgis-raster',
                    dataset_id : dataset_id,
                    layer_id : mask.layer_id,
                    title : mask.title,
                    description : mask.description,
                    // todo: mask.meta, mask.data (see geojson mask above)
                }

                // return mask
                callback(null, prepared_mask);

            };
            
        
        // throw on non-supported mask types
        } else {
            ops.mask = function (callback) {
                callback({error : 'Mask type ' + mask.type + ' is not supported!', error_code : 3})
            };
        }

        async.series(ops, function (err, result) {
            if (err) return res.status(400).send(err);

            // get cube
            var cube = result.cube;
            var finished_mask = result.mask;

            // add data if available
            // if (options.data) finished_mask.data = options.data;

            // add mask id
            finished_mask.id = 'mask-' + tools.getRandomChars(8);

            // add timestamp to cube
            var updated_cube = _.extend(cube, {
                timestamp : moment().valueOf()
            });

            // ensure array (backwards compatibility)
            if (!_.isArray(updated_cube.masks)) {
                updated_cube.masks = (updated_cube.masks) ? [updated_cube.masks] : [];
            }

            // add mask to cube mask array
            updated_cube.masks.push(finished_mask);

            // save
            cubes.save(updated_cube, function (err, updated_cube) {
                if (err) return res.status(400).send({error : 'Failed to save Cube. Error: ' + err.message, error_code : 5});

                // return updated cube
                res.send(updated_cube);
            });

        });

    },

    unmask : function (req, res) {
        
        // get options
        var options = cubes.getBody(req);
        if (!options) return res.status(400).send({error : 'Please provide an options object', error_code : 2});

        // get cube_id
        var cube_id = options.cube_id;
        if (!cube_id) return res.status(400).send({error : 'Please provide a dataset id', error_code : 2});

        var ops = {};

        cubes.find(cube_id, function (err, cube) {

            // delete mask
            // delete cube.mask;
            _.remove(cube.mask, {
                cube_id : cube_id
            });

            // mark changed
            cube.timestamp = moment().valueOf();
 
            // save
            cubes.save(cube, function (err, updated_cube) {
                if (err) return res.status(400).send({error : 'Failed to save Cube. Error: ' + err.message, error_code : 5});

                // return updated cube
                res.send(updated_cube);
            });
        });

    },

    // cube tile requests
    tile : function (req, res) {

        // get options
        var options = cubes.getBody(req);
        var access_token = req.query.access_token;
        var cube_request = cubes.getCubeRequest(req);
        var ops = {};

        // return if erroneus request
        if (!cube_request) return pile.serveErrorTile(res);

        // find dataset
        ops.dataset = function (callback) {
            pile.getUploadStatus({
                file_id : cube_request.dataset,
                access_token : access_token
            }, callback);
        };

        // find cube
        ops.cube = function (callback) {
            cubes.find(cube_request.cube_id, callback);
        };

        // run ops
        async.parallel(ops, function (err, results) {
            if (err) return res.status(400).end(err.message);

            // get cube, dataset
            var cube = results.cube;
            var dataset = results.dataset;

            // return on error
            if (!cube || !dataset || dataset.error) return pile.serveErrorTile(res);

            // serve tile
            cubes._serveTile({
                cube : cube,
                dataset : dataset,
                cube_request : cube_request,
            }, res);
        
        });
    },

    // todo: cluster it up!
    _serveTile : function (options, res) {

        // get options
        var cube = options.cube;
        var dataset = options.dataset;
        var cube_request = options.cube_request;

        // check if tile is outside bounds if dataset
        // todo: add mask bounds also
        var outside_extent = cubes._isOutsideExtent(options);
        if (outside_extent) return pile.serveEmptyTile(res);

        // check if outside mask extent
        var outside_mask_extent = cubes._isOutsideMaskExtent(options);
        if (outside_mask_extent) {
            return pile.serveEmptyTile(res);
        }
        // create unique hash for style
        var style_hash = forge.md.md5.create().update(cube.style + cube.timestamp).digest().toHex();

        // define path
        var keyString = 'cube_tile:' + cube.cube_id + ':' + dataset.file_id + ':' + style_hash + ':' + cube_request.mask_id + ':' + cube_request.z + ':' + cube_request.x + ':' + cube_request.y + '.png';
        var tilePath = CUBEPATH + keyString;

        // check for cached tile
        fs.readFile(tilePath, function (err, tile_buffer) {
            if (!err && tile_buffer) {

                // return cached tile
                console.log('Serving cached tile');
                res.writeHead(200, {'Content-Type': pile.headers['png']});
                res.end(tile_buffer);

            } else {

                // create new tile
                cubes._createTileRenderJob({
                    tilePath : tilePath,
                    dataset : dataset,
                    cube : cube,
                    coords : {                                
                        z : cube_request.z,
                        x : cube_request.x,
                        y : cube_request.y
                    },
                    mask_id : cube_request.mask_id
                }, res);
            }
        });

    },

    _createTileRenderJob : function (options, res) {

        // create tile job
        var job = pile.jobs().create('cube_tile', { 
            options : options,
        }).priority('low').attempts(5).save();

        // cubes tile job done
        job.on('complete', function (result) {

            // serve cube tile
            cubes.serveTile(res, options.tilePath);
        });
    },

    serveTile : function (res, tilePath) {
        // read from disk
        fs.readFile(tilePath, function (err, tile_buffer) {
            res.writeHead(200, {'Content-Type': pile.headers['png']});
            res.end(tile_buffer);
        });
    },



    createTile : function (options, done) {
        var dataset = options.dataset;
        var cube = options.cube;
        var coords = options.coords;
        var mask_id = options.mask_id;
        var tilePath = options.tilePath;
        var map;
        var layer;
        var postgis;
        var bbox;
        var ops = [];


        // define settings, xml
        ops.push(function (callback) {

            var pgsql_options = {
                dbhost: 'postgis',
                dbuser: MAPIC_PGSQL_USERNAME,
                dbpass: MAPIC_PGSQL_PASSWORD
            };

            // default settings
            var default_postgis_settings = {
                user     : pgsql_options.dbuser,
                password : pgsql_options.dbpass,
                host     : pgsql_options.dbhost,
                srid     : '3857'
            }

            // set bounding box
            bbox = mercator.xyz_to_envelope(parseInt(coords.x), parseInt(coords.y), parseInt(coords.z), false);

            // insert layer settings 
            var postgis_settings = default_postgis_settings;
            postgis_settings.dbname = dataset.database_name;
            postgis_settings.asynchronous_request = true;
            postgis_settings.max_async_connection = 10;
            postgis_settings.geometry_field = 'rast';
            postgis_settings.table = dataset.table_name;
            postgis_settings.band = 1;
            postgis_settings.type = 'pgraster';
            postgis_settings.use_overviews = 'true';
            postgis_settings.clip_rasters = 'true';
            postgis_settings.prescale_rasters = 'true';

            // if mask
            if (mask_id && !_.isNull(mask_id) && !_.isUndefined(mask_id)) {

                // find mask
                var mask = _.find(options.cube.masks, function (m) {
                    return m.id == mask_id;
                });

                if (mask) {

                    // find geojson (todo: if geojson, not other type)
                    var pg_geojson = cubes._retriveGeoJSON(mask.geometry);

                    // create sql query
                    var filter_query = "(SELECT ST_Clip(rast, st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857)) as rast FROM " + dataset.table_name + " WHERE ST_Intersects(rast, st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857))) as subquery";
                    
                    // replace table with query
                    postgis_settings.table = filter_query;  

                }

            }

            // var pg_geojson = cubes._retriveGeoJSON(debug_geojson);
            // var pg_geojson = JSON.stringify(options.cube.masks[0].geometry);
            // todo: get correct mask
            // var pg_geojson = cubes._retriveGeoJSON(options.cube.masks[0].geometry);
            // var filter_query = "(SELECT A.rid FROM " + dataset.table_name + " AS A INNER JOIN st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857) AS B ON ST_Intersects(A.rast, B), LATERAL ST_ValueCount(ST_Clip(A.rast, B), 1) as t) as subquery";
            // var filter_query = "(SELECT ST_Clip(" + dataset.table_name + ", st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857)) FROM " + dataset.table_name + ") as subquery";
            // var filter_query = "(SELECT ST_Clip(" + dataset.table_name + ".rast, st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857)) FROM " + dataset.table_name + ") as subquery";
            // var filter_query = "(SELECT * from " + dataset.table_name +" WHERE ST_Intersects(rast, st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857))) as subquery";
            // works! :)
            // var filter_query = "(SELECT ST_Clip(rast, st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857)) as rast FROM " + dataset.table_name + " WHERE ST_Intersects(rast, st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857))) as subquery";
            // postgis_settings.table = filter_query;  

            try {   
                map     = new mapnik.Map(256, 256, mercator.proj4);
                layer   = new mapnik.Layer('layer', mercator.proj4);
                postgis = new mapnik.Datasource(postgis_settings);
            } catch (e) { return callback(e.message); }

            // set buffer
            map.bufferSize = 128;

            // set extent
            map.extent = bbox; // must have extent!

            // set datasource
            layer.datasource = postgis;

            // add styles
            layer.styles = ['layer']; // style names in xml
            
            // add layer to map
            map.add_layer(layer);

            // continue
            callback(null, layer);
        });

        ops.push(function (layer, callback) {

            var css = cube.style;

            if (!css) {
                console.error( 'cartoRenderer called with undefined or empty css' );
                css = "#layer {}";
            }

            var options = {
                "Stylesheet": [{
                    "id" : 'tile_style',
                    "data" : css
                }],
                "Layer" : [layer]
            }

            try  {
                // carto renderer
                var xml = new carto.Renderer().render(options);
                callback(null, xml);

            } catch (e) {
                var err = { message : 'CartoCSS rendering failed: ' + e.toString() }
                callback(err);
            }

        });

        // load xml to map
        ops.push(function (xml, callback) {
            map.fromString(xml, {strict : true}, callback);
        });

        ops.push(function (map, callback) {

            // debug write xml
            if (0) pile._debugXML(cube.cube_id, map.toXML());

            // map options
            var map_options = {
                buffer_size : 128,
            }
            
            // raster
            var im = new mapnik.Image(256, 256);

            // render
            map.render(im, map_options, callback);

        });

        ops.push(function (tile, callback) {

            // save to disk
            tile.encode(cube.quality || 'png8', function (err, buffer) {
                fs.outputFile(tilePath, buffer, function (err) {
                    callback(null, tilePath);
                });
            });

        });

        // run ops
        console.time('create cube tile');
        async.waterfall(ops, function (err, tilePath) {
            console.timeEnd('create cube tile');
            done(err, tilePath);
        });
    },


    query : function (req, res) {
        var options = req.body;
        var query_type = options.query_type;

        // snow cover fraction (raster mask)
        if (query_type == 'scf') return cubes.queries.scf(req, res);

        // snow cover fraction (geojson mask)
        if (query_type == 'scf-geojson') return snow_query.vector.geojson(req, res);


        // return unsupported
        res.status(400).send({error : 'Query type not supported:' + query_type});

    },

    queries : {

        scf_geojson : function (req, res) {

            // refactored. todo: clean up!
            return cubes.queries.scf_single_mask(req, res);

            // query values for current year based on geojson mask
            var options = req.body;
            var multi_mask = options.mask ? options.mask.multi_mask : false;

            // ensure params
            if (!options.cube_id) return res.status(400).send({error : 'Need to provide cube_id.'});


            // get cube
            cubes.find(options.cube_id, function (err, cube) {
                if (err) return res.status(400).send({error : err.message});

                // ensure mask(s)
                if (!cube || !cube.masks) return res.status(400).send({error : 'Need to provide valid cube & mask.'});

                // get mask
                var mask_id = options.mask_id;
                var mask = _.find(cube.masks, function (m) {
                    return m.id == mask_id;
                });

                res.status(400).send({error : 'debug'});

            });
        },



        // snow cover fraction query (red line in client)
        // either get query from cache, or do new query
        scf : function (req, res) {
            var options = req.body;
            var multi_mask = options.mask ? options.mask.multi_mask : false;

            // ensure params
            if (!options.cube_id) return res.status(400).send({error : 'Need to provide cube_id.'});


            // get cube
            cubes.find(options.cube_id, function (err, cube) {
                if (err) return res.status(400).send({error : err.message});

                // ensure mask
                if (!cube || !cube.mask || !cube.mask.type) return res.status(400).send({error : 'Need to provide valid cube & mask.'});

                // mask type postgis-raster
                if (cube.mask.type == 'postgis-raster') {

                    // query raster mask
                    return cubes.queries.get_raster_mask(options, function (err, query_result) {
                        if (err) return res.status(400).send(err);

                        // return results
                        res.send(query_result);
                    });

                } 

                // catch all, todo: re-implement vector mask queries
                res.status(400).send({error : 'Mask type not supported.'});

            });

        },


        get_raster_mask : function (options, done) {
            var cube_id = options.cube_id;
            var currentYearOnly = options.options.currentYearOnly;
            var filter_query = options.options.filter_query;
            var force_query = options.options.force_query;
            var year = options.year;
            var day = options.day;
            var query_type = options.query_type; // scf

            // get cube
            cubes.find(cube_id, function (err, cube) {
                if (err || !cube) return done(err || {error : 'No such cube available.'});

                // get mask id
                var mask_id = cube.mask.dataset_id;

                // check for already stored query
                var query_key = 'query_type:' + query_type + '::cube_id:' + cube_id + '::year:' + year + '::mask_id:' + mask_id;
                store.layers.get(query_key, function (err, stored_query) {

                    // return stored query
                    if (stored_query && !force_query && !err) return done(null, stored_query); 

                    // query raster mask
                    cubes.queries.query_raster_mask(options, done);

                });
            });
        },

        query_raster_mask : function (options, done) {
            var cube_id = options.cube_id;
            var currentYearOnly = options.options.currentYearOnly;
            var filter_query = options.options.filter_query;
            var force_query = options.options.force_query;
            var year = options.year;
            var day = options.day;
            var query_type = options.query_type; // scf 
            var access_token = options.access_token;
            var ops = [];
            var data = {};

            ops.push(function (callback) {
                cubes.find(cube_id, callback);
            });

            ops.push(function (cube, callback) {
                
                // remember
                data.cube = cube;

                // filter cube's datasets for this year only
                var before = moment().year(year).dayOfYear(1);
                var after = moment().year(year).dayOfYear(365);
                var range = _.filter(cube.datasets, function (d) {
                    var current = moment(d.timestamp);
                    return (current.isSameOrAfter(before) && current.isSameOrBefore(after));
                });

                // get details on all datasets
                pile.POST(pile.routes.base + pile.routes.get_datasets, {
                    datasets : range,
                    access_token : access_token,
                }, callback);

            });

            ops.push(function (datasets, callback) {

                // remember
                data.datasets = datasets;

                // store in memory
                data.query_results = [];

                // query each dataset
                async.eachSeries(datasets, function (dataset, each_callback) {

                    // filter out datasets which have not processes correctly
                    if (dataset.error_code) return each_callback();

                    // query postgis
                    cubes.queries.postgis_snowcover_raster_mask({
                        dataset : dataset,
                        mask_dataset_id : data.cube.mask.dataset_id
                    }, function (err, qr) {
                        if (err) return each_callback();

                        // store in memory
                        data.query_results.push({
                            query_result : qr,
                            dataset : dataset
                        });

                        // continue
                        each_callback();
                    });

                }, callback);

            });

            ops.push(function (callback) {

                // store
                data.query_store = [];

                data.query_results.forEach(function (q) {

                    // find full dataset
                    var timestamp_dataset = _.find(data.cube.datasets, function (d) {
                        return d.id == q.dataset.table_name;
                    });

                    // get dataset date
                    var dataset_date = timestamp_dataset ? timestamp_dataset.timestamp : null;
                    
                    // calculate avg pixel value
                    var SCF = cubes.calcSCF(q.query_result.rows);

                    // create array of correctly formatted values
                    data.query_store.push({
                        date : moment(dataset_date).format(),
                        SCF : SCF
                    });

                });

                // continue
                callback();
            });

            // run ops
            async.waterfall(ops, function (err) {

                // save
                var mask_id = data.cube.mask.dataset_id;
                var query_key = 'query_type:' + query_type + '::cube_id:' + cube_id + '::year:' + year + '::mask_id:' + mask_id;
                store.layers.set(query_key, JSON.stringify(data.query_store), function (err) {
                    done(null, data.query_store);
                });
            });
        },

        postgis_snowcover_raster_mask : function (options, done) {

            // options
            var dataset = options.dataset;
            var mask_dataset_id = options.mask_dataset_id;
            var geojson = options.mask;
            var cube = options.cube;
            var query_id = options.query_id;
            var query_num = options.query_num;

            // set postgis options
            var pg_username = MAPIC_PGSQL_USERNAME;
            var pg_password = MAPIC_PGSQL_PASSWORD;
            var pg_database = dataset.database_name;

            // set connection string
            var conString = 'postgres://' + pg_username + ':' + pg_password + '@postgis/' + pg_database;

            // initialize a connection pool
            pg.connect(conString, function(err, client, pg_done) {
                if (err) return done(err);

                // var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' A JOIN ' + mask_dataset_id+ ' B ON ST_Intersects(A.rast, B.rast), ST_ValueCount(A.rast,1) AS pvc) as t;'
                // var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' A JOIN ' + mask_dataset_id+ ' B ON ST_Intersects(A.rast, B.rast), ST_ValueCount(ST_Intersection(A.rast, B.rast, 0),1) AS pvc) as t;'
                // var query = 'select row_to_json(t) from (SELECT A.rid, B.rid, pvc, mask FROM ' + dataset.table_name + ' A JOIN ' + mask_dataset_id + ' B ON ST_Intersects(A.rast, B.rast), ST_ValueCount(A.rast,1) AS pvc, ST_ValueCount(B.rast,1) AS mask) as t;'
                // var query = "select row_to_json(t) from (SELECT rid, pvc FROM " + dataset.table_name + ", ST_ValueCount(rast,1) AS pvc WHERE st_intersects(st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857), rast)) as t;"
                // var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' A JOIN ' + mask_dataset_id+ ' B ON ST_Intersects(A.rast, B.rast), ST_ValueCount(A.rast,1) AS pvc) as t;'
                // var query = "select row_to_json(t) from (SELECT A.rid, A.pvc FROM " + dataset.table_name + " AS A, " + mask_dataset_id + " AS B, ST_ValueCount(A.rast,1) AS pvc WHERE st_intersects(A.rast, B.rast) as t;"
                // var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' AS A, ' + mask_dataset_id + ' AS B, ST_ValueCount(A.rast,1) AS pvc WHERE st_intersects(A.rast, 1, B.rast, 1)) as t;'

                var query = 'select row_to_json(t) from (SELECT A.rid, pvc FROM ' + dataset.table_name + ' AS A INNER JOIN ' + mask_dataset_id + ' AS B ON ST_Intersects(A.rast, B.rast), LATERAL ST_ValueCount(ST_Clip(A.rast,ST_Polygon(B.rast)), 1) AS pvc) as t;'

                // query postgis
                client.query(query, function(err, pg_result) {
                    pg_done();

                    // return
                    done(err, pg_result);
                });
            });
        },



        query_snow_cover_fraction_single_mask : function (options, done) {
            var datasets = options.datasets;
            var cube = options.cube;
            var mask = options.mask;
            var queryOptions;
            var n = 0;
            var query_results = [];

            // set query id
            var query_id = 'query-' + tools.getRandomChars(10);

            // query each dataset
            async.eachSeries(datasets, function (dataset, callback) {

                var timestamp_dataset = _.find(cube.datasets, function (d) {
                    return d.id == dataset.table_name;
                })
                if(!timestamp_dataset) return callback(null);
                var dataset_date = timestamp_dataset.timestamp;

                // set query options
                queryOptions = {
                    dataset : dataset,
                    query_num : n++,
                    query_id : query_id,
                    dataset_date : dataset_date, // get date of dataset in cube, not timestamp of dataset
                    mask : mask,
                }

                // create query
                cubes.queries.postgis_snowcover(queryOptions, function (err, pg_result) {
                    if (err) return callback(err);
                    
                    // get rows
                    var rows = pg_result.rows;

                    // calculate snow cover fraction
                    var averagePixelValue = cubes._getSnowCoverFraction(rows);

                    // get date from cube dataset (not from dataset internal timestamp)
                    var cubeDatasetTimestamp = queryOptions.dataset_date;

                    // results
                    var scf_results = {
                        date : moment(cubeDatasetTimestamp).format(),
                        SCF : averagePixelValue,
                        rows : rows
                    };

                    // store in memory
                    query_results.push(scf_results);

                    // callback
                    callback(null);

                });

            }, function (err) {
                done(err, query_results);
            });

        },





        postgis_snowcover : function (options, done) {

            // options
            var dataset = options.dataset;
            var geojson = options.mask;
            var cube = options.cube;
            var query_id = options.query_id;
            var query_num = options.query_num;

            // get postgis compatible geojson
            var pg_geojson = cubes._retriveGeoJSON(geojson);

            // set postgis options
            var pg_username = MAPIC_PGSQL_USERNAME;
            var pg_password = MAPIC_PGSQL_PASSWORD;
            var pg_database = dataset.database_name;

            // set connection string
            var conString = 'postgres://' + pg_username + ':' + pg_password + '@postgis/' + pg_database;

            // initialize a connection pool
            pg.connect(conString, function(err, client, pg_done) {
                if (err) return console.error('error fetching client from pool', err);

                // create query with geojson mask
                if (pg_geojson) {
                 
                    // with mask
                    var query = "select row_to_json(t) from (SELECT rid, pvc FROM " + dataset.table_name + ", ST_ValueCount(rast,1) AS pvc WHERE st_intersects(st_transform(st_setsrid(ST_geomfromgeojson('" + pg_geojson + "'), 4326), 3857), rast)) as t;"
               
                } else {
                 
                    // without mask
                    var query = "select row_to_json(t) from (SELECT rid, pvc FROM " + dataset.table_name + ", ST_ValueCount(rast,1) AS pvc ) as t;"
               
                }

                // query postgis
                client.query(query, function(err, pg_result) {
                   
                    // call `pg_done()` to release the client back to the pool
                    pg_done();

                    done(err, pg_result);
                });
            });
        },



        


       
        scf_multi_mask : function (req, res) {
            var options     = req.body;
            var query_type  = options.query_type;
            var cube_id     = options.cube_id;
            var mask_id     = options.mask ? options.mask.mask_id : false;
            var year        = options.year;
            var force_query = options.options ? options.options.force_query : false;
            var ops         = [];

            // check for already stored query
            var query_key = 'query:type' + query_type + ':' + cube_id + ':year-' + year + ':mask_id-' + mask_id;
            store.layers.get(query_key, function (err, stored_query) {
                
                // return stored query if any
                if (!err && _.size(stored_query) && !force_query) return res.end(stored_query);

                // create and run new query
                cubes.queries.create_scf_multi_mask_query(options, function (err, query) {

                    // return to client
                    res.send(query);                      

                });
            });
        },


        create_scf_multi_mask_query : function (options, done) {
            var query_type = options.query_type;
            var access_token = options.access_token;
            var cube_id = options.cube_id;
            var geometries = options.mask ? options.mask.geometries : false;
            var mask_id = options.mask ? options.mask.mask_id : false;
            var query_type = options.query_type;
            var year = options.year;
            var day = options.day;
            var ops = [];

            // get cube
            ops.push(function (callback) {
                cubes.find(cube_id, callback);
            });

            // get relevant datasets to query, from [wu]
            ops.push(function (cube, callback) {

                // get cube datasets
                var datasets = cube.datasets;

                // filter cube's datasets for this year only
                var datasets_in_range = _.filter(datasets, function (d) {
                    var current = moment(d.timestamp);
                    var before = moment().year(year).dayOfYear(1);
                    var after = moment().year(year).dayOfYear(365);
                    return (current.isSameOrAfter(before) && current.isSameOrBefore(after));
                });

                // get details on all datasets
                pile.POST(pile.routes.base + pile.routes.get_datasets, {
                    datasets : datasets_in_range,
                    access_token : access_token,
                }, function (err, dataset_details){
                    callback(err, dataset_details, cube);
                });

            });

            // fix mask
            ops.push(function (dataset_details, cube, callback) {

                var options = {
                    datasets : dataset_details,
                    cube : cube
                }

                var geometry_results = [];

                // query each geometry
                async.eachSeries(geometries, function (geom, each_callback) {

                    // create geojson from geometry
                    options.mask = cubes.geojsonFromGeometry(geom);

                    // query multiple datasets
                    cubes.queries.query_snow_cover_fraction_multi_mask(options, function (err, each_result) {

                        // remember
                        geometry_results.push(each_result);

                        // return
                        each_callback(err);

                    });
                
                }, function (err) {

                    var dates = {};

                    // iterate results per mask
                    geometry_results.forEach(function (r) {

                        // iterate
                        r.forEach(function (rr) {

                            // get date
                            var date = rr.date;

                            // sum results
                            rr.rows.forEach(function (row) {

                                // get values/count
                                var value = row.row_to_json.pvc.value;
                                var count = row.row_to_json.pvc.count;

                                // create key
                                dates[date] = dates[date] || {}; // will happen 9 times

                                // add 
                                dates[date][value] = _.isUndefined(dates[date][value]) ? count : dates[date][value] + count;

                            });

                        });
                    });

                    // calculate snow cover fraction
                    var snow_cover_fractions = cubes.queries._calculateSnowCoverFraction(dates);

                    // return scf
                    callback(err, snow_cover_fractions);

                });
               
            });

            
            async.waterfall(ops, function (err, scfs) {

                // catch errors
                if (err) return done(err);

                // save query to redis cache
                var query_key = 'query:type' + query_type + ':' + cube_id + ':year-' + year + ':mask_id-' + mask_id;
                store.layers.set(query_key, JSON.stringify(scfs), function (err) {

                    // done
                    done(null, scfs);

                });
            });

        },


        query_snow_cover_fraction_multi_mask : function (options, done) {

            var datasets = options.datasets;
            var cube = options.cube;
            var mask = options.mask;
            var queryOptions;
            var n = 0;
            var query_results = [];

            // set query id
            var query_id = 'query-' + tools.getRandomChars(10);

            // query each dataset
            async.eachSeries(datasets, function (dataset, callback) {

                // get dataset date
                var timestamp_dataset = _.find(cube.datasets, function (d) {
                    return d.id == dataset.table_name;
                })
                if(!timestamp_dataset) return callback(null);
                var dataset_date = timestamp_dataset.timestamp;

                // set query options
                queryOptions = {
                    dataset : dataset,
                    query_num : n++,
                    query_id : query_id,
                    dataset_date : dataset_date, // get date of dataset in cube, not timestamp of dataset
                    mask : mask,
                }

                // create query
                cubes.queries.postgis_snowcover(queryOptions, function (err, pg_result) {
                    
                    // get rows
                    var rows = pg_result.rows;

                    // get date from cube dataset (not from dataset internal timestamp)
                    var cubeDatasetTimestamp = queryOptions.dataset_date;

                    // results
                    var scf_results = {
                        date : moment(cubeDatasetTimestamp).format(),
                        rows : rows
                    };

                    // write results to redis
                    query_results.push(scf_results);

                    callback();

                });

            }, function (err) {

                done(err, query_results);

            });

        },


        
        _calculateSnowCoverFraction : function (all_dates) {

            // '2016-02-23T23:00:00+00:00': { 
            //     '20': 90425,
            //     '100': 13814,
            //     '101': 380,
            //     '102': 545,
            //     '103': 648,
            //     '104': 611,

            var dates = [];

            _.forEach(all_dates, function (values, date) {

                var avg_sum = 0;
                var count_sum = 0;

                _.forEach(values, function (count, pixel_value) {

                    var moved_value = pixel_value - 100;
                    
                    // only include pixels with values between 100-200
                    // if (pixel_value >= 100 && pixel_value <= 200) {
                    if (moved_value >= 0 && moved_value <= 100) {
                        // avg_sum += count * pixel_value;
                        avg_sum += count * moved_value;
                        count_sum += count;
                    }
                });

                // var scf = (avg_sum / count_sum) - 100;
                var scf = (avg_sum / count_sum);

                dates.push({
                    date : date,
                    SCF : scf
                });

            });

            return dates;

        },

       
        scf_single_mask : function (req, res) {
            var options     = req.body;
            var query_type  = options.query_type;
            var cube_id     = options.cube_id;
            // var mask_id     = options.mask ? options.mask.mask_id : false;
            var mask_id     = options.mask_id;
            var year        = options.year;
            var force_query = options.options ? options.options.force_query : false;
            var ops         = [];

            if (!mask_id) return res.status(502).send({
                error : 'Need a mask to query.'
            });

            // check for already stored query
            var query_key = 'query:type' + query_type + ':' + cube_id + ':year-' + year + ':mask_id-' + mask_id;
            store.layers.get(query_key, function (err, stored_query) {

                // return stored query if any
                if (!err && stored_query && !force_query) return res.end(stored_query);

                // create and run new query
                cubes.queries.create_scf_single_mask_query(options, function (err, query) {

                    // return to client
                    res.send(query);                      

                });
            });
        },


        create_scf_single_mask_query : function (options, done) {
            var query_type = options.query_type;
            var access_token = options.access_token;
            var cube_id = options.cube_id;
            var geometry = options.mask ? options.mask.geometry : false;
            var mask_id = options.mask ? options.mask.mask_id : false;
            var multi_mask = options.mask ? options.mask.multi : false;
            var query_type = options.query_type;
            var year = options.year;
            var day = options.day;
            var ops = [];

            // get cube
            ops.push(function (callback) {
                cubes.find(cube_id, callback);
            });

            // get relevant datasets to query, from [wu]
            ops.push(function (cube, callback) {

                // get cube datasets
                var datasets = cube.datasets;

                // filter cube's datasets for this year only
                var withinRange = _.filter(datasets, function (d) {
                    var current = moment(d.timestamp);
                    var before = moment().year(year).dayOfYear(1);
                    var after = moment().year(year).dayOfYear(365);
                    return (current.isSameOrAfter(before) && current.isSameOrBefore(after));
                });

                // get details on all datasets
                pile.POST(pile.routes.base + pile.routes.get_datasets, {
                    datasets : withinRange,
                    access_token : access_token,
                }, function (err, dataset_details){
                    callback(err, dataset_details, cube);
                });

            });

            // fix mask
            ops.push(function (dataset_details, cube, callback) {

                var options = {
                    datasets : dataset_details,
                    // mask : mask,
                    cube : cube
                }

                if (geometry == 'all') {

                    // get mask from topojson
                    var topo_mask = cube.mask;

                    // todo: add to options??
                    
                    callback(null, options);

                } else {
                    
                    // create geojson from geometry
                    options.mask = cubes.geojsonFromGeometry(geometry);

                    // continue
                    callback(null, options);
                }
               
            });

            ops.push(function (options, callback) {

                // query multiple datasets
                cubes.queries.query_snow_cover_fraction_single_mask(options, callback);
              
            });
            
            async.waterfall(ops, function (err, scfs) {

                // catch errors
                if (err) return done(err);

                // save query to redis cache
                var query_key = 'query:type' + query_type + ':' + cube_id + ':year-' + year + ':mask_id-' + mask_id;
                store.layers.set(query_key, JSON.stringify(scfs), function (err) {

                    // done
                    done(null, scfs);

                });
            });

        },




    },



    // get PostGIS query compatible GeoJSON
    // ie. return only geometry
    _retriveGeoJSON : function (geojson) {
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

    ensureFlat : function (geojson) {

        // combine features of feature collection
        // todo: may not work with multipolygons
        if (_.size(geojson.features) > 1 && geojson.type == 'FeatureCollection') {
            geojson.features = [cubes.mergePolygons(geojson)];
        }
        return geojson.features;
    },

    // merge multifeatured polygon into flat polygon
    // ---------------------------------------------
    // geojson can be uploaded with multiple features, they are merged here...
    // 
    // see https://github.com/Turfjs/turf/blob/393013ff3f24c71fb7dd9dac99435271d94c0e06/CHANGELOG.md#301
    // and http://morganherlocker.com/post/Merge-a-Set-of-Polygons-with-turf/
    mergePolygons : function (polygons) {
        var merged = _.clone(polygons.features[0]);
        var features = polygons.features;
        for (var i = 0, len = features.length; i < len; i++) {
            var poly = features[i];
            if (poly.geometry) merged = turf_union(merged, poly);
        }
        return merged;
    },

    calcSCF : function (rows) {

        var dump_values = 0.0;
        var dump_count = 0.0;

        // get values, count
        rows.forEach(function (r) {

            var rid = r.row_to_json.rid;
            var data = r.row_to_json.pvc; // {"value":156,"count":3}
            var value = parseFloat(data.value);
            var count = parseFloat(data.count);


            // only include values between 101-200
            if (value >= 100 && value <= 200) {
                dump_count += parseFloat(count);
                dump_values += parseFloat(count) * parseFloat(value);
            } 
        });

        // calculate average
        var average = parseFloat(dump_values) / parseFloat(dump_count);
        var scf = average - 100; // to get %

        return scf;

    },


    _getSnowCoverFraction : function (rows) {

        // clean up 
        var pixelValues = {};

        // get values, count
        rows.forEach(function (r) {


            var data = r.row_to_json.pvc; // {"value":156,"count":3}
            var value = data.value;
            var count = data.count;

            // only include values between 101-200
            if (value >= 100 && value <= 200) {
                if (pixelValues[value]) {
                    pixelValues[value] += count;
                } else {
                    pixelValues[value] = count;
                }
            }
        });

        // sum averages
        var avg_sum = 0;
        var tot_count = 0;
        _.forEach(pixelValues, function (p, v) {
            avg_sum += p * v;
            tot_count += p;
        });

        // calculate average
        var average = avg_sum / tot_count;
        var scf = average - 100; // to get %

        return scf;

    },

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

    // save cube to redis
    save : function (cube, done) {
        store.layers.set(cube.cube_id, JSON.stringify(cube), function (err) {
            done(err, cube);
        });
    },      
    // get cube from redis
    find : function (cube_id, done) {
        store.layers.get(cube_id, function (err, cubeJSON) {
            if (err) return done(err);
            var cube = tools.safeParse(cubeJSON);
            if (!cube) return done('Failed to parse cube:', cubeJSON);
            done(null, cube);
        });
    },
    // get query or body
    getBody : function (req) {
        if (!_.isEmpty(req.body)) return req.body;
        if (!_.isEmpty(req.query)) return req.query;
        return false;
    },
    // get cube request from params
    getCubeRequest : function (req) {
        try {
            var params = req.params['0'].split('/');
            var cube_request = {
                cube_id : params[0],
                dataset : params[1],
                z : params[2],
                x : params[3],
                y : params[4].split('.')[0],
                mask_id : req.query.mask_id || null
            }
            return cube_request;
        } catch (e) { return false; };
    },

    _isOutsideMaskExtent : function (options) {

        var cube = options.cube;
        var cube_request = options.cube_request;
        var mask_id = cube_request.mask_id;

        // return false if no mask
        if (!mask_id || _.isNull(mask_id) || _.isUndefined(mask_id)) return false;

        var mask = _.find(cube.masks, function (m) {
            return m.id == mask_id;
        });

        // return false if no mask
        if (!mask) return false;

        options.mask_geojson = mask.geometry;

         
        try {

        // get options
        var outside = false;
        var dataset = options.dataset;
        var coords = options.cube_request;
        var metadata = tools.safeParse(dataset.metadata);

        // get extents
        var bounding_box = mercator.xyz_to_envelope(parseInt(coords.x), parseInt(coords.y), parseInt(coords.z), false);
        var raster_extent_latlng = geojsonExtent(options.mask_geojson);
        
        // add 1 degree padding (due to geojson bbox cutting a bit short)
        var padding = 0.5;
        raster_extent_latlng[0] -= padding;
        raster_extent_latlng[1] -= padding;
        raster_extent_latlng[2] += padding;
        raster_extent_latlng[3] += padding;

        var south_west_corner = Conv.ll2m(raster_extent_latlng[0], raster_extent_latlng[1]);
        var north_east_corner = Conv.ll2m(raster_extent_latlng[2], raster_extent_latlng[3]);

        // tile is outside raster bounds if:
        // - - - - - - - - - - - - - - - - - 
        // tile-north is south of raster-south  (tile_north < raster_south)
        // OR
        // tile-east is west of raster-west     (tile-east  < raster-west)
        // OR
        // tile-south is north of raster-north  (tile-south > raster-north)
        // OR
        // tile-west is east of raster-east,    (tile-west  > raster-east)
        
        var raster_bounds = {
            west    : south_west_corner.x,
            south   : south_west_corner.y,
            east    : north_east_corner.x,
            north   : north_east_corner.y
        };

        var tile_bounds = {
            west    : bounding_box[0],
            south   : bounding_box[1],
            east    : bounding_box[2],
            north   : bounding_box[3]
        };

        // check if outside extent
        if (tile_bounds.north < raster_bounds.south)    outside = true;
        if (tile_bounds.east  < raster_bounds.west)     outside = true;
        if (tile_bounds.south > raster_bounds.north)    outside = true;
        if (tile_bounds.west  > raster_bounds.east)     outside = true;

        } catch (e) {}

        return outside;

    },

    _isOutsideExtent : function (options) {
        
        try {

        // get options
        var dataset = options.dataset;
        var coords = options.cube_request;
        var metadata = tools.safeParse(dataset.metadata);

        // get extents
        var extent_geojson = metadata.extent_geojson;
        var bounding_box = mercator.xyz_to_envelope(parseInt(coords.x), parseInt(coords.y), parseInt(coords.z), false);
        var raster_extent_latlng = geojsonExtent(extent_geojson);
        var south_west_corner = Conv.ll2m(raster_extent_latlng[0], raster_extent_latlng[1]);
        var north_east_corner = Conv.ll2m(raster_extent_latlng[2], raster_extent_latlng[3]);


        // tile is outside raster bounds if:
        // - - - - - - - - - - - - - - - - - 
        // tile-north is south of raster-south  (tile_north < raster_south)
        // OR
        // tile-east is west of raster-west     (tile-east  < raster-west)
        // OR
        // tile-south is north of raster-north  (tile-south > raster-north)
        // OR
        // tile-west is east of raster-east,    (tile-west  > raster-east)
        
        var raster_bounds = {
            west    : south_west_corner.x,
            south   : south_west_corner.y,
            east    : north_east_corner.x,
            north   : north_east_corner.y
        };

        var tile_bounds = {
            west    : bounding_box[0],
            south   : bounding_box[1],
            east    : bounding_box[2],
            north   : bounding_box[3]
        };

        // check if outside extent
        var outside = false;
        if (tile_bounds.north < raster_bounds.south)    outside = true;
        if (tile_bounds.east  < raster_bounds.west)     outside = true;
        if (tile_bounds.south > raster_bounds.north)    outside = true;
        if (tile_bounds.west  > raster_bounds.east)     outside = true;

        } catch (e) {
            console.log('e:', e);
            var outside = false;    
        }

        return outside;
    },



}



// http://wiki.openstreetmap.org/wiki/Mercator#JavaScript
var Conv=({
    r_major : 6378137.0,//Equatorial Radius, WGS84
    r_minor : 6356752.314245179,//defined as constant
    f : 298.257223563,//1/f=(a-b)/a , a=r_major, b=r_minor
    deg2rad : function(d) {
        var r=d*(Math.PI/180.0);
        return r;
    },
    rad2deg : function(r) {
        var d=r/(Math.PI/180.0);
        return d;
    },
    ll2m : function(lon,lat) { //lat lon to mercator
    
        //lat, lon in rad
        var x=this.r_major * this.deg2rad(lon);
        if (lat > 89.5) lat = 89.5;
        if (lat < -89.5) lat = -89.5;
        var temp = this.r_minor / this.r_major;
        var es = 1.0 - (temp * temp);
        var eccent = Math.sqrt(es);
        var phi = this.deg2rad(lat);
        var sinphi = Math.sin(phi);
        var con = eccent * sinphi;
        var com = .5 * eccent;
        var con2 = Math.pow((1.0-con)/(1.0+con), com);
        var ts = Math.tan(.5 * (Math.PI*0.5 - phi))/con2;
        var y = 0 - this.r_major * Math.log(ts);
        var ret={'x':x,'y':y};
        return ret;
    },
    m2ll : function(x,y) {//mercator to lat lon
        var lon=this.rad2deg((x/this.r_major));
        var temp = this.r_minor / this.r_major;
        var e = Math.sqrt(1.0 - (temp * temp));
        var lat=this.rad2deg(this.pj_phi2( Math.exp( 0-(y/this.r_major)), e));
        var ret={'lon':lon,'lat':lat};
        return ret;
    },
    pj_phi2 : function(ts, e) {
        var N_ITER=15;
        var HALFPI=Math.PI/2;
        var TOL=0.0000000001;
        var eccnth, Phi, con, dphi;
        var i;
        var eccnth = .5 * e;
        Phi = HALFPI - 2. * Math.atan (ts);
        i = N_ITER;
        do 
        {
            con = e * Math.sin (Phi);
            dphi = HALFPI - 2. * Math.atan (ts * Math.pow((1. - con) / (1. + con), eccnth)) - Phi;
            Phi += dphi;
        } 
        while ( Math.abs(dphi)>TOL && --i);
        return Phi;
    }
});
