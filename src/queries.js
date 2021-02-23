// dependencies
var _ = require('lodash');
var pg = require('pg');
var pgnative = require('pg').native
var async = require('async');
var exec = require('child_process').exec;
var geojsonArea = require('geojson-area');

// plugin: deformation query
var defo = require('./queries/deformation-query');


var MAPIC_POSTGIS_HOST = process.env.MAPIC_POSTGIS_HOST;
var MAPIC_POSTGIS_USERNAME = process.env.MAPIC_POSTGIS_USERNAME;
var MAPIC_POSTGIS_PASSWORD = process.env.MAPIC_POSTGIS_PASSWORD;



module.exports = queries = { 

    fetchRasterDeformation : defo.fetchRasterDeformation,

    queryRasterPoint : function (req, res) {

        console.log('queryRasterDefault', req.body);

        var options = req.body;
        var layer_id = options.layer_id;
        var lngLat = options.point;

        var ops = [];

        ops.push(function (callback) {

            // retrieve layer and return it to client
            store.layers.get(layer_id, function (err, layer) {
                if (err || !layer) return callback(err || 'no layer');
                callback(null, tools.safeParse(layer));
            });
        });

        ops.push(function (layerObject, callback) {

            var layer = layerObject.options;

            // set postgis options
            var pg_database = layer.database_name;

            // create pool
            var pool = new pgnative.Pool({
                host        : MAPIC_POSTGIS_HOST,
                user        : MAPIC_POSTGIS_USERNAME, 
                password    : MAPIC_POSTGIS_PASSWORD,
                database    : pg_database
            });

            // initialize a connection pool
            pool.connect(function(err, client, pg_done) {
                if (err) return done(err);
                if (err) return console.error('error fetching client from pool', err);

                var lng = lngLat.lng;
                var lat = lngLat.lat;

                // works
                var query = 'SELECT ST_Value(rast, ST_Transform(ST_SetSRID(ST_MakePoint(' + lng + ', ' + lat +'), 4326),3857)) AS val FROM ' + layer.table_name + ' WHERE ST_Intersects(rast, ST_Transform(ST_SetSRID(ST_MakePoint(' + lng + ', ' + lat +'),4326),3857),1);';
                
                // query postgis
                client.query(query, function(err, pg_result) {
                   
                    // call `pg_done()` to release the client back to the pool
                    pg_done();

                    // return results
                    callback(err, pg_result);
                });
            });

        });


        async.waterfall(ops, function (err, results) {
            console.log('waterfall err, results', err, results);
            if (err) return res.send({err : err});

            try {
            var value = results.rows[0].val;
            } catch (e) {
                return res.send({err : e});
            };

            console.log('value: ', value);

            res.send({
                err : null,
                data : {
                    lngLat : lngLat,
                    value : value
                }
            });            
        })



    },
    
    fetchData : function (req, res) {

        var options = req.body;
        var column  = options.column; // gid
        var row = options.row; // eg. 282844
        var layer_id = options.layer_id;
        var ops = [];

        ops.push(function (callback) {

            // retrieve layer and return it to client
            store.layers.get(layer_id, function (err, layer) {
                if (err || !layer) return callback(err || 'no layer');
                callback(null, tools.safeParse(layer));
            });
        });

        ops.push(function (layer, callback) {

            var table = layer.options.table_name;
            var database = layer.options.database_name;

            // do sql query on postgis
            var GET_DATA_SCRIPT_PATH = 'src/get_data_by_column.sh';

            // st_extent script 
            var command = [
                GET_DATA_SCRIPT_PATH,   // script
                layer.options.database_name,    // database name
                layer.options.table_name,   // table name
                column,
                row
            ].join(' ');

            console.log('command:', command);

            // run query
            exec(command, {maxBuffer: 1024 * 1024 * 1000}, function (err, stdout, stdin) {
                if (err) return callback(err);

                // parse results
                var json = stdout.split('\n')[2];
                var data = tools.safeParse(json);
                
                // remove geom columns
                data.geom = null;
                data.the_geom_3857 = null;
                data.the_geom_4326 = null;

                // callback
                callback(null, data);
            });
        });

        async.waterfall(ops, function (err, data) {
            if (err) console.error({
                err_id : 51,
                err_msg : 'fetch data script',
                error : err
            });
            res.json(data);
        });

    },

    fetchDataArea : function (req, res) {
        var options = req.body,
            geojson = options.geojson,
            access_token = options.access_token,
            layer_id = options.layer_id;

        var ops = [];

        // error handling
        if (!geojson) return mile.error.missingInformation(res, 'Please provide an area.')

        ops.push(function (callback) {
            // retrieve layer and return it to client
            store.layers.get(layer_id, function (err, layer) {
                if (err || !layer) return callback(err || 'no layer');
                callback(null, tools.safeParse(layer));
            });
        });

        ops.push(function (layer, callback) {
            var table = layer.options.table_name;
            var database = layer.options.database_name;
            var polygon = "'" + JSON.stringify(geojson.geometry) + "'";
            var sql = '"' + layer.options.sql + '"';

            // do sql query on postgis
            var GET_DATA_AREA_SCRIPT_PATH = 'src/get_data_by_area.sh';

            // st_extent script 
            var command = [
                GET_DATA_AREA_SCRIPT_PATH,  // script
                layer.options.database_name,    // database name
                sql,
                polygon
            ].join(' ');

            // do postgis script
            exec(command, {maxBuffer: 1024 * 50000}, function (err, stdout, stdin) {
                if (err) return callback(err);

                var arr = stdout.split('\n');
                var result = [];
                var points = [];


                arr.forEach(function (arrr) {
                    var item = tools.safeParse(arrr);
                    item && result.push(item);
                });

                result.forEach(function (point) {

                    // delete geoms
                    delete point.geom;
                    delete point.the_geom_3857;
                    delete point.the_geom_4326;
                    
                    // push
                    points.push(point);
                });

                // calculate averages, totals
                var average = tools._calculateAverages(points);
                var total_points = points.length;

                // only return 100 points
                if (points.length > 100) {
                    points = points.slice(0, 100);
                }

                // return results
                var resultObject = {
                    all : points,
                    average : average,
                    total_points : total_points,
                    area : geojsonArea.geometry(geojson.geometry),
                    layer_id : layer_id
                }

                // callback
                callback(null, resultObject);
            });
        });

        async.waterfall(ops, function (err, data) {
            if (err) console.error({
                err_id : 52,
                err_msg : 'fetch data area script',
                error : err
            });
            res.json(data);
        });
    },


    fetchHistogram : function (req, res) {
        var options = req.body;
        var column = options.column;
        var access_token = options.access_token;
        var layer_id = options.layer_id;
        var num_buckets = options.num_buckets || 20;
        var ops = [];

        ops.push(function (callback) {
            // retrieve layer and return it to client
            store.layers.get(layer_id, function (err, layer) {
                if (err || !layer) return callback(err || 'no layer');
                callback(null, tools.safeParse(layer));
            });
        });

        ops.push(function (layer, callback) {
            var table = layer.options.table_name;
            var database = layer.options.database_name;

            // do sql query on postgis
            var GET_HISTOGRAM_SCRIPT = 'src/get_histogram.sh';

            // st_extent script 
            var command = [
                GET_HISTOGRAM_SCRIPT,   // script
                database,   // database name
                table,
                column,
                num_buckets
            ].join(' ');


            // do postgis script
            exec(command, {maxBuffer: 1024 * 50000}, function (err, stdout, stdin) {
                if (err) return callback(err);

                var arr = stdout.split('\n');
                var result = [];

                arr.forEach(function (arrr) {
                    var item = tools.safeParse(arrr);
                    item && result.push(item);
                });

                callback(null, result);
            });
        });


        async.waterfall(ops, function (err, data) {
            if (err) console.error({
                err_id : 53,
                err_msg : 'fetch histogram script',
                error : err
            });
            res.json(data);
        });

    },


    primeTableGeometry : function (options, done) {

        var file_id = options.file_id,
            postgis_db = options.database_name,
            ops = [];

        // get geometry type
        ops.push(function (callback) {
            queries.postgis({
                postgis_db : postgis_db,
                query : 'SELECT ST_GeometryType(geom) from "' + file_id + '" limit 1'
            }, function (err, results) {
                if (err) return callback(err);
                if (!results || !results.rows || !results.rows.length) return callback('The dataset contains no valid geodata.');
                var geometry_type = results.rows[0].st_geometrytype.split('ST_')[1];
                callback(null, geometry_type);
            })
        });

        // create geometry 3857
        ops.push(function (geometry_type, callback) {
            var column = ' the_geom_3857';
            var geometry = ' geometry(' + geometry_type + ', 3857)';
            var query = 'ALTER TABLE ' + file_id + ' ADD COLUMN' + column + geometry;

            queries.postgis({
                postgis_db : postgis_db,
                query : query
            }, function (err, results) {
                if (err) return callback(err);
                callback(null, geometry_type);
            });
        });
        // populate geometry
        ops.push(function (geometry_type, callback) {
            var query = 'ALTER TABLE ' + file_id + ' ALTER COLUMN the_geom_3857 TYPE Geometry(' + geometry_type + ', 3857) USING ST_Transform(geom, 3857)'

            queries.postgis({
                postgis_db : postgis_db,
                query : query
            }, function (err, results) {
                if (err) return callback(err);
                // callback(err, geometry_type);
                callback(err);
            });
        });

        // create index for 3857
        ops.push(function (callback) {
            var idx = file_id + '_the_geom_3857_idx';
            var query = 'CREATE INDEX ' + idx + ' ON ' + file_id + ' USING GIST(the_geom_3857)'

            queries.postgis({
                postgis_db : postgis_db,
                query : query
            }, function (err, results) {
                if (err) return callback(err);
                callback(null, 'ok');
            });
        });


        async.waterfall(ops, function (err, results) {
            done(err);
        });

    },


    getVectorPoints : function (req, res) {
        var options = req.body;
        var layer_id = options.layer_id;
        var ops = [];

        ops.push(function (callback) {
            store.layers.get(layer_id, function (err, layer) {
                if (err || !layer) return callback(err || 'no layer');
                callback(null, tools.safeParse(layer));
            });
        });

        ops.push(function (layer, callback) {

            var sql = layer.options.sql;
            var postgis_db = layer.options.database_name;
            var table_name = layer.options.table_name;

            // todo: will query whole table, no filter
            var query = 'select row_to_json(t) from (SELECT * FROM ' + table_name + ' AS q, ST_X(geom) as lng, ST_Y(geom) as lat) t;'

            // query
            queries.postgis({
                postgis_db : postgis_db,
                query : query
            }, function (err, query_result) {
                if (err) return callback(err);
                callback(err, query_result);
            });
        });


        async.waterfall(ops, function (err, query_result) {
            if (err) return res.send({error : err.message});
            if (!query_result) return res.send({error : 'no results'});

            var rows = query_result.rows;
            var points = [];

            _.forEach(rows, function (r) {
                points.push(r.row_to_json);
            });

            res.send({
                error : false,
                points : points,
            });

        });

      
    },



    // run postgis queries
    postgis : function (options, callback) {
        var postgis_db = options.postgis_db;
        var variables = options.variables;
        var query = options.query;
        var conString = 'postgres://' + MAPIC_POSTGIS_USERNAME + ':' + MAPIC_POSTGIS_PASSWORD + '@' + MAPIC_POSTGIS_HOST + '/' + postgis_db;

        pg.connect(conString, function(err, client, pgcb) {
            if (err) return callback(err);
            
            // do query
            client.query(query, variables, function(err, result) {
                // clean up after pg
                pgcb();

                // catch err
                if (err) return callback(err); 
                
                // return result
                callback(null, result);
            });
        });
    },


}