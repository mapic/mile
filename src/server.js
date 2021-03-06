// vile/server.js
var _ 			= require('lodash');
var colors 		= require('colors');
var express 	= require('express');
var bodyParser 	= require('body-parser')
var cors 		= require('cors')
var fs 			= require('fs');
var path 		= require('path');
var compression = require('compression')
var http 		= require('http');
var request 	= require('request');
var winston 	= require('winston');

// #########################################
// ###  Server, routes                   ###	// runs on 1 cpu
// #########################################
module.exports = function (mile) {

	// configure server
	var app = express();
	app.use(compression()); // enable compression
	app.use(bodyParser.json({ limit: '1000mb'}));
	app.use(express.static(path.join(__dirname, 'public'))); 	// not secured

	// create layer
	app.post('/v2/tiles/create', mile.checkAccess, function (req, res) {
		mile.createLayer(req, res);
	});

	// pre-render layer
	app.post('/v2/tiles/render', mile.checkAccess, function (req, res) {
		mile.preRender(req,res);
	});
	
	// pre-render layer
	app.post('/v2/cubes/render/start', mile.checkAccess, function (req, res) {
		mile.cubes.render.start(req,res);
	});

	// pre-render layer
	app.post('/v2/cubes/render/status', mile.checkAccess, function (req, res) {
		mile.cubes.render.status(req,res);
	});

	// pre-render layer
	app.post('/v2/cubes/render/estimate', mile.checkAccess, function (req, res) {
		mile.cubes.render.estimate(req,res);
	});

	// create cube layer
	app.post('/v2/cubes/create', mile.checkAccess, function (req, res) {
		mile.cubes.create(req, res);
	});

	// remove cube layer
	app.post('/v2/cubes/deleteCube', mile.checkAccess, function (req, res) {
		mile.cubes.deleteCube(req, res);
	});

	// add dataset to cube
	app.post('/v2/cubes/add', mile.checkAccess, function (req, res) {
		mile.cubes.add(req, res);
	});

	// remove dataset from cube
	app.post('/v2/cubes/remove', mile.checkAccess, function (req, res) {
		mile.cubes.remove(req, res);
	});

	// replace dataset
	app.post('/v2/cubes/replace', mile.checkAccess, function (req, res) {
		mile.cubes.replace(req, res);
	});

	// update dataset
	app.post('/v2/cubes/update', mile.checkAccess, function (req, res) {
		mile.cubes.update(req, res);
	});

	// add mask
	app.post('/v2/cubes/mask', mile.checkAccess, function (req, res) {
		mile.cubes.mask(req, res);
	});

	// remove mask
	app.post('/v2/cubes/unmask', mile.checkAccess, function (req, res) {
		mile.cubes.unmask(req, res);
	});

	// get mask
	app.post('/v2/cubes/getMask', mile.checkAccess, function (req, res) {
		mile.cubes.getMask(req, res);
	});

	// update mask
	app.post('/v2/cubes/updateMask', mile.checkAccess, function (req, res) {
		mile.cubes.updateMask(req, res);
	});

	// update mask
	app.post('/v2/cubes/updateDatasetMask', mile.checkAccess, function (req, res) {
		mile.cubes.updateMask(req, res);
	});

	// request cube tiles
	app.get('/v2/cubes/get', mile.checkAccess, function (req, res) {
		mile.cubes.get(req, res);
	});

	// create cube layer
	app.get('/v2/cubes/*', mile.checkAccess, function (req, res) {
		mile.cubes.tile(req, res);
	});

	// vectorize layer
	app.post('/v2/tiles/vectorize', mile.checkAccess, function (req, res) {
		mile.vectorizeDataset(req, res);
	});

	// get layer
	app.get('/v2/tiles/layer', mile.checkAccess, function (req, res) {
		mile.getLayer(req, res);
	});

	// get tiles
	app.get('/v2/tiles/*', mile.checkAccess, function (req, res) {
		mile.getTileEntryPoint(req, res);
	});

	// get data from point
	app.post('/v2/query/point', mile.checkAccess, function (req, res) {
		mile.fetchData(req, res);
	});

	// get data from area
	app.post('/v2/query/polygon', mile.checkAccess, function (req, res) {
		mile.fetchDataArea(req, res);
	});

	// get data from area
	app.post('/v2/query/defo', mile.checkAccess, function (req, res) {
		mile.fetchRasterDeformation(req, res);
	});

	// get data from area
	app.post('/v2/query/raster/point', mile.checkAccess, function (req, res) {
		mile.queryRasterPoint(req, res);
	});

	// get data from area for cube
	app.post('/v2/cubes/query', mile.checkAccess, function (req, res) {
		mile.cubes.query(req, res);
	});

	// get histogram from column
	app.post('/v2/query/histogram', mile.checkAccess, function (req, res) {
		mile.fetchHistogram(req, res);
	});

	// get histogram from column
	app.post('/v2/query/getVectorPoints', mile.checkAccess, function (req, res) {
		mile.getVectorPoints(req, res);
	});

	// start server
	app.listen(3003);

	// debug
	console.log('\n\nMile is up @ ' + 3003);
	console.log('(Threads:' + process.env.UV_THREADPOOL_SIZE + ')');
}


// tile render logging
console.tile = function (tile) {
	// if (tile.render_time) console.info('rendered tile in ', tile.render_time, 'ms');
};
