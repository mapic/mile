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
var mongoose = require('mongoose');
var request = require('request');
var exec = require('child_process').exec;
var pg = require('pg');
var gm = require('gm');
var sanitize = require("sanitize-filename");
var mercator = require('./sphericalmercator');
var geojsonArea = require('geojson-area');
var crypto = require('crypto');
var https = require('https');
var geojsonExtent = require('geojson-extent');
var proj4 = require('proj4');
const os = require('os')
const util = require('util')
var AWS = require('aws-sdk');

var turf = {};
turf.booleanOverlap = require('@turf/boolean-overlap');
turf.bboxPolygon = require('@turf/bbox-polygon');
turf.projection = require('@turf/projection');
turf.intersect = require('@turf/intersect');
turf.difference = require('@turf/difference');
turf.booleanWithin = require('@turf/boolean-within');
turf.transformScale = require('@turf/transform-scale');
turf.bbox = require('@turf/bbox');

// modules
// global.config = require('../config.js');
var server = require('./server');
var store  = require('./store');
var proxy = require('./proxy');
var tools = require('./tools');
var queries = require('./queries');
var cubes = require('./cubes');

// register mapnik plugins
mapnik.register_default_fonts();
mapnik.register_default_input_plugins();

console.log('Mapnik version: ', mapnik.version);

// global paths (todo: move to config)
var VECTORPATH   = '/data/vector_tiles/';
var RASTERPATH   = '/data/raster_tiles/';
var GRIDPATH     = '/data/grid_tiles/';
var PROXYPATH    = '/data/proxy_tiles/';

// var MAPIC_PGSQL_USERNAME = 'systemapic';
// var MAPIC_PGSQL_PASSWORD = 'docker';

// var pgsql_options = {
//     dbhost: 'postgis',
//     dbuser: MAPIC_PGSQL_USERNAME,
//     dbpass: MAPIC_PGSQL_PASSWORD
// };

var MAPIC_POSTGIS_HOST = process.env.MAPIC_POSTGIS_HOST;
var MAPIC_POSTGIS_USERNAME = process.env.MAPIC_POSTGIS_USERNAME;
var MAPIC_POSTGIS_PASSWORD = process.env.MAPIC_POSTGIS_PASSWORD;


var pgsql_options = {
    dbhost: MAPIC_POSTGIS_HOST,
    dbuser: MAPIC_POSTGIS_USERNAME,
    dbpass: MAPIC_POSTGIS_PASSWORD
};


var debug = false;

