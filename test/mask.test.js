var assert = require('assert');
var mongoose = require('mongoose');
var crypto = require('crypto');
var request = require('request');
var supertest = require('supertest');
var path = require('path');
var httpStatus = require('http-status');
var chai = require('chai');
var expect = chai.expect;
var http = require('http-request');
var moment = require('moment');
var async = require('async');
var fs = require('fs-extra');
var _ = require('lodash');
var domain = (process.env.MAPIC_DOMAIN == 'localhost') ? 'https://172.17.0.1' : 'https://' + process.env.MAPIC_DOMAIN;
var api = supertest(domain);

var endpoints = require(__dirname + '/utils/endpoints');
var helpers = require(__dirname + '/utils/helpers');
var getToken = helpers.token;

var tmp = {};

describe('Masks', function () {
    this.slow(400);
    this.timeout(40000);

    before(function(done) {
        getToken(function (err, token) {
            tmp.access_token = token;
            done(err);
        });
    });


    it('should create empty layer', function (done) {

        api.post(endpoints.cube.create)
        .send({ access_token : tmp.access_token })
        .end(function (err, res) {
            if (err) return done(err);
            var layer = res.body;
            expect(layer.timestamp).to.exist;
            expect(layer.createdBy).to.exist;
            expect(layer.cube_id).to.exist;
            tmp.layer = layer;
            done();
        });
    });

    it('should create empty mask in layer', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask : {
                type : 'geojson',
                geometry : null
            }
        };
        api.post(endpoints.cube.mask)
        .send(testData)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.type).to.equal('geojson');
            expect(mask.id).to.exist;
            tmp.mask = mask;
            done();
        });

    });

    it('should create mask with geojson', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask : {
                type : 'geojson',
                geometry : '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[9.2230224609375,58.91031927906605],[9.2230224609375,59.6705145897832],[10.6182861328125,59.6705145897832],[10.6182861328125,58.91031927906605],[9.2230224609375,58.91031927906605]]]}}]}',
            }
        };
        api.post(endpoints.cube.mask)
        .send(testData)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.type).to.equal('geojson');
            expect(mask.geometry).to.equal(testData.mask.geometry);
            expect(mask.id).to.exist;
            done();
        });
    });

    it('should create mask with topojson', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask : {
                type : 'topojson',
                geometry : '{"type":"Topology","objects":{"collection":{"type":"GeometryCollection","geometries":[{"type":"Polygon","arcs":[[0]]}]}},"arcs":[[[0,0],[0,9999],[9999,0],[0,-9999],[-9999,0]]],"transform":{"scale":[0.00013954032121962193,0.00007602713378509362],"translate":[9.2230224609375,58.91031927906605]},"bbox":[9.2230224609375,58.91031927906605,10.6182861328125,59.6705145897832]}'
            }
        }
        api.post(endpoints.cube.mask)
        .send(testData)
        .expect(httpStatus.OK)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.geometry).to.equal(testData.mask.geometry);
            expect(mask.type).to.equal('topojson');
            expect(mask.id).to.exist;
            done();
        });
    });

    it('should create mask with meta information and geometry', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask : {
                type : 'geojson',
                geometry : {"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[9.2230224609375,58.91031927906605],[9.2230224609375,59.6705145897832],[10.6182861328125,59.6705145897832],[10.6182861328125,58.91031927906605],[9.2230224609375,58.91031927906605]]]}}]},
                meta : {
                    "title" : "hallingdal",
                    "description" : "description",
                    "område" : "hallingdal",
                    "kraftverk" : "mår",
                    "feltnavn" : "aka title",
                    "areal" : "338.45 km2",
                    "årlig tilsig" : "323 mm"
                },
                data : 'string'
            },
        };
        api.post(endpoints.cube.mask)
        .send(testData)
        .expect(httpStatus.OK)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.data).to.exist;
            expect(mask.meta).to.exist;
            expect(mask.meta.title).to.equal('hallingdal');
            expect(mask.meta['årlig tilsig']).to.equal('323 mm');
            expect(mask.data).to.equal('string');
            expect(mask.type).to.equal('geojson');
            expect(mask.geometry).to.exist;
            expect(mask.id).to.exist;
            done();
        });
    });

    it('should update mask data discreetly', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask : {
                id : tmp.mask.id,
                data : 'test-data'
            }
        };
        api.post(endpoints.cube.updateMask)
        .send(testData)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.type).to.equal('geojson'); 
            expect(mask.id).to.equal(tmp.mask.id);
            expect(mask.data).to.equal('test-data');
            done();
        });
    });

    it('should update mask geojson discreetly', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask : {
                id : tmp.mask.id,
                type : 'geojson',
                geometry : '{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[9.2230224609375,58.91031927906605],[9.2230224609375,59.6705145897832],[10.6182861328125,59.6705145897832],[10.6182861328125,58.91031927906605],[9.2230224609375,58.91031927906605]]]}}]}',
            }
        };
        api.post(endpoints.cube.updateMask)
        .send(testData)
        .expect(httpStatus.OK)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.type).to.equal('geojson');
            expect(mask.geometry).to.equal(testData.mask.geometry);
            expect(mask.id).to.exist;
            done();
        });
    });

    it('should get mask', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask_id : tmp.mask.id
        };
        api.post(endpoints.cube.getMask)
        .send(testData)
        .expect(httpStatus.OK)
        .end(function (err, res) {
            if (err) return done(err);
            var mask = res.body;
            expect(mask.type).to.exist;
            expect(mask.geometry).to.exist;
            expect(mask.id).to.equal(testData.mask_id);
            done();
        });
    });

    it('should get layer with masks', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id
        };
        api.get(endpoints.cube.get)
        .send(testData)
        .end(function (err, res) {
            if (err) return done(err);
            var layer = res.body;
            expect(layer.cube_id).to.equal(testData.cube_id);
            expect(_.size(layer.masks)).to.equal(4);
            done();
        });

    });

    it('should remove mask', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id,
            mask_id : tmp.mask.id
        };
        api.post(endpoints.cube.unmask)
        .send(testData)
        .expect(httpStatus.OK)
        .end(function (err, res) {
            if (err) return done(err);
            var cube = res.body;
            expect(cube.timestamp).to.exist;
            expect(cube.createdBy).to.exist;
            expect(_.size(cube.masks)).to.equal(3);
            expect(cube.cube_id).to.equal(tmp.layer.cube_id);
            done();
        });
    });

    // todo:
    // it('should throw on invalid geometry', function (done) {
    //     var testData = {
    //         access_token : tmp.access_token,
    //         cube_id : tmp.layer.cube_id,
    //         mask : {
    //             type : 'geojson',
    //             geometry : 'invalid topojson'
    //         }
    //     };
    //     api.post(endpoints.cube.mask)
    //     .send(testData)
    //     // .expect(400)
    //     .end(function (err, res) {
    //         console.log('err?', err);
    //         // if (err) return done(err);
    //         var error = res.body;
    //         console.log('res.body', res.body);
    //         expect(error).to.exist;
    //         expect(error.error_code).to.exist;
    //         expect(error.error).to.exist;
    //         done();
    //     });
    // });

    it('should remove layer', function (done) {
        var testData = {
            access_token : tmp.access_token,
            cube_id : tmp.layer.cube_id
        };
        api.post(endpoints.cube.deleteCube)
        .send(testData)
        .expect(httpStatus.OK)
        .end(function (err, res) {
            if (err) return done(err);
            var status = res.body;
            expect(status.error).to.be.null;
            expect(status.success).to.be.true;
            done();
        });
    });







});








