var assert = require('assert');
var mongoose = require('mongoose');
var async = require('async');
var fs = require('fs-extra');
var crypto = require('crypto');
var request = require('request');
var supertest = require('supertest');
var api = supertest('https://172.17.0.1');
var path = require('path');
var httpStatus = require('http-status');
var chai = require('chai');
var expect = chai.expect;
var http = require('http-request');
var assert = require('assert');
var moment = require('moment');
var _ = require('lodash');

// api
var domain = (process.env.MAPIC_DOMAIN == 'localhost') ? 'https://172.17.0.1' : 'https://' + process.env.MAPIC_DOMAIN;
var api = supertest(domain);

// helpers
var endpoints = require(__dirname + '/utils/endpoints');
var helpers = require(__dirname + '/utils/helpers');
var token = helpers.token;

// logs
var debugMode = process.env.MAPIC_DEBUG; // override
// var debugMode = true;

var tmp = {};
var ACCESS_TOKEN;

// Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs
// See https://github.com/systemapic/pile/issues/38
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

// helper fn for tile url
function base_cubes_url() {

    if (process.env.MAPIC_DOMAIN == 'localhost') {
        // var tiles_url = 'https://localhost/v2/cubes/'
        var tiles_url = 'https://172.17.0.1/v2/cubes/'
    } else {
        var tiles_url = 'https://tiles-a-' + process.env.MAPIC_DOMAIN + '/v2/cubes/';
    }

    // use only one domain for testing
    // var subdomain = (process.env.MAPIC_DOMAIN == 'localhost') ? 'https://172.17.0.1/v2/cubes/' : tiles_url;
    // debugMode && console.log('cube tiles_url', tiles_url);
    return tiles_url;
}

function get_default_cartocss() {
    // raster style
    var defaultCartocss = '';
    defaultCartocss += '#layer {'
    defaultCartocss += 'raster-opacity: 1; '; 
    defaultCartocss += 'raster-colorizer-default-mode: linear; '; 
    defaultCartocss += 'raster-colorizer-default-color: transparent; '; 
    defaultCartocss += 'raster-comp-op: color-dodge;';
    defaultCartocss += 'raster-colorizer-stops: '; 
    defaultCartocss += '  stop(20, rgba(0,0,0,0)) '; 
    defaultCartocss += '  stop(21, #dddddd) '; 
    defaultCartocss += '  stop(100, rgba(6, 255, 63, 0.1)) '; 
    defaultCartocss += '  stop(200, rgba(6, 255, 63, 1.0)) '; 
    defaultCartocss += '  stop(255, rgba(0,0,0,0), exact); '; 
    defaultCartocss += ' }';
    return defaultCartocss;
}


