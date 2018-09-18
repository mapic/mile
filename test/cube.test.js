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
                token(function (err, access_token) {
                    tmp.access_token = access_token;
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


        it('should create empty cube @ ' + endpoints.cube.create, function (done) {

                // test data, no default options required
                var data = {access_token : tmp.access_token};

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

        it('should create cube with options @ ' + endpoints.cube.create, function (done) {
                
            // test data, no default options required
            var data = {
                access_token : tmp.access_token,
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

        it('should create cube with a dataset @ ' + endpoints.cube.create, function (done) {

            // test data
            var data = {
                access_token : tmp.access_token,
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

        it('should get cube by cube_id @ ' + endpoints.cube.get, function (done) {

            // test data
            var data = {
                access_token : tmp.access_token,
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
                access_token : tmp.access_token,
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
                access_token : tmp.access_token,
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

        it('should update cube @ ' + endpoints.cube.update, function (done) {

            // test data
            var data = {
                access_token : tmp.access_token,
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
            token(function (err, access_token) {
                api.post(endpoints.data.import)
                .type('form')
                .field('access_token', access_token)
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
        });

        it('should upload second dataset @ ' + endpoints.data.import, function (done) {
            token(function (err, access_token) {
                api.post(endpoints.data.import)
                .type('form')
                .field('access_token', access_token)
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
        });

        it('should add dataset to cube @ ' + endpoints.cube.add, function (done) {
            token(function (err, access_token) {

                // test data
                var data = {
                    access_token : access_token,
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
        });

        it('should add second dataset to cube @ ' + endpoints.cube.add, function (done) {
            token(function (err, access_token) {

                // test data
                var data = {
                    access_token : access_token,
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
        });

        it('should process raster', function (done) {
            this.timeout(10000);
            this.slow(5000);
            token(function (err, access_token) {
                var processingInterval = setInterval(function () {
                    api.get(endpoints.data.status)
                    .query({ file_id : tmp.uploaded_raster.file_id, access_token : access_token})
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
        });

        it('should process second raster', function (done) {
            this.timeout(10000);
            this.slow(5000);
            token(function (err, access_token) {
                var processingInterval = setInterval(function () {
                    api.get(endpoints.data.status)
                    .query({ file_id : tmp.uploaded_raster_2.file_id, access_token : access_token})
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
        });

        it('should get expected raster-tile from cube', function (done) {
            this.slow(5000);
            token(function (err, access_token) {
                var type = 'png';
                var tile = [7,67,37]; // oslo
                var cube_id = tmp.created_empty.cube_id;
                var tiles_url = base_cubes_url();
                var dataset_uuid = tmp.uploaded_raster.file_id;
                tiles_url += cube_id + '/' + dataset_uuid + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + access_token;
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
        });

        it('should get expected second raster-tile from cube', function (done) {
            this.slow(5000);
            token(function (err, access_token) {
                var type = 'png';
                var tile = [7,67,37]; // oslo
                var cube_id = tmp.created_empty.cube_id;
                var tiles_url = base_cubes_url();
                var dataset_uuid = tmp.uploaded_raster_2.file_id;
                tiles_url += cube_id + '/' + dataset_uuid + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + access_token;
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
        });

        it('should get cube containing two datasets', function (done) {
            token(function (err, access_token) {

                // test data
                var data = {
                    access_token : access_token,
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
        });

        it('should create CubeLayer on Mapic API', function (done) {
            token(function (err, access_token) {

                var layer = {
                    access_token : access_token,
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
        });






}); // describe








