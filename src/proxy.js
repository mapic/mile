// dependencies
var _ = require('lodash');
var fs = require('fs-extra');
var kue = require('kue');
var path = require('path');
var zlib = require('zlib');
var uuid = require('uuid');
var async = require('async');
var redis = require('redis');
var carto = require('carto');
var mapnik = require('mapnik');
var colors = require('colors');
var cluster = require('cluster');
var numCPUs = require('os').cpus().length;
var mongoose = require('mongoose');
var request = require('request');
var http = require('http-request');

// global paths
var VECTORPATH   = '/data/vector_tiles/';
var RASTERPATH   = '/data/raster_tiles/';
var GRIDPATH     = '/data/grid_tiles/';
var PROXYPATH 	 = '/data/proxy_tiles/';


const S3_BUCKETNAME = 'mapic-s3.proxy-tiles.mapic.io';

try {
	var AWS = require('aws-sdk');
	var s3 = new AWS.S3({region: 'eu-central-1'});
} catch (e) {
	console.log('AWS error: ', e);
};

module.exports = proxy = { 

	headers : {
		jpeg : 'image/jpeg',
		png : 'image/png',
		pbf : 'application/x-protobuf',
		grid : 'application/json'
	},


    serveProxyTile : function (req, res) {

    	// parse url, set options
        var params = req.params[0].split('/');
        var options = {
            provider : params[0],
            type     : params[1],
            z        : params[2],
            x        : params[3],
            y        : params[4].split('.')[0],
            format   : params[4].split('.')[1]
        }

        // get proxy tile from S3 or fetch
        proxy.getProxyTile(options, function (err, buffer) {

        	// return tile to client
            proxy.serveTile(res, options, buffer);

        });

    },

    // return tiles from disk or create
    getProxyTile : function (options, done) {

        // check S3 bucket
        proxy.getProxyTileS3(options, function (err, data) {
            if (err) console.log('getProxyTile err: ', err);
            
            // return data if any (and not forced render)
            if (!options.force_render && data) {
                console.log('Serving cached proxy tile');
                return done(null, data); // debug, turned off to create every time
            }
            
            // fetch tile from provider
            proxy.fetchProxyTile(options, done);

        });
    },

    getProxyTileS3 : function (options, done) {
        var keyString = 'proxy_tile:' + options.provider + ':' + options.z + ':' + options.x + ':' + options.y + '.' + options.format;
        var params = {Bucket: S3_BUCKETNAME, Key: keyString};
        s3.getObject(params, function(err, data) {
            if (err || !data) return done(null);
            done(null, data.Body);
        });
    },

    // read/write to AWS S3
    putProxyTileS3 : function (buffer, options, done) {
        var keyString = 'proxy_tile:' + options.provider + ':' + options.z + ':' + options.x + ':' + options.y + '.' + options.format;
        s3.putObject({
            Bucket: S3_BUCKETNAME,
            Key: keyString,
            Body: buffer
        }, function (err, response) {
        	if (err) console.log('err saving proxy tile to S3', err, options);
            done && done(null);
        });
    },
    

    fetchProxyTile : function (options, done) {

    	// pass to provider
		if (options.provider == 'norkart') return proxy._fetchNorkartTile(options, done);
		if (options.provider == 'google')  return proxy._fetchGoogleTile(options, done);

		// error
		console.log('No proxy provider assigned!', options);
		return done('Missing proxy provider key.');

    },

    _fetchGoogleTile : function (options, done) {

		// url schemes
		var google_types = {
			vector: "http://mt0.google.com/vt/",
            aerial : "http://mt0.google.com/vt/lyrs=s&hl=en&"
		}

		// google url
		var url = google_types[options.type] + 'x=' + options.x + '&y=' + options.y + '&z=' + options.z;

		// set url, headers
		options.url = url;
		options.headers = {
			'User-Agent' : 'Mapic Tile Proxy',
			'Referer' : 'https://mapic.io',
			'X-Message-For-Google' : 'Hi Google!',
			'X-Google-Server-API-Key' : 'AIzaSyA-aG1H1KYHOYE-as-dxIqqSLr1RJZJs-g'
		}

		// fetch
		proxy._fetchProxyTile(options, done);
	},

	_fetchNorkartTile : function (options, done) {

		// url schemes
		var norkart_types = {
			vector: "webatlas-standard-vektor",
			aerial: "webatlas-orto-newup",
			hybrid: "webatlas-standard-hybrid"
		}

		// set url and header
		var url = 'https://www.webatlas.no/maptiles/tiles/' + norkart_types[options.type] + '/wa_grid/' + options.z + '/' + options.x + '/' + options.y + '.' + options.format;
		options.url = url;
		options.headers = {
			'User-Agent' : 'Mapic Tile Proxy',
			'Referer' : 'https://mapic.io/',
			'X-Message-For-Norkart' : 'We are proxying because we need four subdomains for speedy tile requests.'
		}

		// fetch
		proxy._fetchProxyTile(options, done);

	},

	serveTile : function (res, options, buffer) {

		// send tile to client
		res.writeHead(200, {'Content-Type': proxy.headers[options.format]}); 
		res.end(buffer);
	},

	serveErrorTile : function (res) {
		var errorTile = 'public/errorTile.png';
		fs.readFile('public/noAccessTile.png', function (err, tile) {
			res.writeHead(200, {'Content-Type': 'image/png'});
			res.end(tile);
		});
	},

	_fetchProxyTile : function (options, done) {

		var httpOptions = {
			url: options.url,
			timeout : '10000',
			headers : options.headers
		};

		// get tile
		http.get(httpOptions, function (err, response) {
			if (err) {
				console.log('_fetchProxyTile http err:', err);
				return done(err);
			}
			
			// save to S3 (no need to wait)
			proxy.putProxyTileS3(response.buffer, options);

			// return tile buffer
			return done(null, response.buffer);
		
		});
		
	},

	_tile2lng : function (x,z) {
		return (x/Math.pow(2,z)*360-180);
	},

	_tile2lat : function (y,z) {
		var n=Math.PI-2*Math.PI*y/Math.pow(2,z);
		return (180/Math.PI*Math.atan(0.5*(Math.exp(n)-Math.exp(-n))));
	},

}
