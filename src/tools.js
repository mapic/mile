// dependencies
var _ = require('lodash');
var fs = require('fs-extra');
var request = require('request');

module.exports = tools = { 

	tileIsProxy : function (req) {
		var params = req.params[0].split('/');
		var provider = params[0];
		var isProxy = _.includes(mile.proxyProviders, provider);
		return isProxy;
	},

	tileIsPostgis : function (req) {
		var params = req.params[0].split('/');
		var layer_id = params[0];
		var isPostgis = _.includes(layer_id, 'layer_id-');
		return isPostgis;
	},

	_calculateAverages : function (points) {

		var keys = {};

		// get keys
		for (var key in points[0]) {
			keys[key] = [];
		}

		// sum values
		points.forEach(function (p) {
			for (var key in p) {
				keys[key].push(p[key]);
			}
		});

		// calc avg
		var averages = {};
		for (var k in keys) {
			averages[k] = (_.sum(keys[k]) / keys[k].length)
		}

		return averages;
	},

	safeParse : function (string, quiet) {
		try {
			var o = JSON.parse(string);
			return o;
		} catch (e) {
			if (!quiet) console.log('JSON.parse error of string:', string, e);
			return false;
		}
	},

	safeStringify : function (o) {
		try {
			var s = JSON.stringify(o);
			return s;
		} catch (e) {
			if (!quiet) console.log('JSON.stringify error of object:', o, e);
			return false;
		}
	},

	getRandomChars : function (len, charSet) {
		charSet = charSet || 'abcdefghijklmnopqrstuvwxyz';
		var randomString = '';
		for (var i = 0; i < len; i++) {
			var randomPoz = Math.floor(Math.random() * charSet.length);
			randomString += charSet.substring(randomPoz,randomPoz+1);
		}
		return randomString;
	},

	checkParams : function (params, done) {
		if (!params.layerUuid) 		return done('Invalid url: Missing layerUuid.');
		if (params.z == undefined) 	return done('Invalid url: Missing tile coordinates. z', params.z);
		if (params.x == undefined) 	return done('Invalid url: Missing tile coordinates. x', params.x);
		if (params.y == undefined) 	return done('Invalid url: Missing tile coordinates. y', params.y);
		if (!params.type) 		return done('Invalid url: Missing type extension.');
		return done(null);
	},

	_checkTileIntersect : function (bbox, extentString) {
		var extent = [
			parseFloat(extentString.split(' ')[0]),
			parseFloat(extentString.split(' ')[1].split(',')[0]),
			parseFloat(extentString.split(',')[1].split(' ')[0]),
			parseFloat(extentString.split(',')[1].split(' ')[1]),
		]
		return mile._intersects(bbox, extent);
	},

	_intersects : function (box1, box2) {
		// return true if boxes intersect, quick n dirty

		// tile
		var box1_xmin = box1[0]
		var box1_ymin = box1[1]
		var box1_xmax = box1[2]
		var box1_ymax = box1[3]

		// data
		var box2_xmin = box2[0]
		var box2_ymin = box2[1]
		var box2_xmax = box2[2]
		var box2_ymax = box2[3]

		// if both sides of tile is further north than extent, not intersecting
		if (box1_ymax > box2_ymax && box1_ymin > box2_ymax) return false;

		// if both sides of tile is further west than extent, not intersecting
		if (box1_xmin < box2_xmin && box1_xmax < box2_xmin) return false;

		// if both sides of tile is further south than extent, not intersecting
		if (box1_ymin < box2_ymin && box1_ymax < box2_ymin) return false;

		// if both sides of tile is further east than extent, not intersecting
		if (box1_xmax > box2_xmax && box1_xmin > box2_xmax) return false;

		return true;
	},

	// helper fn's for auth
	checkAccess : function (req, res, next) {
		// request wu for checking access tokens
		var access_token = req.query.access_token || req.body.access_token;
		var verifyUrl = 'http://engine:3001/v2/users/token/check?access_token=' + access_token;
		request(verifyUrl, function (error, response, body) {
			if (!response) return res.json({access : 'Unauthorized'});
			
			var status = tools.safeParse(body);
			req.user = {
				uuid : status.user_id,
				username : status.username
			}

			// allowed
			if (status && status.valid && response.statusCode == 200 && !error) {
				return next();
			} 

			// return noAccess tile if raster request
			if (tools.isRasterRequest(req)) {
				return fs.readFile('public/noAccessTile.png', function (err, tile) {
					res.writeHead(200, {'Content-Type': 'image/png'});
					res.end(tile);
				});
			}

			// not allowed
			res.status(401).json({access : 'Unauthorized'});
		});
	},

	isRasterRequest : function (req) {
		if (req._parsedUrl && req._parsedUrl.pathname) {
			var parsed = req._parsedUrl.pathname.split('/');
			if (parsed[5]) {
				var ext = parsed[5].split('.');
				if (ext.length > 0) {
					var type = ext[1];
					if (type == 'png') {
						return true;
					}
				}
			}
		}
		return false;
	},

}