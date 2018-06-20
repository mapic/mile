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

