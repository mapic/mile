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
	echo "Must provide key as third argument,"
	echo ""
	exit 1 # missing args
fi

if [ "$3" == "" ]; then
	echo "Must provide value as third argument,"
	echo ""
	exit 1 # missing args
fi

# get config
# source /mapic/config/env.sh
MAPIC_PGSQL_USERNAME=systemapic
MAPIC_PGSQL_PASSWORD=docker

# run query
PGPASSWORD=$MAPIC_PGSQL_PASSWORD psql -U $MAPIC_PGSQL_USERNAME -d $1 -h postgis -c "select row_to_json(t) from (SELECT * FROM $2 AS q, ST_X(geom) as lng, ST_Y(geom) as lat where $3 = $4) t;"