module.exports = mile = { 

    // config : global.config,
    cubes : cubes,

    // todo: move to routes, or share with wu somehow (get routes by querying wu API?)
    routes : {
        base : 'http://engine:3001',
        upload_status : '/v2/data/status',
        create_dataset : '/v2/data/create',
        get_datasets : '/v2/data/several',
    },

    headers : {
        jpeg : 'image/jpeg',
        png : 'image/png',
        pbf : 'application/x-protobuf',
        grid : 'application/json'
    },

    proxyProviders : ['google', 'norkart'],

    fetchDataArea : queries.fetchDataArea,
    fetchData : queries.fetchData,
    fetchHistogram : queries.fetchHistogram,
    getVectorPoints : queries.getVectorPoints,
    fetchRasterDeformation : queries.fetchRasterDeformation,
    queryRasterPoint : queries.queryRasterPoint,
    
    jobs : function () {
        return jobs;
    },

    // entry point for GET /v2/tiles/*
    getTileEntryPoint : function (req, res) {

        // pipe to postgis or proxy
        if (tools.tileIsProxy(req))   return mile.serveProxyTile(req, res);
        if (tools.tileIsPostgis(req)) return mile.serveTile(req, res);

        // tile is neither proxy or postgis formatted
        // todo: error handling
        res.end(); 
    },

    serveTile : function (req, res) {

        // parse url into layerUuid, zxy, type
        var parsed = req._parsedUrl.pathname.split('/');
        var params = {
            layerUuid : parsed[3],
            z : parseInt(parsed[4]),
            x : parseInt(parsed[5]),
            y : parseInt(parsed[6].split('.')[0]),
            type : parsed[6].split('.')[1],
        };
        var map;
        var layer;
        var postgis;
        var bbox;
        var type = params.type;
        var start_time = new Date().getTime();
        var ops = [];

        // force render flag
        params.force_render = req.query.force_render || false;

        // add access token to params
        params.access_token = req.query.access_token || req.body.access_token;

        // get stored layer from redis
        store.layers.get(params.layerUuid, function (err, storedLayerJSON) {    
            if (err) return mile.tileError(res, err);
            if (!storedLayerJSON) return mile.tileError(res, 'No stored layer.');

            // parse layer JSON
            var storedLayer = tools.safeParse(storedLayerJSON);

            // get tiles
            if (type == 'pbf') ops.push(function (callback) {
                mile.getVectorTile(params, storedLayer, callback);
            });

            if (type == 'png') ops.push(function (callback) {
                mile.getRasterTile(params, storedLayer, callback);
            });

            if (type == 'grid') ops.push(function (callback) {
                mile.getGridTile(params, storedLayer, callback);
            });


            // run ops
            async.series(ops, function (err, data) {

                if (err) {
                    debug && console.error({
                        err_id : 2,
                        err_msg : 'serve tile',
                        error : err,
                        stack : err.stack
                    });

                    // return png for raster-tile requests
                    if (type == 'png') return mile.serveEmptyTile(res);
                    
                    // return empty
                    return res.json({});
                }

                // log tile request
                var end_time = new Date().getTime();
                var create_tile_time = end_time - start_time;
                debug && console.log({
                    z : params.z,
                    x : params.x,
                    y : params.y,
                    format : type,
                    layer_id : params.layerUuid,
                    render_time : create_tile_time
                });

                // return vector tiles gzipped
                if (type == 'pbf') {
                    res.writeHead(200, {
                        'Content-Type': mile.headers[type], 
                        'Content-Encoding': 'gzip',
                        'Cache-Control' : 'private, max-age=3600'
                    });
                    return zlib.gzip(data[0], function (err, zipped) { res.end(zipped); });
                }

                // return tile to client
                res.writeHead(200, {'Content-Type': mile.headers[type]});
                res.end(data[0]);
            });
        });
    },

    serveProxyTile : function (req, res) {

        proxy.serveProxyTile(req, res);
        

        // // parse url, set options
        // var params = req.params[0].split('/');
        // var options = {
        //     provider : params[0],
        //     type     : params[1],
        //     z        : params[2],
        //     x        : params[3],
        //     y        : params[4].split('.')[0],
        //     format   : params[4].split('.')[1]
        // }

        // proxy._serveTile(options, function (err) {
        //     proxy.serveTile(res, options);
        // });

    },

    // this layer is only a postgis layer. a Wu Layer Model must be created by client after receiving this postgis layer
    createLayer : function (req, res) {
        var options = req.body;
        var file_id = options.file_id;
        var sql = options.sql;
        var cartocss = options.cartocss;
        var cartocss_version = options.cartocss_version;
        var geom_column = options.geom_column;
        var geom_type = options.geom_type;
        var raster_band = options.raster_band;
        var srid = options.srid;
        var affected_tables = options.affected_tables;
        var interactivity = options.interactivity;
        var attributes  = options.attributes;
        var access_token = req.body.access_token;
        var ops = [];

        // log to file
        console.log({
            type : 'createLayer',
            options : options
        });

        // verify query
        if (!file_id) return mile.error.missingInformation(res, 'Please provide a file_id.')

        // get upload status
        ops.push(function (callback) {

            // get upload status object from wu
            mile.getUploadStatus({
                file_id : file_id,
                access_token : access_token
            }, callback);
        });


        // verify upload status
        ops.push(function (upload_status, callback) {
            if (!upload_status) return callback('No such upload_status.');

            // ensure data was processed succesfully
            var error_message = 'The data is not done processing yet. Please try again in a little while.';
            if (!upload_status.processing_success) return callback(error_message);

            // ensure data is raster or vector type
            var error_message = 'Invalid data_type: ' +  upload_status.data_type;
            if (upload_status.data_type != 'vector' && upload_status.data_type != 'raster') return callback(error_message);

            // verified, continue
            callback(null, upload_status);
        });
        

        // create tileserver layer
        ops.push(function (upload_status, callback) {

            mile._createPostGISLayer({
                upload_status : upload_status,
                requested_layer : options
            }, callback);
        });

        // run ops
        async.waterfall(ops, function (err, layerObject) {
            if (err) {
                console.error({
                    err_id : 30,
                    err_msg : 'create layer',
                    error : err,
                    stack : err.stack
                });
                return res.json({error : err.toString() });
            }

            // return layer to client
            res.json(layerObject);
        });
    },

    // shorthand
    asyncDone : function (err, result) {
        console.log('async done:', err, result);
    },


    /**
    * @function
    * Vectorize a raster
    * @param req
    * @param res
    * @arg file_id (req.body.file_id)
    */
    vectorizeDataset : function (req, res) {
        var options = req.body;
        var access_token = options.access_token;
        var file_id = options.file_id;
        var raster_upload_status;
        var vector_upload_status;
        var ops = [];

        ops.push(function (callback) {
            mile.getUploadStatus({
                file_id : file_id,
                access_token : access_token
            }, callback);
        });

        ops.push(function (upload_status, callback) {

            // remember
            raster_upload_status = upload_status;

            // create upload status
            vector_upload_status = _.clone(raster_upload_status);
            vector_upload_status.data_type = 'vector';
            vector_upload_status.file_id = 'file_' + tools.getRandomChars(20);
            vector_upload_status.status = 'Processing';
            vector_upload_status.timestamp = new Date().getTime();
            vector_upload_status.processing_success = false; // reset

            mile.setUploadStatus({
                access_token : access_token,
                upload_status : vector_upload_status
            }, function (err) {
                res.send(err || vector_upload_status);
                callback(err);
            });
        });

        ops.push(function (callback) {

            // vectorize raster
            mile.vectorizeRaster({
                raster_upload_status : raster_upload_status,
                vector_upload_status : vector_upload_status,
                access_token : access_token
            }, callback);
        });

        async.waterfall(ops, mile.asyncDone);

    },

    vectorizeRaster : function (data, done) {

        var ops = {};
        var raster_upload_status = data.raster_upload_status;
        var vector_upload_status = data.vector_upload_status;
        var access_token = data.access_token;
        var database_name = raster_upload_status.database_name;
        var raster_table_name = raster_upload_status.table_name;
        var vectorized_raster_file_id = vector_upload_status.file_id;
        var metadata = {};

        // vectorize
        ops.query = function (callback) {

            // TODO: `val` is custom value, need to find name of column in raster
            var column = 'val';

            // TODO: improve this vectorization.. it's SLOW. @strk
            var query = 'SELECT ' + column + ', geom INTO ' + vectorized_raster_file_id + ' FROM (SELECT (ST_DumpAsPolygons(rast)).* FROM ' + raster_table_name + ') As foo ORDER BY ' + column + ';';
            
            queries.postgis({
                postgis_db : database_name,
                query : query
            }, callback);
        };

        // add the_geom_3857
        ops.prime = function (callback) {

            queries.primeTableGeometry({
                file_id : vectorized_raster_file_id,
                database_name : database_name
            }, callback)
        };

        // get min/max of all fields
        ops.columns = function (callback) {

            // get columns
            var query = 'SELECT * FROM ' + vectorized_raster_file_id + ' LIMIT 1';
            queries.postgis({
                postgis_db : database_name,
                query : query
            }, function (err, results) {

                var min_max_values = {};
                var jobs = [];
                var fields = results.fields;
                var columns = [];


                fields.forEach(function (f) {
                    if (f.name != 'geom' && f.name != 'the_geom_3857') {
                        columns.push(f.name);
                    }
                });

                columns.forEach(function (column) {

                    // set default
                    min_max_values[column] = {
                        min : 0,
                        max : 0
                    };

                    jobs.push(function (done) {

                        // get min/max/avg values for columns
                        var query = 'select row_to_json(t) from (select MAX(' + column + '), MIN(' + column + '), AVG(' + column + ') from ' + vectorized_raster_file_id + ') t;';
                        queries.postgis({
                            postgis_db : database_name,
                            query : query
                        }, function (err, results) {
                            if (err) return done(err);

                            var data = results.rows[0].row_to_json;
                            min_max_values[column] = data;
                            done(null);
                        });
                    }); 
                });


                async.parallel(jobs, function (err, values) {
                    min_max_values._columns = columns;
                    metadata.columns = min_max_values;
                    callback(null);
                });
            });
        };


        // create upload status
        ops.status = function (callback) {

            var temp_meta = tools.safeParse(vector_upload_status.metadata);
            temp_meta.columns = metadata.columns;

            var upload_status = vector_upload_status;
            upload_status.data_type = 'vector';
            upload_status.table_name = vectorized_raster_file_id;
            upload_status.status = 'Done';
            upload_status.processing_success = true;
            upload_status.processing_took_ms = (new Date().getTime() - upload_status.timestamp);
            upload_status.metadata = JSON.stringify(temp_meta);
            upload_status.sql = '(SELECT * FROM ' + vectorized_raster_file_id + ') as sub';
            upload_status.debug_2 = 'mile vectorizeRaster';

            var options = {
                access_token : access_token,
                upload_status : upload_status
            }

            mile.setUploadStatus(options, callback);
        };
        
        async.series(ops, function (err, results) {

            done(err, {
                upload_status : results.status
            });
        });
    },

    _createPostGISLayer : function (options, done) {


        // -----------------------------------------------------------
        //      upload_status
        // -----------------------------------------------------------
        // { 
        //  file_id: 'file_incluvknxcojauozeucv',
        //  user_id: 'user-0eec3893-3ac0-4d97-9cf2-694a20cbd5d6',
        //  filename: 'Akersvatn (1).tar.gz',
        //  timestamp: 1456612911816,
        //  status: 'Done',
        //  size: 2664853,
        //  upload_success: true,
        //  error_code: null,
        //  error_text: null,
        //  processing_success: true,
        //  rows_count: '14874',
        //  import_took_ms: 1174,
        //  data_type: 'vector',
        //  original_format: null,
        //  table_name: 'file_incluvknxcojauozeucv',
        //  database_name: 'vkztdvcqkm',
        //  uniqueIdentifier: '2664853-1455124339000-user-0eec3893-3ac0-4d97-9cf2-694a20cbd5d6-Akersvatn (1).tar.gz',
        //  default_layer: null,
        //  default_layer_model: null,
        //  metadata: '{"extent":  // ... '}' 
        // }

        // -----------------------------------------------------------
        //      requested_layer
        // -----------------------------------------------------------
        // { 
        //  geom_column: 'the_geom_3857',
        //  geom_type: 'geometry',
        //  raster_band: '',
        //  srid: '',
        //  affected_tables: '',
        //  interactivity: '',
        //  attributes: '',
        //  access_token: 'pk.8FhhB90ax6KkQmoK0AMePd0R6IlkxM4VAGewsXw8',
        //  cartocss_version: '2.0.1',
        //  cartocss: '@point_opacity: 1;\n@marker_size_factor: 2;\n[zoom<10] { marker-width: 0.2 * @marker_size_factor; }\n[zoom=10] { marker-width: 0.3 * @marker_size_factor; }\n[zoom=11] { marker-width: 0.5 * @marker_size_factor; }\n[zoom=12] { marker-width: 1   * @marker_size_factor; }\n[zoom=13] { marker-width: 1   * @marker_size_factor; }\n[zoom=14] { marker-width: 2   * @marker_size_factor; }\n[zoom=15] { marker-width: 4   * @marker_size_factor; }\n[zoom=16] { marker-width: 6   * @marker_size_factor; }\n[zoom=17] { marker-width: 8   * @marker_size_factor; }\n[zoom>=18] { marker-width: 12  * @marker_size_factor; }\n\n#layer {\n\n\tmarker-allow-overlap: true;\n\tmarker-clip: false;\n\tmarker-comp-op: screen;\n\n\tmarker-opacity: @point_opacity;\n\n\tmarker-fill: #12411d;\n\n}',
        //  sql: '(SELECT * FROM file_incluvknxcojauozeucv \nwhere coherence > 0.8\nand coherence < 1) as sub',
        //  file_id: 'file_incluvknxcojauozeucv',
        //  return_model: true,
        //  layerUuid: 'layer-4d2ad916-a9e5-4e01-8b9c-dd8e21ae3c57' 
        // }

        var defaultLayer = {
            geom_column: 'the_geom_3857',
            geom_type: 'geometry',
            raster_band: '',
            srid: '',
            affected_tables: '',
            interactivity: '',
            attributes: '',
            cartocss_version: '2.0.1',
            return_model: true,
        }


        var upload_status = options.upload_status;
        var requested_layer = options.requested_layer; // previously opts.options
        var file_id = requested_layer.file_id;
        var sql = requested_layer.sql;
        var cartocss = requested_layer.cartocss;
        var cartocss_version = requested_layer.cartocss_version;
        var geom_column = requested_layer.geom_column;
        var geom_type = requested_layer.geom_type;
        var raster_band = requested_layer.raster_band;
        var srid = requested_layer.srid;
        var affected_tables = requested_layer.affected_tables;
        var interactivity = requested_layer.interactivity;
        var attributes = requested_layer.attributes;
        var access_token = requested_layer.access_token;
        var data_type = requested_layer.data_type || upload_status.data_type;
        var ops = [];

       
        if (data_type == 'raster') {

            // raster debug
            var defaultCartocss = '';
            defaultCartocss += '#layer {'
            defaultCartocss += 'raster-opacity: 1; '; 
            // defaultCartocss += 'raster-scaling: gaussian; '; 
            defaultCartocss += 'raster-colorizer-default-mode: linear; '; 
            defaultCartocss += 'raster-colorizer-default-color: transparent; '; 
            defaultCartocss += 'raster-colorizer-stops: '; 
            
            // white to blue
            defaultCartocss += '  stop(20, rgba(0,0,0,0)) '; 
            defaultCartocss += '  stop(21, #dddddd) '; 
            defaultCartocss += '  stop(200, #0078ff) '; 
            defaultCartocss += '  stop(255, rgba(0,0,0,0), exact); '; 
            defaultCartocss += 'raster-comp-op: color-dodge;';
            defaultCartocss += ' }';
            
            // set cartocss
            cartocss = cartocss || defaultCartocss; 
        }

        // ensure mandatory fields
        if (!sql) return done(new Error('Please provide a SQL statement.'))
        if (!cartocss) return done(new Error('Please provide CartoCSS.'))

        ops.push(function (callback) {

            // inject table name into sql
            var done_sql = sql.replace('table', upload_status.table_name);

            // create layer object
            var layer_id = 'layer_id-' + uuid.v4();
            var layer = {   

                layerUuid : layer_id,
                options : {         
                    
                    // required
                    layer_id         : layer_id,
                    sql              : done_sql,
                    cartocss         : cartocss,
                    file_id          : file_id,     
                    database_name    : upload_status.database_name, 
                    table_name       : requested_layer.table_name || upload_status.table_name, 
                    metadata         : upload_status.metadata,
                    data_type        : requested_layer.data_type || upload_status.data_type || 'vector',

                    // optional                             // defaults
                    geom_column      : geom_column      || 'the_geom_3857',
                    geom_type        : geom_type        || 'geometry',
                    raster_band      : raster_band      || 0,
                    srid             : srid             || 3857,
                    cartocss_version : cartocss_version || '2.0.1',
                }
            }

            callback(null, layer);
        });

        // get extent of file (todo: put in file object)
        ops.push(function (layer, callback) {
            
            // todo: move to queries.js

            // debug!
            return callback(null, layer); // debug!!

            var GET_EXTENT_SCRIPT_PATH = 'src/get_st_extent.sh';

            // ensure mandatory fields
            if (!layer.options.database_name) return callback(new Error("Unknown database_name in layer options"));
            if (!layer.options.table_name) return callback(new Error("Unknown table_name in layer options"));

            // st_extent script 
            var command = [
                GET_EXTENT_SCRIPT_PATH,     // script
                layer.options.database_name,    // database name
                layer.options.table_name,       // table name
                layer.options.geom_column,  // geometry column
            ].join(' ');


            // create database in postgis
            exec(command, {maxBuffer: 1024 * 50000}, function (err, stdout, stdin) {
                if (err) return callback(new Error(stdout));

                // parse stdout
                try { var extent = stdout.split('(')[1].split(')')[0]; } 
                catch (e) { return callback(e); }

                // set extent
                layer.options.extent = extent;

                // callback
                callback(null, layer);
            });
        });


        // save layer to store.redis
        ops.push(function (layer, callback) {

            // save layer to store.redis
            store.layers.set(layer.layerUuid, JSON.stringify(layer), function (err) {
                if (err) console.error({
                    err_id : 1,
                    err_msg : 'create postgis layer',
                    error : err
                });
                callback(err, layer);
            });
        });

        // layer created, return
        async.waterfall(ops, done);
    },
    
    // get layer from redis and return
    getLayer : function (req, res) {

        // get layerUuid
        var layerUuid = req.body.layerUuid || req.query.layerUuid;
        if (!layerUuid) return mile.error.missingInformation(res, 'Please provide layerUuid.');

        // retrieve layer and return it to client
        store.layers.get(layerUuid, function (err, layer) {
            if (err) console.error({
                err_id : 21,
                err_msg : 'get layer error',
                error : err
            });
            res.end(layer);
        });
    },

    // helper for tile error handling
    tileError : function (res, err) {
        if (err) console.error({
            err_id : 60,
            err_msg : 'get tile error handler',
            error : err
        });
        res.end();
    },

    // create vector tile from postgis
    createVectorTile : function (params, storedLayer, done) {
        mile._renderVectorTile(params, function (err) {
            if (err) return done(err);
            store._readVectorTile(params, done);
        });
    },

    // create raster tile from postgis
    createRasterTile : function (params, storedLayer, done) {
         mile._renderRasterTile(params, function (err) {
         // mile._renderRasterTileLegacy(params, function (err) {
            if (err) return done(err);

            // tile is now in S3 (or disk, etc.)
            store._readRasterTile(params, done);
        });
    },

    // create grid tile from postgis
    createGridTile : function (params, storedLayer, done) {
         mile._renderGridTile(params, function (err) {
            if (err) return done(err);
            store.getGridTile(params, done);
        });
    },

    serveErrorTile : function (res) {
        var errorTile = 'public/errorTile.png';
        fs.readFile('public/noAccessTile.png', function (err, tile) {
            res.writeHead(200, {'Content-Type': 'image/png'});
            res.end(tile);
        });
    },

    serveEmptyTile : function (res) {
        console.log('Serving empty tile');
        fs.readFile('public/nullTile.png', function (err, tile) {
            res.writeHead(200, {'Content-Type': 'image/png'});
            res.end(tile);
        });
    },

    _renderVectorTile : function (params, done) {

        // parse url into layerUuid, zxy, type
        var ops = [];
        var map;
        var layer;
        var postgis;
        var bbox;

        // check params
        if (!params)                return done('Invalid url: Missing params.');
        if (!params.layerUuid)      return done('Invalid url: Missing layerUuid.');
        if (params.z == undefined)  return done('Invalid url: Missing tile coordinates. z', params.z);
        if (params.x == undefined)  return done('Invalid url: Missing tile coordinates. x', params.x);
        if (params.y == undefined)  return done('Invalid url: Missing tile coordinates. y', params.y);
        if (!params.type)           return done('Invalid url: Missing type extension.');


        // look for stored layerUuid
        ops.push(function (callback) {
            store.layers.get(params.layerUuid, callback);
        });

        // define settings, xml
        ops.push(function (storedLayer, callback) {
            if (!storedLayer) return callback('No such layerUuid.');

            var storedLayer = tools.safeParse(storedLayer);

            // default settings
            var default_postgis_settings = {
                user        : pgsql_options.dbuser,
                password    : pgsql_options.dbpass,
                host        : pgsql_options.dbhost,
                type        : 'postgis',
                geometry_field  : 'the_geom_3857',
                srid        : '3857'
            }

            // set bounding box
            bbox = mercator.xyz_to_envelope(parseInt(params.x), parseInt(params.y), parseInt(params.z), false);

            // insert layer settings 
            var postgis_settings = default_postgis_settings;
            postgis_settings.dbname = storedLayer.options.database_name;
            postgis_settings.table = storedLayer.options.sql;
            postgis_settings.extent = storedLayer.options.extent || bbox;
            postgis_settings.geometry_field = storedLayer.options.geom_column;
            postgis_settings.srid = storedLayer.options.srid;
            postgis_settings.max_async_connection = 6;
            postgis_settings.simplify_geometries = true; // no effect :(
            postgis_settings.simplify_clip_resolution = 3.0;

            // everything in spherical mercator (3857)! ... 
            // mercator.proj4 == 3857 == +proj=merc +a=6378137 +b=6378137 +lat_ts=0.0 +lon_0=0.0 +x_0=0.0 +y_0=0 +k=1.0 +units=m +nadgrids=@null +wktext +no_defs +over
            try {   
                map = new mapnik.Map(256, 256, mercator.proj4);
                layer = new mapnik.Layer('layer', mercator.proj4);
                postgis = new mapnik.Datasource(postgis_settings);
                
            // catch errors
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

            callback(null, map);
        });

        // run ops
        async.waterfall(ops, function (err, map) {

            // render vector tile:
            if (err) {
                console.error({
                    err_id : 3,
                    err_msg : 'render vector',
                    error : err
                });
                return done(err);
            } 

            var map_options = {
                variables : { 
                    zoom : params.z // insert min_max etc 
                }
            }

            // vector
            var im = new mapnik.VectorTile(params.z, params.x, params.y);
            
            // check
            if (!im) return callback('Unsupported type.')

            // render
            map.render(im, map_options, function (err, tile) {
                if (err) {
                    console.error({
                        err_id : 4,
                        err_msg : 'render vector',
                        error : err
                    });
                    return done(err);
                }

                store._saveVectorTile(tile, params, done);
            });
        });

    },

    invokeLambdaRaster : function (data, done) {

        // you shouldn't hardcode your keys in production! See http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html
        AWS.config.update({
            accessKeyId: process.env.MAPIC_AWS_LAMBDA_ACCESSKEYID, 
            secretAccessKey: process.env.MAPIC_AWS_LAMBDA_SECRETACCESSKEY,
            region : 'eu-central-1'
        });

        var lambda = new AWS.Lambda();

        // mark raster for lambda triage
        data.triage = 'raster';
        
        var params = {
            FunctionName: 'mapnik-debug-2', /* required */
            Payload: JSON.stringify(data),
        };

        lambda.invoke(params, function(err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
            } else {    
                console.log(data);           // successful response

            }

            // should be all good
            done(err);

        });

    },

    invokeLambdaGrid : function (data, done) {

        // you shouldn't hardcode your keys in production! See http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html
        AWS.config.update({
            accessKeyId: process.env.MAPIC_AWS_LAMBDA_ACCESSKEYID, 
            secretAccessKey: process.env.MAPIC_AWS_LAMBDA_SECRETACCESSKEY,
            region : 'eu-central-1'
        });

        var lambda = new AWS.Lambda();

        // mark raster for lambda triage
        data.triage = 'grid';
        
        var params = {
            FunctionName: 'mapnik-debug-2', /* required */
            Payload: JSON.stringify(data),
        };

        lambda.invoke(params, function(err, data) {
            if (err) {
                console.log(err, err.stack); // an error occurred
            } else {    
                console.log(data);           // successful response

            }

            // should be all good
            done(err);

        });

    },


    _lambdaRender : function (data, done) {

        console.log('DATA ==================')
        // console.log(JSON.stringify(data));

        mile._debugJSON(JSON.stringify(data));

        // input:
        // var data = {
        //     xml : xml,
        //     bbox : buffered_bbox,
        //     postgis_settings : postgis_settings,
        //     extent : mile_layer.options.extent,
        //     mile_layer : mile_layer,
        //     bufferSize : 128,
        //     proj : mercator.proj4,
        //     params : params,
        //     aws : {
        //         S3_BUCKETNAME           : 'mapic-s3.' + process.env.MAPIC_DOMAIN,
        //         AWS_REGION              : process.env.MAPIC_AWS_S3_REGION,

        //         // todo! 
        //         AWS_ACCESS_KEY_ID       : process.env.MAPIC_AWS_S3_ACCESSKEYID || process.env.MAPIC_AWS_ACCESSKEYID,
        //         AWS_SECRET_ACCESS_KEY   : process.env.MAPIC_AWS_S3_SECRETACCESSKEY || process.env.MAPIC_AWS_SECRETACCESSKEY,
        //     }
        // }


        // prepare all the data BEFORE lambda, and pass as JSON
        //  - layer
        //  - postgis settings
        //  - bbox, extent, xyz params
        //  - carto xml

        // create mapnik objects in lambda
        //  - mapnik.Layer
        //  - mapnik.Map
        //  - mapnik.Datasource
        //  - mapnik.Image

        // render tile
        //  - map.render()
        //  - buffer output (png)

        // save to S3

        // return success, and mile will get tile from S3

        // -------------------

        // dependencies needed:
        //  - node mapnik
        //      - mapnik
        //      - maybe lots more
        //  - mercator

        
        // benchmark
        var startTime = Date.now();

        // create layer
        var layer = new mapnik.Layer('layer', data.proj);

        // create datasource
        var datasource = new mapnik.Datasource(data.postgis_settings);
            
        // set datasource
        layer.datasource = datasource;

        // add styles
        layer.styles = ['layer']; 

        // create map
        var map = new mapnik.Map(256, 256, data.proj);

        // set buffer
        map.bufferSize = data.bufferSize;

        // set extent
        map.extent = data.bbox; // must have extent!

        // add layer to map
        map.add_layer(layer);

        // add xml (async)
        map.fromString(data.xml, {strict : true}, function (err, new_map) {

            // map options
            var map_options = {
                buffer_size : data.bufferSize,
                variables : { 
                    zoom : data.params.z // insert min_max etc 
                }
            }
            
            // create image
            var im = new mapnik.Image(256, 256);

            // render image
            new_map.render(im, map_options, function (err, tile) {
                if (err) {
                    console.log('ERROR: map.render()', err);
                    return done(err);
                }

                // benchmark
                var endTime = Date.now() - startTime;
                console.log('rendered raster in', endTime, 'ms');

                // save tile in S3
                var params = data.params;
                var AWS_REGION = data.aws.AWS_REGION;
                var S3_BUCKETNAME = data.aws.S3_BUCKETNAME;
                process.env.AWS_ACCESS_KEY_ID = data.aws.AWS_ACCESS_KEY_ID;
                process.env.AWS_SECRET_ACCESS_KEY = data.aws.AWS_SECRET_ACCESS_KEY;

                var AWS = require('aws-sdk');
                var s3 = new AWS.S3({region: AWS_REGION});

                var bucketName = S3_BUCKETNAME;
                var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';

                tile.encode('png8', function (err, buffer) {
                    s3.putObject({
                        Bucket: bucketName,
                        Key: keyString,
                        Body: buffer
                    }, function (err, response) {
                        if (err) console.log(err);
                        done(null);
                    });
                });


            });
        });

    },

    _lambdaRenderGrid : function (data, done) {

        // input:
        // var data = {
        //     xml : xml,
        //     bbox : buffered_bbox,
        //     postgis_settings : postgis_settings,
        //     extent : mile_layer.options.extent,
        //     mile_layer : mile_layer,
        //     bufferSize : 128,
        //     proj : mercator.proj4,
        //     params : params,
        //     aws : {
        //         S3_BUCKETNAME           : 'mapic-s3.' + process.env.MAPIC_DOMAIN,
        //         AWS_REGION              : process.env.MAPIC_AWS_S3_REGION,

        //         // todo! 
        //         AWS_ACCESS_KEY_ID       : process.env.MAPIC_AWS_S3_ACCESSKEYID || process.env.MAPIC_AWS_ACCESSKEYID,
        //         AWS_SECRET_ACCESS_KEY   : process.env.MAPIC_AWS_S3_SECRETACCESSKEY || process.env.MAPIC_AWS_SECRETACCESSKEY,
        //     }
        // }

        // benchmark
        var startTime = Date.now();

        // create layer
        var layer = new mapnik.Layer('layer', data.proj);

        // create datasource
        var datasource = new mapnik.Datasource(data.postgis_settings);
            
        // set datasource
        layer.datasource = datasource;

        // add styles
        layer.styles = ['layer']; 

        // create map
        var map = new mapnik.Map(256, 256, data.proj);

        // set buffer
        map.bufferSize = data.bufferSize;

        // set extent
        map.extent = data.bbox; // must have extent!

        // add layer to map
        map.add_layer(layer);

        // add xml (async)
        map.fromString(data.xml, {strict : true}, function (err, new_map) {

            // map options
            var map_options = {
                buffer_size : data.bufferSize,
                layer : 0,
                fields : ['gid'],
            }

            
            // create grid
            var im = new mapnik.Grid(map.width, map.height);

            // render image
            new_map.render(im, map_options, function (err, grid) {
                if (err) {
                    console.log('ERROR: map.render()', err);
                    return done(err);
                }

                // benchmark
                var endTime = Date.now() - startTime;
                console.log('rendered grid in', endTime, 'ms');



                // save tile in S3
                var params = data.params;
                var AWS_REGION = data.aws.AWS_REGION;
                var S3_BUCKETNAME = data.aws.S3_BUCKETNAME;
                process.env.AWS_ACCESS_KEY_ID = data.aws.AWS_ACCESS_KEY_ID;
                process.env.AWS_SECRET_ACCESS_KEY = data.aws.AWS_SECRET_ACCESS_KEY;

                var s3 = new AWS.S3({region: AWS_REGION});

                var bucketName = S3_BUCKETNAME;
                // var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';

                var keyString = 'grid_tile:'  + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
               
                // tile.encode('png8', function (err, buffer) {
                //     s3.putObject({
                //         Bucket: bucketName,
                //         Key: keyString,
                //         Body: buffer
                //     }, function (err, response) {
                //         if (err) console.log(err);
                //         done(null);
                //     });
                // });

                grid.encode({features : true}, function (err, utf) {
                    if (err) return done(err);

                    s3.putObject({
                        Bucket: bucketName,
                        Key: keyString,
                        Body: JSON.stringify(utf)
                    }, function (err, response) {
                        done(null);
                    });
                    
                    // save grid to redis
                    // store.saveGridTile(keyString, JSON.stringify(utf), done);
                });


            });
        });

        // if (err || !map)  {
        //     console.error({
        //         err_id : 61,
        //         err_msg : 'render grid tile',
        //         error : err
        //     });
        //     return done(err || 'No map! ERR:4493')
        // }

        // var map_options = {
        //     variables : { 
        //         zoom : params.z // insert min_max etc 
        //     }
        // }

        // // raster
        // var im = new mapnik.Grid(map.width, map.height);

        // // var fields = ['gid', 'east', 'north', 'range', 'azimuth', 'vel', 'coherence', 'height', 'demerr'];
        // var fields = ['gid']; // todo: this is hardcoded!, get first column instead (could be ['id'] etc)

        // var map_options = {
        //     layer : 0,
        //     fields : fields,
        //     buffer_size : 128
        // }
        
        // // check
        // if (!im) return callback('Unsupported type.')

        // // render
        // map.render(im, map_options, function (err, grid) {
        //     if (err) return done(err);
        //     if (!grid) return done('no grid 233');

        //     grid.encode({features : true}, function (err, utf) {
        //         if (err) return done(err);
                
        //         // save grid to redis
        //         var keyString = 'grid_tile:'  + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
        //         store.saveGridTile(keyString, JSON.stringify(utf), done);
        //     });
        // });

    },

    // _lambdaPutS3 : function (tile, data, done) {

    //     var params = data.params;
    //     var AWS_REGION = data.aws.AWS_REGION;
    //     var S3_BUCKETNAME = data.aws.S3_BUCKETNAME;

    //     process.env.AWS_ACCESS_KEY_ID = data.aws.AWS_ACCESS_KEY_ID;
    //     process.env.AWS_SECRET_ACCESS_KEY = data.aws.AWS_SECRET_ACCESS_KEY;

        
    //     var AWS = require('aws-sdk');
    //     var s3 = new AWS.S3({region: AWS_REGION});

    //     var bucketName = S3_BUCKETNAME;
    //     var keyString = 'raster_tile:' + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y + '.png';

    //     tile.encode('png8', function (err, buffer) {
    //         s3.putObject({
    //             Bucket: bucketName,
    //             Key: keyString,
    //             Body: buffer
    //         }, function (err, response) {
    //             if (err) console.log(err);
    //             done(null);
    //         });
    //     });

    // },

    _renderRasterTile : function (params, done) {

        // benchmark
        var prepareStartTime = Date.now();

        // prepare data
        mile._prepareTile(params, function (err, data) {

            // pseduo fn for lambda
            // mile._lambdaRender(data, done);

            // render tile on lambda
            mile.invokeLambdaRaster(data, done);

        });
        
    },

    _prepareTile : function (params, done) {

        // parse url into layerUuid, zxy, type
        var ops = [];
        var map;
        var layer;
        var postgis;
        var bbox;
        var postgis_settings;
        var mile_layer;

        // check params
        if (!params.layerUuid)     return done('Invalid url: Missing layerUuid.');
        if (params.z == undefined) return done('Invalid url: Missing tile coordinates. z', params.z);
        if (params.x == undefined) return done('Invalid url: Missing tile coordinates. x', params.x);
        if (params.y == undefined) return done('Invalid url: Missing tile coordinates. y', params.y);
        if (!params.type)          return done('Invalid url: Missing type extension.');


        // look for stored layerUuid
        ops.push(function (callback) {
            store.layers.get(params.layerUuid, callback);
        });

        // ensure extent is set on layer
        ops.push(function (storedLayerJSON, callback) {
            if (!storedLayerJSON) {
                console.log('NO STORED LAYER');
                return callback('No such layerUuid.');
            } 

            // parse layer
            var parsed_layer = tools.safeParse(storedLayerJSON);

            // get extent from metadata in correct projection
            var metadata = parsed_layer.options.metadata;
            var parsed_metadata = tools.safeParse(metadata);
            var web_extent = parsed_metadata.extent;
            var input = web_extent;
            var input_a = [parseFloat(input[0]), parseFloat(input[2])]
            var input_b = [parseFloat(input[1]), parseFloat(input[3])]
            var FROM_PROJECTION = 'EPSG:4326'
            var TO_PROJECTION = 'EPSG:3857';
            var output_a = proj4(FROM_PROJECTION, TO_PROJECTION, input_a);
            var output_b = proj4(FROM_PROJECTION, TO_PROJECTION, input_b);
            var output_extent = output_a[0] + ' ' + output_b[0] + ',' + output_a[1] + ' ' + output_b[1];

            // set extent
            parsed_layer.options.extent = output_extent;

            // global
            mile_layer = parsed_layer;

            // continue
            callback(null, parsed_layer);
        });


        // define settings, xml
        ops.push(function (storedLayer, callback) {
            if (!storedLayer) return callback('No such layerUuid.');

            // create postgis settings 
            postgis_settings = {
                user     : pgsql_options.dbuser,
                password : pgsql_options.dbpass,
                host     : pgsql_options.dbhost,
                srid     : '3857',
                dbname   : storedLayer.options.database_name,
                extent   : storedLayer.options.extent,
                srid     : storedLayer.options.srid,
                type     : 'postgis',
                table    : storedLayer.options.sql,
                geometry_field : 'the_geom_3857',
                asynchronous_request : false,
            };


            // overwrite some postgis_settings for raster data source
            if (storedLayer.options.data_type == 'raster') {
                postgis_settings.type = 'pgraster';
                postgis_settings.clip_rasters = 'true';
                postgis_settings.use_overviews = 'true';
                postgis_settings.prescale_rasters = 'true';
                postgis_settings.geometry_field = 'rast';
                postgis_settings.table = storedLayer.options.file_id;
                postgis_settings.band = 1;
            } 


            // ----------
            // - mapnik.Layer and mapnik.Datasource needs to be created TWICE. 
            //   once here in order to render carto xml
            //   and again in Lambda... should be ok.
            //
            // ----------

            try {   
                layer   = new mapnik.Layer('layer', mercator.proj4);
                postgis = new mapnik.Datasource(postgis_settings);
                
            // catch errors
            } catch (e) { 
                console.log('MAJOR ERROR');
                return callback(e.message); 
            }

            // set datasource
            layer.datasource = postgis;

            // add styles
            layer.styles = ['layer']; // style names in xml

            // parse xml from cartocss
            mile.cartoRenderer(storedLayer, layer, function (err, xml) {
                callback(err, xml);
            });

        });

        // load xml to map
        ops.push(function (xml, callback) {

            // set bounding box of tile
            bbox = mercator.xyz_to_envelope(parseInt(params.x), parseInt(params.y), parseInt(params.z), false);
            var buffered_bbox = [];
            buffered_bbox.push(parseFloat(bbox[0]) * 1);
            buffered_bbox.push(parseFloat(bbox[1]) * 1);
            buffered_bbox.push(parseFloat(bbox[2]) * 1);
            buffered_bbox.push(parseFloat(bbox[3]) * 1);

            var data = {
                xml : xml,
                bbox : buffered_bbox,
                postgis_settings : postgis_settings,
                extent : mile_layer.options.extent,
                mile_layer : mile_layer,
                bufferSize : 128,
                proj : mercator.proj4,
                params : params,
                aws : {
                    S3_BUCKETNAME           : 'mapic-s3.' + process.env.MAPIC_DOMAIN,
                    AWS_REGION              : process.env.MAPIC_AWS_S3_REGION,

                    // todo! 
                    AWS_ACCESS_KEY_ID       : process.env.MAPIC_AWS_S3_ACCESSKEYID || process.env.MAPIC_AWS_ACCESSKEYID,
                    AWS_SECRET_ACCESS_KEY   : process.env.MAPIC_AWS_S3_SECRETACCESSKEY || process.env.MAPIC_AWS_SECRETACCESSKEY,
                }
            }

            callback(null, data);

        });

        // run ops
        async.waterfall(ops, done);

    },

    _prepareTileLegacy : function (params, done) {

        // parse url into layerUuid, zxy, type
        var ops = [];
        var map;
        var layer;
        var postgis;
        var bbox;

        // check params
        if (!params.layerUuid)     return done('Invalid url: Missing layerUuid.');
        if (params.z == undefined) return done('Invalid url: Missing tile coordinates. z', params.z);
        if (params.x == undefined) return done('Invalid url: Missing tile coordinates. x', params.x);
        if (params.y == undefined) return done('Invalid url: Missing tile coordinates. y', params.y);
        if (!params.type)          return done('Invalid url: Missing type extension.');


        // look for stored layerUuid
        ops.push(function (callback) {
            store.layers.get(params.layerUuid, callback);
        });

        // ensure extent is set on layer
        ops.push(function (storedLayerJSON, callback) {
            if (!storedLayerJSON) {
                console.log('NO STORED LAYER');
                return callback('No such layerUuid.');
            } 
            // parse layer
            var layer = tools.safeParse(storedLayerJSON);

            // parse extent from metadata, 4326 -> 3857
            
            var metadata = layer.options.metadata;
            var parsed_metadata = tools.safeParse(metadata);
            var web_extent = parsed_metadata.extent;
            // var input = [1.91584716169939,28.9021474441477,2.51108360353875,29.355418173006];
            // console.log('web_extent', web_extent);
            var input = web_extent;
            var input_a = [parseFloat(input[0]), parseFloat(input[2])]
            var input_b = [parseFloat(input[1]), parseFloat(input[3])]
            // console.log('input', input);
            var FROM_PROJECTION = 'EPSG:4326'
            var TO_PROJECTION = 'EPSG:3857';
            var output_a = proj4(FROM_PROJECTION, TO_PROJECTION, input_a);
            var output_b = proj4(FROM_PROJECTION, TO_PROJECTION, input_b);
            // console.log('output_a', output_a); //[ 213271.13047811456, 279622.0777225077 ]
            // console.log('output_b', output_b); // [ 3217372.336314635, 3420961.0477779116 ]
            // console.log('all good');

            // desired output:
            // existing extent 213271.130478115 3363197.48257298,279532.548085272 3420961.04777791

            // create string
            var output_extent = output_a[0] + ' ' + output_b[0] + ',' + output_a[1] + ' ' + output_b[1];
            // console.log('output_extent', output_extent);

            layer.options.extent = output_extent;

            // continue
            callback(null, layer);
        });


        // define settings, xml
        ops.push(function (storedLayer, callback) {
            if (!storedLayer) return callback('No such layerUuid.');

           
            // insert layer settings 
            var postgis_settings = {
                user     : pgsql_options.dbuser,
                password : pgsql_options.dbpass,
                host     : pgsql_options.dbhost,
                srid     : '3857',
                dbname   : storedLayer.options.database_name,
                extent   : storedLayer.options.extent,
                srid     : storedLayer.options.srid,
                type     : 'postgis',
                table    : storedLayer.options.sql,
                geometry_field : 'the_geom_3857',
                asynchronous_request : false,
            };


            // overwrite some postgis_settings for raster data source
            if ( storedLayer.options.data_type == 'raster' ) {
                postgis_settings.type = 'pgraster';
                postgis_settings.clip_rasters = 'true';
                postgis_settings.use_overviews = 'true';
                postgis_settings.prescale_rasters = 'true';
                postgis_settings.geometry_field = 'rast';
                postgis_settings.table = storedLayer.options.file_id;
                postgis_settings.band = 1;
            } 


            // set bounding box of tile
            bbox = mercator.xyz_to_envelope(parseInt(params.x), parseInt(params.y), parseInt(params.z), false);
            var buffered_bbox = [];
            buffered_bbox.push(parseFloat(bbox[0]) * 1);    // todo: fix clipped boundaries...
            buffered_bbox.push(parseFloat(bbox[1]) * 1);
            buffered_bbox.push(parseFloat(bbox[2]) * 1);
            buffered_bbox.push(parseFloat(bbox[3]) * 1);



            // everything in spherical mercator (3857)!
            try {   
                map     = new mapnik.Map(256, 256, mercator.proj4);
                layer   = new mapnik.Layer('layer', mercator.proj4);
                postgis = new mapnik.Datasource(postgis_settings);
                
            // catch errors
            } catch (e) { return callback(e.message); }

            // set buffer
            map.bufferSize = 128;
            // map.bufferSize = 64;

            // set extent
            // console.log('bbox:', bbox);
            // map.extent = bbox; // must have extent!
            map.extent = buffered_bbox; // must have extent!

            // set datasource
            layer.datasource = postgis;

            // add styles
            layer.styles = ['layer']; // style names in xml
            
            // // add layer to map
            // map.add_layer(layer);

            // parse xml from cartocss
            var cartoTimeStart = Date.now();

            // mile.cartoRenderer(storedLayer, layer, callback);
            mile.cartoRenderer(storedLayer, layer, function (err, xml){
                var cartoTime = Date.now() - cartoTimeStart;
                console.log('rendered carto in', cartoTime, 'ms');
                callback(err, xml);
            });
        });

        // load xml to map
        ops.push(function (xml, callback) {
            // add layer to map
            map.add_layer(layer);
            map.fromString(xml, {strict : true}, callback);
        });

        // run ops
        async.waterfall(ops, done);

    },

    _renderRasterTileLegacy : function (params, done) {

        var prepareStartTime = Date.now();
        // added LEGACY 
        mile._prepareTileLegacy(params, function (err, map) {
            
            var prepareEndTime = Date.now() - prepareStartTime;
            console.log('prepared tile in', prepareEndTime, 'ms');


            if (err) return done(err);
            if (!map) return done(new Error('no map 7474'));

            // debug write xml
            if (0) mile._debugXML(params.layerUuid, map.toXML());



            // map options
            var map_options = {
                buffer_size : 128,
                variables : { 
                    zoom : params.z // insert min_max etc 
                }
            }
            
            // raster
            var im = new mapnik.Image(256, 256);

            // render
            var startTime = Date.now();

            // we could send only this fn to lambda... 
            // would have to pass: 
            // - map (or is that possible, since it's a binary/object/idkwhat)
            // - map_options
            // - layer_id etc...
            map.render(im, map_options, function (err, tile) {
                if (err) {
                    console.error({
                        err_id : 5,
                        err_msg : 'render raster',
                        error : err
                    });
                    // mile._debugXML(params.layerUuid, map.toXML(), true);
                    return done(err);
                }

                var endTime = Date.now() - startTime;

                console.log('rendered raster in', endTime, 'ms');

                // save png to redis
                store._saveRasterTile(tile, params, done);
            });
        });
        
    },


    _renderGridTile : function (params, done) {

        // mile._prepareTileLegacy(params, function (err, map) {
        mile._prepareTile(params, function (err, data) {


            mile.invokeLambdaGrid(data, done);
            // mile._lambdaRenderGrid(data, done);

            // if (err || !map)  {
            //     console.error({
            //         err_id : 61,
            //         err_msg : 'render grid tile',
            //         error : err
            //     });
            //     return done(err || 'No map! ERR:4493')
            // }

            // var map_options = {
            //     variables : { 
            //         zoom : params.z // insert min_max etc 
            //     }
            // }

            // // raster
            // var im = new mapnik.Grid(map.width, map.height);

            // // var fields = ['gid', 'east', 'north', 'range', 'azimuth', 'vel', 'coherence', 'height', 'demerr'];
            // var fields = ['gid']; // todo: this is hardcoded!, get first column instead (could be ['id'] etc)

            // var map_options = {
            //     layer : 0,
            //     fields : fields,
            //     buffer_size : 128
            // }
            
            // // check
            // if (!im) return callback('Unsupported type.')

            // // render
            // map.render(im, map_options, function (err, grid) {
            //     if (err) return done(err);
            //     if (!grid) return done('no grid 233');

            //     grid.encode({features : true}, function (err, utf) {
            //         if (err) return done(err);
                    
            //         // save grid to redis
            //         var keyString = 'grid_tile:'  + params.layerUuid + ':' + params.z + ':' + params.x + ':' + params.y;
            //         store.saveGridTile(keyString, JSON.stringify(utf), done);
            //     });
            // });
        });
    },


    preRender : function (req, res) {
        var layer_id = req.body.layer_id;
        if (!layer_id) return res.send({error: 'Missing argument: layer_id'});

        // get layer
        store.layers.get(layer_id, function (err, storedLayerJSON) {    
            if (err || !storedLayerJSON) return res.send({error: 'Missing layer_id'});

            var layer = tools.safeParse(storedLayerJSON);
            var metadata = tools.safeParse(layer.options.metadata);
            var extent = metadata.extent;

            // create tiles
            var maxZoom = 14;
            var tiles = mile.create_prerender_tiles_array({extent : extent, layer_id : layer_id}, maxZoom);


            var num_tiles = _.size(tiles);
            console.log('num_tiles:', num_tiles);

            // throw on too many tile requests
            if (num_tiles > 10000) return res.send({
                success : false, 
                error : 'Too many tiles!',
                tiles : num_tiles,
                estimated_time : (_.size(tiles) / 30)
            });

            // start pre-render
            mile.requestPrerender({
                tiles : tiles, 
                access_token : req.body.access_token,
                layer_id : layer_id
            })

            // return info to client
            res.send({
                success : true, 
                error : null,
                tiles : _.size(tiles),
                estimated_time : (_.size(tiles) / 30)
            });

        });

    },

    requestPrerender : function (options) {
        var tiles = options.tiles;
        var access_token = options.access_token;
        var layer_id = options.layer_id;
        var raster_ops = [];
        var grid_ops = [];
        var nt = os.cpus().length; // parallel tile requests

        console.log('Pre-rendering', (_.size(tiles) * 2), 'tiles')
        var timeStartRaster = Date.now();

        // create array of tile requests
        _.each(tiles, function (tile) {
            
            // raster tiles
            raster_ops.push(function(done) {
                var url = 'https://tiles-a-' + process.env.MAPIC_DOMAIN + '/v2/tiles/' + layer_id + '/' + tile.z + '/' + tile.x + '/' + tile.y + '.png?access_token=' + access_token;
                https.get(url, function (err) {
                    done();
                });
            });

        });

        // request only n tiles at a time
        async.parallelLimit(raster_ops, nt, function (err, results) {
            var timeEnd = Date.now();
            var benched = (timeEnd - timeStartRaster) / 1000;
            console.log('Pre-rendering of raster tiles done! That took', benched, 'seconds.');


            var timeStartGrid = Date.now();

              // create array of tile requests
            _.each(tiles, function (tile) {

                // grid tiles
                grid_ops.push(function(done) {
                    var url = 'https://grid-a-' + process.env.MAPIC_DOMAIN + '/v2/tiles/' + layer_id + '/' + tile.z + '/' + tile.x + '/' + tile.y + '.grid?access_token=' + access_token;
                    https.get(url, function (err) {
                        done();
                    });
                });
            });

            // request only n tiles at a time
            async.parallelLimit(raster_ops, nt, function (err, results) {
                var timeEnd = Date.now();
                var benched = (timeEnd - timeStartGrid) / 1000;
                console.log('Pre-rendering of grid tiles done! That took', benched, 'seconds.');
            });

        });


    },

    create_prerender_tiles_array : function (options, zoom) {
        var tiles = [];
        var maxZoom = zoom ? zoom : 7;
        _.times(maxZoom, function (z) {
            z++;
            tiles.push(cubes.create_tile_array_at_zoom(options, z));
        });
        return _.flatten(tiles);
    },

    create_tile_array_at_zoom : function (options, zoom) {
        var extent = options.extent;
        var layer_id = options.layer_id;
        var mask_id = options.mask_id;
        var dataset_id = options.dataset_id;

        // latitude
        var north = parseFloat(extent[1]);
        var south = parseFloat(extent[3]);

        // longitutde
        var west = parseFloat(extent[0]);
        var east = parseFloat(extent[2]);

        var minLng = west;
        var maxLng = east;
        var minLat = south;
        var maxLat = north;

        var minTileX = mile.lon_to_tile_x(minLng, zoom);
        var maxTileX = mile.lon_to_tile_x(maxLng, zoom);

        var minTileY = mile.lat_to_tile_y(minLat, zoom);
        var maxTileY = mile.lat_to_tile_y(maxLat, zoom);

        var x = minTileX;
        var z = zoom;
        var tiles = [];
        while (x <= maxTileX) {
            var y = minTileY;
            while (y <= maxTileY) {
                var tile = {
                    z : z, 
                    x : x, 
                    y : y,
                    layer_id : layer_id, 
                    dataset_id : dataset_id,
                    mask_id : mask_id,
                    type : 'png',

                }
                tiles.push(tile);
                y++;
            }
            x++;
        }
        return tiles;
    },




    deg_to_rad : function (deg) {
        return deg * Math.PI / 180;
    },
    lon_to_tile_x : function (lon, zoom) {
        return parseInt(Math.floor( (lon + 180) / 360 * (1<<zoom) ));
    },
    lat_to_tile_y : function (lat, zoom) {
        return Math.floor((1 - Math.log(Math.tan(mile.deg_to_rad(lat)) + 1 / Math.cos(mile.deg_to_rad(lat))) / Math.PI) / 2 * Math.pow(2, zoom));
    },

    // convert CartoCSS to Mapnik XML
    cartoRenderer : function (storedLayer, layer, callback) {

        var css = storedLayer.options.cartocss;

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
            console.log('carto render error:', e);
            var err = { message : 'CartoCSS rendering failed: ' + e.toString() }
            callback(err);
        }

    },

    _debugJSON : function (json) {
        var json_filename = 'tmp/debug.json';
        fs.outputFile(json_filename, json, function (err) {
            if (err) console.log(err);
        });
    },

    _debugXML : function (layer_id, xml, print_to_console) {
        var xml_filename = 'tmp/' + layer_id + '.debug.xml';
        if (print_to_console) {
            console.log('xml', xml);
            return;
        }
        fs.outputFile(xml_filename, xml, function (err) {
            if (err) console.log(err);
            // if (!err) console.log('wrote xml to ', xml_filename);
        });
    },

    _isOutsideExtent : function (options) {
        
        var params = options.params;
        var layer = options.layer;   

        // get options
        var dataset = options.dataset;
        var coords = options.params;
        var metadata = tools.safeParse(layer.options.metadata);

        // get bboxes
        var tile_bounding_box = mercator.xyz_to_envelope(parseInt(coords.x), parseInt(coords.y), parseInt(coords.z), false);
        var extent_geojson = metadata.extent_geojson;
        var raster_extent_latlng = geojsonExtent(extent_geojson);
        var poly1 = turf.bboxPolygon(tile_bounding_box);
        var poly1 = turf.projection.toWgs84(poly1);
        var poly2 = turf.bboxPolygon(raster_extent_latlng);
        
        // check for overlap
        var intersection = turf.intersect(poly1, poly2);

        return _.isNull(intersection);
    },

    // return tiles from disk or create
    getRasterTile : function (params, storedLayer, done) {

        // console.log('getRasterTile params', params, storedLayer);
        var outside_extent = mile._isOutsideExtent({
            params : params, 
            layer : storedLayer
        });
        if (outside_extent) return done('outside extent');

        // check cache
        store._readRasterTile(params, function (err, data) {
            if (err) console.log('getRasterTile err: ', err);
            
            // return data if any (and not forced render)
            if (!params.force_render && data) {
                console.log('Serving cached tile');
                return done(null, data); // debug, turned off to create every time
            }
            
            // create
            mile.createRasterTile(params, storedLayer, done);
        });
    },

    // return tiles from disk or create
    getVectorTile : function (params, storedLayer, done) {

        // check redis
        store._readVectorTile(params, function (err, data) {

            // return data
            if (data) return done(null, data);   // debug, turned off to create every time

            // create
            mile.createVectorTile(params, storedLayer, done);
        });
    },

    // return tiles from disk or create
    getGridTile : function (params, storedLayer, done) {

        // console.log('getRasterTile params', params, storedLayer);
        var outside_extent = mile._isOutsideExtent({
            params : params, 
            layer : storedLayer
        });
        if (outside_extent) return done('outside extent');

        // check cache
        store.getGridTile(params, function (err, data) {

            // found, return data
            if (data) return done(null, data);

            // not found, create
            mile.createGridTile(params, storedLayer, done);
        });
    },

    getUploadStatus : function (options, done) {
        mile.GET(mile.routes.base + mile.routes.upload_status, options, function (err, json) {
            var result = tools.safeParse(json);
            done(err, result);
        });
    },

    setUploadStatus : function (options, done) {
        mile.POST(mile.routes.base + mile.routes.upload_status, options, function (err, json) {
            done(err, json);
        });
    },

    // shorthand
    POST : function (endpoint, options, callback) {
        request({
            method : 'POST',
            uri : endpoint,
            json : true,
            body : options
        }, function (err, response, body) {
            callback(err, body);
        }); 
    },

    // shorthand
    GET : function (endpoint, options, callback) {
        request({
            uri : endpoint,
            qs : options
        }, function (err, response, body) {
            callback(err, body);
        }); 
    },
    
    // helper fn's for error handling
    error : {
        missingInformation : function (res, missing) {
            var error = 'Missing information'
            var error_description = missing + ' Check out the documentation on https://docs.systemapic.com.';
            res.json({
                error : error,
                error_description : error_description
            });
        },
        noAccess : function (res) {
            res.json({ error : 'Unauthenicated.' });
        },
    },

    checkAccess : tools.checkAccess,
}

