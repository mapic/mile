#!/bin/bash


if [ "$1" == "" ]; then
	echo "Must provide database as first argument,"
	echo ""
	exit 1 # missing args
fi

if [ "$2" == "" ]; then
	echo "Must provide table as second argument,"
	echo ""
	exit 1 # missing args
fi

if [ "$3" == "" ]; then
	echo "Must provide column as third argument,"
	echo ""
	exit 1 # missing args
fi

echo "args:"
echo $1
echo $2
echo $3

# get config
# source /mapic/config/env.sh
MAPIC_PGSQL_USERNAME=systemapic
MAPIC_PGSQL_PASSWORD=docker

# PGPASSWORD=docker psql -U docker -d $1 -h postgis -c "select row_to_json(t) from (select MAX($3), MIN($3), AVG($3) from $2) t;"
PGPASSWORD=$MAPIC_PGSQL_PASSWORD psql -U $MAPIC_PGSQL_USERNAME -d $1 -h postgis -c "SELECT val, geom INTO $2 FROM (SELECT (ST_DumpAsPolygons(rast)).* FROM $3) As foo ORDER BY val;"

# SELECT val, geom INTO file_vectorblalblblalalax
# FROM (
# SELECT (ST_DumpAsPolygons(rast)).*
# FROM raster_test
# ) As foo
# ORDER BY val;