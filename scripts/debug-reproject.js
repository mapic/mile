var proj4 = require('proj4');

console.time('proj');
var input = [1.91584716169939,28.9021474441477,2.51108360353875,29.355418173006];
var input_a = [input[0], input[2]]
var input_b = [input[1], input[3]]
console.log('input', input);
var FROM_PROJECTION = 'EPSG:4326'
var TO_PROJECTION = 'EPSG:3857';
var output_a = proj4(FROM_PROJECTION, TO_PROJECTION, input_a);
var output_b = proj4(FROM_PROJECTION, TO_PROJECTION, input_b);
console.log('output_a', output_a);
console.log('output_b', output_b);
console.log('all good');

var output_extent = output_a[0] + ' ' + output_b[0] + ',' + output_a[1] + ' ' + output_b[1];
console.log('output_extent', output_extent);
console.timeEnd('proj');