describe('Cubes', function () {
    this.slow(400);
    this.timeout(40000);

    before(function(done) {
        async.series([
            helpers.ensure_test_user_exists,
            helpers.create_project, 
            function (callback) {
                token(function (err, token) {
                    ACCESS_TOKEN = token;
                    callback();
                })
            },
        ], function (err) {
            done(null);
        });
    });

    after(function (done) {
         async.series([
            // helpers.delete_user,
            helpers.delete_project
        ], function (err) {
            done(null);
        });
    });


    // TODO:
    // - add error handling/tests
    // - tiles for different styles, qualities
    // - add cube to project [wu]
    // - get tiles from disk if already exists (problem: what if cube options have changed?? currently same cube_id even if changed options. this won't reflect in cached tiles...)
    // - clean up: delete cubes, datasets that were created during test!


        it('should create empty timeseries layer @ ' + endpoints.cube.create, function (done) {

            // test data, no default options required
            var data = {access_token : ACCESS_TOKEN};

            api.post(endpoints.cube.create)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.exist;
                tmp.created_empty = cube;
                done();
            });
        });

        it('should create timeseries layer with options @ ' + endpoints.cube.create, function (done) {
                
            // test data, no default options required
            var data = {
                access_token : ACCESS_TOKEN,
                options : {
                    type : 'scf',
                    dateformat : 'YYYYMMDD'
                }
            };

            api.post(endpoints.cube.create)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.exist;
                expect(cube.options).to.exist;
                expect(cube.options.type).to.equal('scf');
                expect(cube.options.dateformat).to.equal('YYYYMMDD');
                tmp.created_with_options = cube;
                done();
            });
        });

        it('should create timeseries layer with a dataset @ ' + endpoints.cube.create, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                datasets : ['dataset-uuid-random']
            }

            api.post(endpoints.cube.create)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.exist;
                expect(cube.datasets).to.have.lengthOf(1);
                expect(data.datasets[0]).to.be.oneOf(cube.datasets);
                tmp.created_with_dataset = cube;
                done();
            });
        });

        it('should get timeseries layer by cube_id @ ' + endpoints.cube.get, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id
            }

            api.get(endpoints.cube.get)
            .query(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                done();
            });
        });

        it('should add dataset @ ' + endpoints.cube.add, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    id : 'random-uuid-1',
                    description : 'meta text',
                    timestamp : 'date as string'
                },
                {
                    id : 'random-uuid-2',
                    description : 'meta text',
                    timestamp : 'date as string'
                }]
            };

            api.post(endpoints.cube.add)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.datasets).to.have.lengthOf(2);
                expect(cube.datasets[0].id).to.equal(data.datasets[0].id);
                expect(cube.datasets[0].description).to.equal(data.datasets[0].description);
                expect(cube.datasets[0].timestamp).to.equal(data.datasets[0].timestamp);
                done();
            });
        });

        it('should remove dataset @ ' + endpoints.cube.remove, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    id : 'random-uuid-1',
                },
                {
                    id : 'random-uuid-2',
                }]
            }

            api.post(endpoints.cube.remove)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.datasets).to.have.lengthOf(0);
                done();
            });
        });

        it('should update timeseries layer @ ' + endpoints.cube.update, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id,
                style : get_default_cartocss(),
                quality : 'png8'
            }

            api.post(endpoints.cube.update)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.style).to.equal(data.style);
                expect(cube.quality).to.equal(data.quality);
                done();
            });
        });


        it('should upload dataset @ ' + endpoints.data.import, function (done) {
            api.post(endpoints.data.import)
            .type('form')
            .field('access_token', ACCESS_TOKEN)
            .field('data', fs.createReadStream(path.resolve(__dirname, './open-data/snow_scandinavia_jan.tif')))
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var status = res.body;
                debugMode && console.log(status);
                expect(status.file_id).to.exist;
                expect(status.user_id).to.exist;
                expect(status.upload_success).to.exist;
                expect(status.filename).to.be.equal('snow_scandinavia_jan.tif');
                expect(status.status).to.be.equal('Processing');
                tmp.uploaded_raster = status;
                done();
            });
        });

        it('should upload second dataset @ ' + endpoints.data.import, function (done) {
            api.post(endpoints.data.import)
            .type('form')
            .field('access_token', ACCESS_TOKEN)
            .field('data', fs.createReadStream(path.resolve(__dirname, './open-data/snow_scandinavia_july.tif')))
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var status = res.body;
                debugMode && console.log(status);
                expect(status.file_id).to.exist;
                expect(status.user_id).to.exist;
                expect(status.upload_success).to.exist;
                expect(status.filename).to.be.equal('snow_scandinavia_july.tif');
                expect(status.status).to.be.equal('Processing');
                tmp.uploaded_raster_2 = status;
                done();
            });
        });

        it('should add dataset to timeseries layer @ ' + endpoints.cube.add, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    id : tmp.uploaded_raster.file_id,
                    description : 'Filename: ' + tmp.uploaded_raster.filename,
                    timestamp : moment().format()
                }]
            }

            api.post(endpoints.cube.add)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.datasets).to.have.lengthOf(1);
                expect(cube.datasets[0].id).to.equal(data.datasets[0].id);
                expect(cube.datasets[0].description).to.equal(data.datasets[0].description);
                expect(cube.datasets[0].timestamp).to.equal(data.datasets[0].timestamp);
                done();
            });
        });

        it('should add second dataset to timeseries layer @ ' + endpoints.cube.add, function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    id : tmp.uploaded_raster_2.file_id,
                    description : 'Filename: ' + tmp.uploaded_raster_2.filename,
                    timestamp : moment().format()
                }]
            }

            api.post(endpoints.cube.add)
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.datasets).to.have.lengthOf(2);
                expect(cube.datasets[1].id).to.equal(data.datasets[0].id);
                expect(cube.datasets[1].description).to.equal(data.datasets[0].description);
                expect(cube.datasets[1].timestamp).to.equal(data.datasets[0].timestamp);
                done();
            });
        });

        it('should process raster', function (done) {
            this.timeout(10000);
            this.slow(5000);
            var processingInterval = setInterval(function () {
                api.get(endpoints.data.status)
                .query({ file_id : tmp.uploaded_raster.file_id, access_token : ACCESS_TOKEN})
                .end(function (err, res) {
                    if (err) return done(err);
                    var status = helpers.parse(res.text);
                    if (status.processing_success) {
                        clearInterval(processingInterval);
                        debugMode && console.log(status);
                        expect(status.upload_success).to.exist;
                        expect(status.status).to.be.equal('Done');
                        expect(status.filename).to.be.equal('snow_scandinavia_jan.tif');
                        expect(status.error_code).to.be.null;
                        expect(status.error_text).to.be.null;
                        done();
                    }
                });
            }, 500);
        });

        it('should process second raster', function (done) {
            this.timeout(10000);
            this.slow(5000);
            var processingInterval = setInterval(function () {
                api.get(endpoints.data.status)
                .query({ file_id : tmp.uploaded_raster_2.file_id, access_token : ACCESS_TOKEN})
                .end(function (err, res) {
                    if (err) return done(err);
                    var status = helpers.parse(res.text);
                    if (status.processing_success) {
                        clearInterval(processingInterval);
                        debugMode && console.log(status);
                        expect(status.upload_success).to.exist;
                        expect(status.status).to.be.equal('Done');
                        expect(status.filename).to.be.equal('snow_scandinavia_july.tif');
                        expect(status.error_code).to.be.null;
                        expect(status.error_text).to.be.null;
                        done();
                    }
                });
            }, 500);
        });

        it('should get expected raster-tile from timeseries layer', function (done) {
            this.slow(5000);
            var type = 'png';
            var tile = [7,67,37]; // oslo
            var cube_id = tmp.created_empty.cube_id;
            var tiles_url = base_cubes_url();
            var dataset_uuid = tmp.uploaded_raster.file_id;
            tiles_url += cube_id + '/' + dataset_uuid + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + ACCESS_TOKEN;
            var expected = __dirname + '/open-data/expected-cube-tile-1.png';
            var actual = __dirname + '/open-data/cube-tile-1.png'
            http.get({
                url : tiles_url,
                noSslVerifier : true
            }, actual, function (err, result) {
                if (err) return done(err);
                var e = fs.readFileSync(actual);
                var a = fs.readFileSync(expected);
                assert.ok(Math.abs(e.length - a.length) < 250);
                done();
            });
        });

        it('should get expected second raster-tile from timeseries layer', function (done) {
            this.slow(5000);
            var type = 'png';
            var tile = [7,67,37]; // oslo
            var cube_id = tmp.created_empty.cube_id;
            var tiles_url = base_cubes_url();
            var dataset_uuid = tmp.uploaded_raster_2.file_id;
            tiles_url += cube_id + '/' + dataset_uuid + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + ACCESS_TOKEN;
            var expected = __dirname + '/open-data/expected-cube-tile-2.png';
            var actual = __dirname + '/open-data/cube-tile-2.png'  

            http.get({
                url : tiles_url,
                noSslVerifier : true
            }, actual, function (err, result) {
                if (err) return done(err);
                var e = fs.readFileSync(actual);
                var a = fs.readFileSync(expected);
                assert.ok(Math.abs(e.length - a.length) < 100);
                done();
            });
        });

        it('should get timeseries layer containing two datasets', function (done) {

            // test data
            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.created_empty.cube_id
            }

            api.get(endpoints.cube.get)
            .query(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = res.body;
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.datasets).to.have.lengthOf(2);
                expect(cube.datasets[0].id).to.equal(tmp.uploaded_raster.file_id);
                expect(cube.datasets[1].id).to.equal(tmp.uploaded_raster_2.file_id);

                tmp.cube_with_datasets = cube;
                done();
            });
        });

        it('should create timeseries layer', function (done) {

            var layer = {
                access_token : ACCESS_TOKEN,
                projectUuid : util.test_project_uuid,
                data : { cube : tmp.cube_with_datasets },
                metadata : tmp.uploaded_raster.metadata,
                title : 'Snow raster cube',
                description : 'cube layer description',
                file : 'file-' + tmp.cube_with_datasets.cube_id,
                style : JSON.stringify(get_default_cartocss()) // save default json style
            }

            api.post('/v2/layers/create')
            .send(layer)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var cube = JSON.parse(res.body.data.cube);
                debugMode && console.log(cube);
                expect(cube.timestamp).to.exist;
                expect(cube.createdBy).to.exist;
                expect(cube.cube_id).to.equal(tmp.created_empty.cube_id);
                expect(cube.datasets).to.have.lengthOf(2);
                expect(cube.datasets[0].id).to.equal(tmp.uploaded_raster.file_id);
                expect(cube.datasets[1].id).to.equal(tmp.uploaded_raster_2.file_id);
                done();
            });
        });








        // 
        // pre-rendering
        // -------------

        it('should get pre-render estimate', function (done) {

            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.cube_with_datasets.cube_id
            }

            api.post('/v2/cubes/render/estimate')
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);

                var result = res.body;
                // { success: true,
                //   error: null,
                //   num_tiles: 6550,
                //   estimated_time: 655,
                //   processed_zoom: 9 }

                expect(result.num_tiles).to.be.above(0);
                expect(result.estimated_time).to.be.above(0);
                expect(result.error).to.be.null;
                done();
            });


        });

        it('should get pre-render estimate @ specific zoom level', function (done) {

            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.cube_with_datasets.cube_id,
                max_zoom : 5
            }

            api.post('/v2/cubes/render/estimate')
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);

                var result = res.body;
                // { success: true,
                //   error: null,
                //   num_tiles: 6550,
                //   estimated_time: 655,
                //   processed_zoom: 9 }

                expect(result.processed_zoom).to.equal(data.max_zoom);
                expect(result.num_tiles).to.be.above(0);
                expect(result.estimated_time).to.be.above(0);
                expect(result.error).to.be.null;
                done();
            });
        });

        it('should get pre-render estimate with maxTiles', function (done) {

            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.cube_with_datasets.cube_id,
                max_tiles : 20000
            }

            api.post('/v2/cubes/render/estimate')
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);

                var result = res.body;
                // { success: true,
                //   error: null,
                //   num_tiles: 6550,
                //   estimated_time: 655,
                //   processed_zoom: 9,
                //   max_tiles: 20000 }

                expect(result.num_tiles).to.be.above(0);
                expect(result.estimated_time).to.be.above(0);
                expect(result.error).to.be.null;
                expect(result.max_tiles).to.equal(data.max_tiles);
                done();
            });
        });



        it('should dry-run pre-render job', function (done) {

            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.cube_with_datasets.cube_id,
                dry_run : true
            }

            api.post('/v2/cubes/render/start')
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                
                var result = res.body;
                // { success: true,
                //   error: null,
                //   num_tiles: 6550,
                //   estimated_time: 655,
                //   processed_zoom: 9,
                //   dry_run: true }

                expect(result.error).to.be.null;
                expect(result.dry_run).to.be.true;
                expect(result.num_tiles).to.be.above(0);
                expect(result.estimated_time).to.be.above(0);
                done();
            });


        });

        it('should start pre-render job', function (done) {

            var data = {
                access_token : ACCESS_TOKEN,
                cube_id : tmp.cube_with_datasets.cube_id,
                max_zoom : 3
            }

            api.post('/v2/cubes/render/start')
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                
                var result = res.body;
                // { success: true,
                //   error: null,
                //   num_tiles: 20,
                //   estimated_time: 2,
                //   processed_zoom: 3,
                //   render_job_id: 'render-job-tcjwtbkarm' }

                expect(result.success).to.be.true;
                expect(result.error).to.be.null;
                expect(result.num_tiles).to.be.above(0);
                expect(result.estimated_time).to.be.above(0);
                expect(result.render_job_id).to.exist;
                expect(result.processed_zoom).to.equal(data.max_zoom);
                tmp.render_job_id = result.render_job_id;
                done();
            });


        });

        it('should get pre-render status', function (done) {

            var data = {
                access_token : ACCESS_TOKEN, 
                render_job_id : tmp.render_job_id
            }

            console.log('data:', data);

            api.post('/v2/cubes/render/status')
            .send(data)
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);

                var result = res.body;
                console.log('result', result);
                // { tiles_processed: 0,
                //   finished: false,
                //   num_tiles: 20,
                //   estimated_time: 2,
                //   processed_zoom: 3,
                //   error: null,
                //   render_job_id: 'render-job-nwmfovd' }

                expect(result.finished).to.be.false;
                expect(result.tiles_processed).to.exist;
                expect(result.render_job_id).to.equal(data.render_job_id);
                done();
            });


        });

        it('should get pre-render status with some processed tiles', function (done) {
            this.slow(5000);

            var data = {
                access_token : ACCESS_TOKEN, 
                render_job_id : tmp.render_job_id
            }

            console.log('data', data);

            setTimeout(function () {
                api.post('/v2/cubes/render/status')
                .send(data)
                .expect(httpStatus.OK)
                .end(function (err, res) {
                    if (err) return done(err);

                    var result = res.body;

                    console.log('result', result);
                    // { tiles_processed: 14,
                    //   finished: false,
                    //   num_tiles: 20,
                    //   estimated_time: 2,
                    //   processed_zoom: 3,
                    //   error: null,
                    //   render_job_id: 'render-job-nwmfovd' }

                    expect(result.render_job_id).to.exist;
                    expect(result.tiles_processed).to.not.be.null;
                    done();
                });

            }, 1000);
        });


        it('should get pre-render status when render job is done', function (done) {
            
            var timeout = process.env.TRAVIS ? 20000 : 10000;
            this.slow(timeout * 2);


            var data = {
                access_token : ACCESS_TOKEN, 
                render_job_id : tmp.render_job_id
            }
            console.log('data', data);

            setTimeout(function () {
                api.post('/v2/cubes/render/status')
                .send(data)
                .expect(httpStatus.OK)
                .end(function (err, res) {
                    if (err) return done(err);

                    var result = res.body;
                    console.log('result', result);
                    // { tiles_processed: 20,
                    //   finished: true,
                    //   num_tiles: 20,
                    //   estimated_time: 2,
                    //   processed_zoom: 3,
                    //   error: null,
                    //   render_job_id: 'render-job-mjotcgl',
                    //   processing_time: 3.684,
                    //   tiles_per_second_avg: 5.4288816503800215 }

                    expect(result.render_job_id).to.exist;
                    expect(result.tiles_processed).to.not.be.null;
                    expect(result.tiles_per_second_avg).to.exist;
                    expect(result.processing_time).to.exist;
                    expect(result.finished).to.be.true;
                    done();
                });

            }, timeout);
        });












}); // describe








