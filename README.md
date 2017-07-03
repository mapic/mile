# Mapic Tileserver 
[![Build Status](https://travis-ci.org/mapic/mile.svg)](https://travis-ci.org/mapic/mile)

## Install
See [mapic/mapic](https://github.com/mapic/mapic) for installation instructions.

## Data formats
Mapic Tileserver uses [PostGIS](http://www.postgis.net/) under the hood for data storage. It can therefore can accept any PostGIS supported format, and can be easily modified to support other output formats.

#### Input sources
- [x] `GeoTIFF`
- [x] `GeoJSON`
- [x] `TopoJSON`
- [x] `Shapefile`
- [x] `ECW`
- [ ] Any PostGIS format can be included, request yours!

#### Output formats
- [x] Raster tiles (combined with [CartoCSS](https://carto.com/docs/carto-engine/cartocss/) stylesheet)
- [x] Untiled vector formats (`GeoJSON`, `TopoJSON`, `Shapefile`)
- [ ] Vector tiles (under development)
- [ ] Untiled raster formats (`GeoTIFF`, `ECW`, `JPEG200`, etc.)

## Test

Run your own tests with `mapic test mile`, or see [Travis](https://travis-ci.org/mapic/mile).

## Licence
Mapic is built entirely open source. We believe in a collaborative environment for creating strong solutions for an industry that is constantly moving. The Mapic platform is open for anyone to use and contribute to, which makes it an ideal platform for government organisations as well as NGO's and for-profit businesses.

Mapic is licenced under the [AGPL licence](https://github.com/mapic/mapic/blob/master/LICENCE).

## Project contributors
Contributors listed on [mapic/mapic](https://github.com/mapic/mapic#project-contributors).
