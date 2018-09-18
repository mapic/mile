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

var CUBE_ID = 'cube-4058a673-c0e0-4bad-a6ad-7e0039489540'

var CUBE_DATA = JSON.parse(fs.readFileSync('cube-data.json', 'utf-8'));

console.log('CUBE_DATA:')
console.log(CUBE_DATA);
console.log('typeof CUBE_DATA', typeof CUBE_DATA);
// return;

// Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs
// See https://github.com/systemapic/pile/issues/38
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;


token(function (err, access_token) {

    // test data
    CUBE_DATA.access_token = access_token;
    CUBE_DATA.cube_id = CUBE_ID;

    api.post(endpoints.cube.update)
    .send(CUBE_DATA)
    .expect(httpStatus.OK)
    .end(function (err, res) {
        if (err) return done(err);
        var cube = res.body;
        console.log(JSON.stringify(cube));
       
    });
});

