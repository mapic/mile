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
	echo "Must provide geojson as third argument,"
	echo ""
	exit 1 # missing args
fi

# get config
# source /mapic/config/env.sh
MAPIC_PGSQL_USERNAME=systemapic
MAPIC_PGSQL_PASSWORD=docker

PGPASSWORD=$MAPIC_PGSQL_PASSWORD psql -U $MAPIC_PGSQL_USERNAME -d $1 -h postgis -c "select row_to_json(t) from (select * from $2 where st_intersects(st_transform(st_setsrid(ST_geomfromgeojson('$3'), 4326), 3857), sub.the_geom_3857)) as t;"
