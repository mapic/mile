var assert = require('assert');
var mongoose = require('mongoose');
var async = require('async');
var fs = require('fs-extra');
var crypto = require('crypto');
var request = require('request');
var supertest = require('supertest');
var api = supertest('https://' + process.env.SYSTEMAPIC_DOMAIN);
var path = require('path');
var httpStatus = require('http-status');
var chai = require('chai');
var expect = chai.expect;
var http = require('http-request');
var assert = require('assert');

// helpers
var endpoints = require('./endpoints');
var helpers = require('./helpers');
var token = helpers.token;

// config
var config = require(process.env.WU_CONFIG_PATH || '/systemapic/config/wu-config.js').clientConfig;

// logs
var debugMode = process.env.SYSTEMAPIC_DEBUG;
var debugMode = true; // override

var tmp = {};

// Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs
// See https://github.com/systemapic/pile/issues/38
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// helper fn for tile url
function base_cubes_url() {
    var subdomain = config.servers.cubes.uri;
    var tiles_url = subdomain.replace('{s}', config.servers.cubes.subdomains[0]);
    return tiles_url;
}

function get_default_cartocss() {
    // raster debug
    var defaultCartocss = '';
    defaultCartocss += '#layer {'
    defaultCartocss += 'raster-opacity: 1; '; 
    // defaultCartocss += 'raster-scaling: gaussian; '; 
    defaultCartocss += 'raster-colorizer-default-mode: linear; '; 
    defaultCartocss += 'raster-colorizer-default-color: transparent; '; 
    defaultCartocss += 'raster-comp-op: color-dodge;';
    defaultCartocss += 'raster-colorizer-stops: '; 
    // white to blue
    defaultCartocss += '  stop(20, rgba(0,0,0,0)) '; 
    defaultCartocss += '  stop(21, #dddddd) '; 
    defaultCartocss += '  stop(200, #0078ff) '; 
    defaultCartocss += '  stop(255, rgba(0,0,0,0), exact); '; 
    defaultCartocss += ' }';
    return defaultCartocss;
}


