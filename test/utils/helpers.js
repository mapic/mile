var assert = require('assert');
var mongoose = require('mongoose');
var async = require('async');
var fs = require('fs-extra');
var request = require('request');
var _ = require('lodash');
var forge = require('node-forge');
var supertest = require('supertest');
var endpoints = require('./endpoints.js');
var testData = require('./helpers.json');
// var access = (process.env.MAPIC_DOMAIN == 'localhost') ? require('./access.localhost.json') : require('./access.ignore.json');
var access = require('./access.localhost.json');

// api
var domain = (process.env.MAPIC_DOMAIN == 'localhost') ? 'https://172.17.0.1' : 'https://' + process.env.MAPIC_DOMAIN;
var api = supertest(domain);

console.log('\nDomain: ', domain);

// Avoids DEPTH_ZERO_SELF_SIGNED_CERT error for self-signed certs
// See https://github.com/systemapic/pile/issues/38
process.env.NODE_TLS_REJECT_UNAUTHORIZED = 0;

module.exports = util = {

    // variables, todo: move to shared file
    test_file: testData.test_file,

    test_layer: testData.test_layer,

    test_user: testData.test_user,

    test_project : {},

    createExpectedError : function (errorMessage) {
        return {
            error: errorMessage
        };
    },

    get_access_token : function (done) {
        api.get(endpoints.users.token.token)
        .query({
            username : testData.test_user.username,
            password : testData.test_user.password,
        })
        .send()
        .end(function (err, res) {
            assert.ifError(err);
            assert.equal(res.status, 200);
            var tokens = util.parse(res.text);
            assert.equal(tokens.token_type, 'multipass');
            assert.equal(_.size(tokens.access_token), 43);
            done(err, tokens);
        });
    },

    token : function (done) {
        util.get_access_token(function (err, tokens) {
            done(err, tokens.access_token);
        });
    },

    get_users_access_token : function (_user, callback) {
      api.get(endpoints.users.token.token)
          .query({
              grant_type : 'password',
              username : _user.email,
              password : _user.password
          })
          .send()
          .end(function (err, res) {
              assert.ifError(err);
              assert.equal(res.status, 200);
              callback(err, util.parse(res.text));
        });
    },

    users_token: function (_user, callback) {
        util.get_users_access_token(_user, function (err, tokens) {
            callback(err, tokens.access_token);
        });
    },

    parse : function (body) {
        try {
            var parsed = JSON.parse(body);
            return parsed;
        } catch (e) {
            console.log('failed to parse:', body);
            throw e;
            return;
        }
    },

    delete_user: function (user_id, callback) {
        util.token(function (err, access_token) {
            testData.test_user.access_token = access_token;
            testData.test_user.user_id = user_id;
            api.post(endpoints.users.delete)
            .send(testData.test_user)
            .end(function (err, res) {
                assert.ifError(err);
                assert.equal(res.status, 200);
                var user = util.parse(res.text);
                assert.ok(user);
                assert.ok(user.uuid);
                done();
            });
        });

    },

    ensure_test_user_exists: function (done) {
        api.post(endpoints.users.create)
        .send(testData.test_user)
        .end(function (err, res) {
            assert.ifError(err);
            var user = util.parse(res.text);
            if ( res.status == 200 ) {
              assert.ok(user);
              assert.ok(user.uuid);
            } else if ( res.status == 400 ) {
              assert.ok(user);
              assert.ok(user.error);
              assert.equal(user.error.message, 'Username is already taken.');
            } else {
              assert.fail(user);
            }
            done();
        });
    },

    create_project : function (done) {
        util.token(function (err, access_token) {

            // random project name
            var project_name = 'mocha-test-' + forge.util.bytesToHex(forge.random.getBytesSync(5));

            api.post(endpoints.projects.create)
            .send({
                name : project_name, 
                access_token : access_token
            })
            .end(function (err, res) {
                assert.ifError(err);
                assert.equal(res.status, 200);
                var project = util.parse(res.text).project;
                assert.ok(project);
                assert.ok(project.uuid);
                assert.equal(project.name, project_name);
                util.test_project.uuid = project.uuid;
                done();
            });
        });
    },

    delete_project : function (done) {
        util.token(function (err, access_token) {
            api.post(endpoints.projects.delete)
            .send({
                projectUuid : util.test_project.uuid, 
                access_token : access_token
            })
            .end(function (err, res) {
                assert.ifError(err);
                assert.equal(res.status, 200);
                done();
            });
        });
    },

    equalFiles : function (files, done) {
        if (!_.isArray(files) || files.length != 2) return done('Error: missing files');
        fs.readFile(files[0], function (err, a) {
            if (err) return done(err);

            fs.readFile(files[1], function (err, b) {
                if (err) return done(err);

                var similar = (a.toString() === b.toString());
                if (!similar) return done('Not expected file!');
                done();
            })

        });


    },

};
