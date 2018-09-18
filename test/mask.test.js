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

    context('create', function () {

        it('should have mask tests', function (done) {
                done();

        });

        it('should create empty test layer', function (done) {

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
            api.post(endpoints.cube.mask)
            .send({
                access_token : tmp.access_token,
                cube_id : tmp.layer.cube_id,
                mask : {
                    type : 'geojson',
                    geometry : null
                }
            })
            .end(function (err, res) {
                if (err) return done(err);
                var mask = res.body;
                expect(mask.type).to.equal('geojson');
                expect(mask.id).to.exist;
                tmp.mask = mask;
                done();
            });

        });

        it('should add data to mask discreetly', function (done) {
            api.post(endpoints.cube.updateMask)
            .send({
                access_token : tmp.access_token,
                cube_id : tmp.layer.cube_id,
                mask : {
                    id : tmp.mask.id,
                    data : 'test-data'
                }
            })
            .end(function (err, res) {
                if (err) return done(err);
                var mask = res.body;
                expect(mask.type).to.equal('geojson'); // 
                expect(mask.id).to.equal(tmp.mask.id);
                expect(mask.data).to.equal('test-data');
                tmp.mask = mask;
                done();
            });
        });

        it('should delete test layer', function (done) {
            api.post(endpoints.cube.deleteCube)
            .send({
                access_token : tmp.access_token,
                cube_id : tmp.layer.cube_id
            })
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


});