describe('Datacube', function () {
    this.slow(400);

    before(function(done) {
        helpers.ensure_test_user_exists(done);
    });


    // [pile]
    // ------
    // 1. post to API to create an empty datacube
    // 2. upload dataset (raster) normally
    // 3. add uploaded dataset uuid to datacube
    // 4. set styling, png quality, other options to datacube, which will be common for all datasets
    // 5. request tile from datacube - with correct styling, correct dataset, etc.
    
    // [wu]
    // ----
    // (in client, showing a datacube means adding each layer in separate overlay and doing anim etc.)
    // 1. create a Wu.Cubelayer
    // 2. add pile-cube to wu-cube
    // 3. request tiles 

    // problems:
    // - how to decide the order of datasets? update with new order; order of dataset array decides.
    // - how to add timeseries metadata (like dates) to cube? use a generic text field for metadata + a date field.
    // - how to use same style on all layers in cube? request tiles at /cube/ with array number
    // - how to make all of this easy for globesar? create scripts for uploading, adding to cube. simple GUI for choosing style. 


    // configs modified:
    // - nginx (/v2/cubes route)
    // - wu (cubes tile requests)


    // TODO:
    // - add error handling/tests
    // - tiles for different styles, qualities

    it('should create empty cube @ ' + endpoints.cube.create, function (done) {
        token(function (err, access_token) {
            
            // test data, no default options required
            var data = {access_token : access_token};

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
    });

    it('create cube with a dataset @ ' + endpoints.cube.create, function (done) {
        token(function (err, access_token) {

            // test data
            var data = {
                access_token : access_token,
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
    });

    it('get cube by cube_id @ ' + endpoints.cube.get, function (done) {
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
                done();
            });
        });
    });

    it('add dataset @ ' + endpoints.cube.add, function (done) {
        token(function (err, access_token) {

            // test data
            var data = {
                access_token : access_token,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    uuid : 'random-uuid-1',
                    meta : {
                        text : 'meta text',
                        date : 'date as string'
                    }
                },
                {
                    uuid : 'random-uuid-2',
                    meta : {
                        text : 'meta text',
                        date : 'date as string'
                    }
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
                expect(cube.datasets[0].uuid).to.equal(data.datasets[0].uuid);
                done();
            });
        });
    });

    it('remove dataset @ ' + endpoints.cube.remove, function (done) {
        token(function (err, access_token) {

            // test data
            var data = {
                access_token : access_token,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    uuid : 'random-uuid-1',
                },
                {
                    uuid : 'random-uuid-2',
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
    });

    it('update dataset @ ' + endpoints.cube.update, function (done) {
        token(function (err, access_token) {

            // test data
            var data = {
                access_token : access_token,
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
    });

    it('upload dataset @ ' + endpoints.import.post, function (done) {
        token(function (err, access_token) {
            api.post(endpoints.import.post)
            .type('form')
            .field('access_token', access_token)
            .field('data', fs.createReadStream(path.resolve(__dirname, './open-data/snow.raster.200.tif')))
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var status = res.body;
                if (debugMode) console.log(status);
                expect(status.file_id).to.exist;
                expect(status.user_id).to.exist;
                expect(status.upload_success).to.exist;
                expect(status.filename).to.be.equal('snow.raster.200.tif');
                expect(status.status).to.be.equal('Processing');
                tmp.uploaded_raster = status;
                done();
            });
        });
    });

    it('upload second dataset @ ' + endpoints.import.post, function (done) {
        token(function (err, access_token) {
            api.post(endpoints.import.post)
            .type('form')
            .field('access_token', access_token)
            .field('data', fs.createReadStream(path.resolve(__dirname, './open-data/snow.raster.2.200.tif')))
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);
                var status = res.body;
                if (debugMode) console.log(status);
                expect(status.file_id).to.exist;
                expect(status.user_id).to.exist;
                expect(status.upload_success).to.exist;
                expect(status.filename).to.be.equal('snow.raster.2.200.tif');
                expect(status.status).to.be.equal('Processing');
                tmp.uploaded_raster_2 = status;
                done();
            });
        });
    });

    it('add raster to cube @ ' + endpoints.cube.add, function (done) {
        token(function (err, access_token) {

            // test data
            var data = {
                access_token : access_token,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    uuid : tmp.uploaded_raster.file_id,
                    meta : {
                        text : 'Filename: ' + tmp.uploaded_raster.filename,
                        date : new Date().toString()
                    }
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
                expect(cube.datasets[0].uuid).to.equal(data.datasets[0].uuid);
                expect(cube.datasets[0].meta.text).to.equal(data.datasets[0].meta.text);
                expect(cube.datasets[0].meta.date).to.equal(data.datasets[0].meta.date);
                done();
            });
        });
    });

    it('add second raster to cube @ ' + endpoints.cube.add, function (done) {
        token(function (err, access_token) {

            // test data
            var data = {
                access_token : access_token,
                cube_id : tmp.created_empty.cube_id,
                datasets : [{
                    uuid : tmp.uploaded_raster_2.file_id,
                    meta : {
                        text : 'Filename: ' + tmp.uploaded_raster_2.filename,
                        date : new Date().toString()
                    }
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
                expect(cube.datasets[1].uuid).to.equal(data.datasets[0].uuid);
                expect(cube.datasets[1].meta.text).to.equal(data.datasets[0].meta.text);
                expect(cube.datasets[1].meta.date).to.equal(data.datasets[0].meta.date);
                done();
            });
        });
    });

    it('should process raster', function (done) {
        this.timeout(10000);
        this.slow(2000);
        token(function (err, access_token) {
            var processingInterval = setInterval(function () {
                process.stdout.write('.');
                api.get(endpoints.import.status)
                .query({ file_id : tmp.uploaded_raster.file_id, access_token : access_token})
                .end(function (err, res) {
                    if (err) return done(err);
                    var status = helpers.parse(res.text);
                    if (status.processing_success) {
                        clearInterval(processingInterval);
                        if (debugMode) console.log(status);
                        expect(status.upload_success).to.exist;
                        expect(status.status).to.be.equal('Done');
                        expect(status.filename).to.be.equal('snow.raster.200.tif');
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
        this.slow(2000);
        token(function (err, access_token) {
            var processingInterval = setInterval(function () {
                process.stdout.write('.');
                api.get(endpoints.import.status)
                .query({ file_id : tmp.uploaded_raster_2.file_id, access_token : access_token})
                .end(function (err, res) {
                    if (err) return done(err);
                    var status = helpers.parse(res.text);
                    if (status.processing_success) {
                        clearInterval(processingInterval);
                        if (debugMode) console.log(status);
                        expect(status.upload_success).to.exist;
                        expect(status.status).to.be.equal('Done');
                        expect(status.filename).to.be.equal('snow.raster.2.200.tif');
                        expect(status.error_code).to.be.null;
                        expect(status.error_text).to.be.null;
                        done();
                    }
                });
            }, 500);
        });
    });

    it('should get expected raster-tile from cube @ ' + base_cubes_url(), function (done) {
        token(function (err, access_token) {
            var type = 'png';
            var tile = [7,67,37]; // oslo
            var cube_id = tmp.created_empty.cube_id;
            var tiles_url = base_cubes_url();
            var dataset_uuid = tmp.uploaded_raster.file_id;
            tiles_url += cube_id + '/' + dataset_uuid + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + access_token;
            var expected = 'test/open-data/expected-cube-tile-1.png';
            var actual = 'test/tmp/cube-tile-1.png'

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

    it('should get expected second raster-tile from cube @ ' + base_cubes_url(), function (done) {
        token(function (err, access_token) {
            var type = 'png';
            var tile = [7,67,37]; // oslo
            var cube_id = tmp.created_empty.cube_id;
            var tiles_url = base_cubes_url();
            var dataset_uuid = tmp.uploaded_raster_2.file_id;
            tiles_url += cube_id + '/' + dataset_uuid + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + access_token;
            var expected = 'test/open-data/expected-cube-tile-2.png';
            var actual = 'test/tmp/cube-tile-2.png'   

            debugMode && console.log('tiles_url: ', tiles_url);

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

    it('cube should contain two datasets', function (done) {
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
                expect(cube.datasets[0].uuid).to.equal(tmp.uploaded_raster.file_id);
                expect(cube.datasets[1].uuid).to.equal(tmp.uploaded_raster_2.file_id);
                done();
            });
        });
    });

});
