var assert = require('assert');
var mongoose = require('mongoose');
var async = require('async');
var fs = require('fs-extra');
var crypto = require('crypto');
var request = require('request');
var supertest = require('supertest');
var _ = require('lodash');
var path = require('path');
var httpStatus = require('http-status');
var chai = require('chai');
var expect = chai.expect;
var http = require('http-request');
var assert = require('assert');

// api
var domain = (process.env.MAPIC_DOMAIN == 'localhost') ? 'https://172.17.0.1' : 'https://' + process.env.MAPIC_DOMAIN;
var api = supertest(domain);

// helpers
var endpoints = require(__dirname + '/utils/endpoints');
var helpers = require(__dirname + '/utils/helpers');
var token = helpers.token;

var tmp = {};

var debugMode = process.env.MAPIC_DEBUG;

// Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs
// See https://github.com/systemapic/pile/issues/38
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function base_tiles_url() {
    var subdomain = process.env.MAPIC_ENGINE_TILES_URL;

    // override for localhost
    if (_.includes(subdomain, 'localhost')) {
        subdomain = domain + subdomain.split('https://localhost')[1];
    }
    
    var sub = process.env.MAPIC_ENGINE_TILES_SUBDOMAINS.replace('"', '').split(',');
    debugMode && console.log('raster sub: ', sub);
    var tiles_url = subdomain.replace('{s}', sub);
    debugMode && console.log('raster tiles_url: ', tiles_url);
    return tiles_url;
}

describe('Raster', function () {
    this.slow(400);
    this.timeout(30000);

    before(function(done) {
      helpers.ensure_test_user_exists(done);
    });


    it('should upload', function (done) {
        token(function (err, access_token) {
            api.post(endpoints.data.import)
            .type('form')
            .field('access_token', access_token)
            .field('data', fs.createReadStream(path.resolve(__dirname, './open-data/snow.raster.200.tif')))
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);

                var result = res.body;
                if (debugMode) {
                    console.log('\n\n\n');
                    console.log('Upload status: POST', endpoints.data.import, '[wu]:')
                    console.log('------------------------------------------')
                    console.log(result);
                }

                expect(result.file_id).to.exist;
                expect(result.user_id).to.exist;
                expect(result.upload_success).to.exist;
                expect(result.filename).to.be.equal('snow.raster.200.tif');
                expect(result.status).to.be.equal('Processing');

                tmp.upload_status = result;
                
                done();
            });
        });
    });

    it('should have a status', function (done) {
        token(function (err, access_token) {
            api.get(endpoints.data.status)
            .query({file_id : tmp.upload_status.file_id, access_token : access_token})
            .expect(httpStatus.OK)
            .end(function (err, res) {
                if (err) return done(err);

                var result = helpers.parse(res.text);

                expect(result.file_id).to.exist;
                expect(result.user_id).to.exist;
                expect(result.upload_success).to.exist;
                expect(result.upload_success).to.be.true;
                expect(result.filename).to.be.equal('snow.raster.200.tif');
                expect(result.status).to.be.equal('Processing');
                done();
            });
        });
    });

    it('should process', function (done) {
        this.slow(5000);
        this.timeout(30000);

        // check for processing status
        token(function (err, access_token) {
            var processingInterval = setInterval(function () {
                process.stdout.write('.');
                api.get(endpoints.data.status)
                .query({ file_id : tmp.upload_status.file_id, access_token : access_token})
                .end(function (err, res) {
                    if (err) return done(err);

                    var status = helpers.parse(res.text);

                    if (status.processing_success) {

                        clearInterval(processingInterval);

                        if (debugMode) {
                            console.log('\n\n\n');
                            console.log('Upload status: when done processing', '[wu]:');
                            console.log('------------------------------------------')
                            console.log(status);
                        }

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


    it('should create a raster layer', function (done) {
        this.timeout(30000);
        token(function (err, access_token) {

            var layer = {
                geom_column: 'the_geom_3857',
                geom_type: 'geometry',
                raster_band: '',
                data_type : 'raster',
                srid: '',
                affected_tables: '',
                interactivity: '',
                attributes: '',
                access_token: access_token,
                cartocss_version: '2.0.1',
                "cartocss": "#layer { raster-opacity:1.0 }",
                sql: '(SELECT * FROM ' + tmp.upload_status.file_id + ') as sub',
                file_id: tmp.upload_status.file_id,
                return_model: true,
            }

            if (debugMode) {
                console.log('\n\n\n');
                console.log('Layer options POSTed to ', endpoints.tiles.create, '[pile]:');
                console.log('------------------------------------------')
                console.log(layer);
            }
            
            api.post(endpoints.tiles.create)
            .send(layer)
            .end(function (err, res) {
                if (err) return done(err);

                var status = res.body;

                if (debugMode) {
                    console.log('\n\n\n');
                    console.log('Layer returned from', endpoints.tiles.create, '[pile]:');
                    console.log('------------------------------------------')
                    console.log(status);
                }

                expect(status.layerUuid).to.exist;
                expect(status.options.layer_id).to.exist;
                expect(status.options.file_id).to.be.equal(tmp.upload_status.file_id);
                expect(status.options.data_type).to.be.equal('raster');

                tmp.raster_layer = status;

                done();
            });
        });
    });


    it.skip('should get expected raster-tile from raster', function (done) {
        this.timeout(30000);
        
        token(function (err, access_token) {

            var type = 'png';
            var tile = [7,67,37];
            var layer_id = tmp.raster_layer.options.layer_id;
            var tiles_url = base_tiles_url();
            tiles_url += layer_id + '/' + tile[0] + '/' + tile[1] + '/' + tile[2] + '.' + type + '?access_token=' + access_token;
            
            // files (todo: cleanup)
            var expected = 'test/open-data/snow.raster.tile-7-65-35.expected.png';
            var actual = 'test/tmp/test-tile.png'

            http.get({
                url : tiles_url,
                // We don't need ssl validation during tests
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

});
