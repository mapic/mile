// dependencies
var _ = require('lodash');
var fs = require('fs-extra');
var zlib = require('zlib'); // for vector tile zipping
var uuid = require('uuid');
var async = require('async');
var carto = require('carto'); // used by cartoRenderer, very possible breaking changes
var mapnik = require('mapnik');
var request = require('request');
var mercator = require('./sphericalmercator');
var geojsonExtent = require('geojson-extent');
var proj4 = require('proj4');
var AWS = require('aws-sdk');

console.warn = function () {}; // remove annoying carto warning

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

// postgis env
var MAPIC_POSTGIS_HOST     = process.env.MAPIC_POSTGIS_HOST;
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

    fetchDataArea           : queries.fetchDataArea,
    fetchData               : queries.fetchData,
    fetchHistogram          : queries.fetchHistogram,
    getVectorPoints         : queries.getVectorPoints,
    fetchRasterDeformation  : queries.fetchRasterDeformation,
    queryRasterPoint        : queries.queryRasterPoint,
    
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

            // save upload status
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

                    // optional                          // defaults
                    geom_column      : geom_column      || 'the_geom_3857',
                    geom_type        : geom_type        || 'geometry',
                    raster_band      : raster_band      || 0,
                    srid             : srid             || 3857,
                    cartocss_version : cartocss_version || '2.0.1',
                }
            }

            callback(null, layer);
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
            store.getVectorTile(params, done);
        });
    },

    // create raster tile from postgis
    createRasterTile : function (params, storedLayer, done) {
         mile.renderRasterTile(params, function (err) {
            if (err) return done(err);
            store.getRasterTile(params, done);
        });
    },

    // create grid tile from postgis
    createGridTile : function (params, storedLayer, done) {
         mile.renderGridTile(params, function (err) {
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
                user        : MAPIC_POSTGIS_USERNAME,
                password    : MAPIC_POSTGIS_PASSWORD,
                host        : MAPIC_POSTGIS_HOST,
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

                store.saveVectorTile(tile, params, done);
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
            FunctionName: 'mapnik', /* required */
            Payload: JSON.stringify(data),
            LogType: 'Tail'
        };
        
        console.log('invoking lambda (raster)');
        lambda.invoke(params, function(err, data) {
            if (err) console.log('lambda err:', err, err.stack); // an error occurred

            // print result
            const buff = Buffer.from(data.LogResult, 'base64');
            const str = buff.toString('utf-8');
            var info = _.replace(str.split('\tDuration')[1], '\t\n', '');
            var costs = '[raster] Duration' + info;
            console.log(costs);

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
            FunctionName: 'mapnik', /* required */
            Payload: JSON.stringify(data),
            LogType: 'Tail'
        };

        console.log('invoking lambda (grid)');
        lambda.invoke(params, function(err, data) {
            if (err) console.log(err, err.stack); // an error occurred

            // print result
            const buff = Buffer.from(data.LogResult, 'base64');
            const str = buff.toString('utf-8');
            var info = _.replace(str.split('\tDuration')[1], '\t\n', '');
            var costs = '[grid] Duration' + info;
            console.log(costs);

            // should be all good
            done(err);

        });

    },


    renderRasterTile : function (params, done) {

        // prepare data
        mile.prepareTile(params, function (err, data) {
            if (err) {
                console.log('prepareTile err:', err, data);
                return done(err);
            }
            if (!data) {
                console.log('prepareTile no data!', data);
                return done('no data!');
            }

            // render tile on lambda
            mile.invokeLambdaRaster(data, done);

        });
        
    },

    renderGridTile : function (params, done) {

        // prepare data
        mile.prepareTile(params, function (err, data) {
            if (err) {
                console.log('prepareTile err:', err, data);
                return done(err);
            }
            if (!data) {
                console.log('prepareTile no data!', data);
                return done('no data!');
            }

            // render tile on lambda
            mile.invokeLambdaGrid(data, done);
            
        });
    },


    prepareTile : function (params, done) {

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
            //   and again in Lambda... 
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
                s3_bucketname : 'mapic-s3.' + process.env.MAPIC_DOMAIN
            }

            callback(null, data);

        });

        // run ops
        async.waterfall(ops, function (err, data) {
            if (err) {
                console.log('some error preparing tile:', err);
                return done(err);
            }
            if (!data) {
                console.log('no data from preparing tile:');
                return done('no data');
            }

            // all good
            return done(null, data);
        });

    },

  

    preRender : function (req, res) {
        return res.send('Deprecated!');
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
            return callback(null, xml);

        } catch (e) {
            console.log('carto render error:', e);
            var err = { message : 'CartoCSS rendering failed: ' + e.toString() }
            return callback(err);
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
        });
    },

    _isOutsideExtent : function (options) {

        var params = options.params;
        var layer = options.layer;   

        // get options
        var dataset = options.dataset;
        var coords = options.params;
        var metadata = tools.safeParse(layer.options.metadata);

        // hack/fix when dataset only contains one point
        if (metadata.row_count == '1') return false;

        // get bboxes
        var tile_bounding_box = mercator.xyz_to_envelope(parseInt(coords.x), parseInt(coords.y), parseInt(coords.z), false);
        var extent_geojson = metadata.extent_geojson;
        var raster_extent_latlng = geojsonExtent(extent_geojson);
        var poly1 = turf.bboxPolygon(tile_bounding_box);
        var poly2 = turf.projection.toWgs84(poly1);
        var poly3 = turf.bboxPolygon(raster_extent_latlng);
        
        // check for overlap
        var intersection = turf.intersect(poly2, poly3);

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
        store.getRasterTile(params, function (err, data) {
            if (err) console.log('getRasterTile err: ', err);
            
            // return data if any (and not forced render)
            if (!data || params.force_render == 'true') {

                // create tile
                mile.createRasterTile(params, storedLayer, done);

            } else {
                console.log('Serving cached raster tile');
                return done(null, data); // debug, turned off to create every time
            }
            
        });
    },

    // return tiles from disk or create
    getVectorTile : function (params, storedLayer, done) {

        // check redis
        store.getVectorTile(params, function (err, data) {

            // return data
            if (data) return done(null, data);   // debug, turned off to create every time

            // create
            mile.createVectorTile(params, storedLayer, done);
        });
    },

    // return tiles from disk or create
    getGridTile : function (params, storedLayer, done) {

        var outside_extent = mile._isOutsideExtent({
            params : params, 
            layer : storedLayer
        });
        if (outside_extent) return done('outside extent');

        // check cache
        store.getGridTile(params, function (err, data) {

            // return data if any (and not forced render)
            if (!data || params.force_render == 'true') {

                // not found, create
                mile.createGridTile(params, storedLayer, done);

            } else {
                console.log('Serving cached grid tile');
                return done(null, data); // debug, turned off to create every time
            }

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