// start server
server(mile);

// // -------------------
// // TOGGLE CLUSTER MODE
// // -------------------
// // var useCluster = true;
// var useCluster = false;
// // -------------------


// let workers = [];

// if (useCluster) {

//     // with clustering
//     if (cluster.isMaster) { 

//         // start server using cluster
//         console.log('Clusters: ' + numCPUs);
//         server(mile);

//         // fork workers
//         for (var i = 0; i < numCPUs - 1; i++) {  
            
//             workers.push(cluster.fork());

//             // to receive messages from worker process
//             workers[i].on('message', function(message) {
//                 console.log(message);
//             });
//         };

//         // process is clustered on a core and process id is assigned
//         cluster.on('online', function(worker) {
//             console.log('Worker ' + worker.process.pid + ' is listening');
//         });

//         // listen to exit, keep alive
//         cluster.on('exit', function(worker, code, signal) { 
            
//             console.error('Cluster died, respawning...');
//             workers.push(cluster.fork());
            
//             // to receive messages from worker process
//             workers[workers.length-1].on('message', function(message) {
//                 console.log(message);
//             });
//         });

//     } 





// // // run mile without clustering
// } else {

//     console.log('Starting without clustering...');

//     // run server on single cluster
//     server(mile);

// }










// start server
// todo: move around
// server(mile);
