#!/bin/bash


if [ "$1" == "" ]; then
    echo "Must provide database as first argument,"
    echo ""
    exit 2 # missing args
fi

if [ "$2" == "" ]; then
    echo "Must provide table as second argument,"
    echo ""
    exit 3 # missing args
fi

if [ "$3" == "" ]; then
    echo "Must provide lng as third argument,"
    echo ""
    exit 4 # missing args
fi

if [ "$4" == "" ]; then
    echo "Must provide lat as third argument,"
    echo ""
    exit 4 # missing args
fi

DATABASE=$1
RASTER=$2
LON=$3
LAT=$4

# get config
# source /mapic/config/env.sh
# MAPIC_PGSQL_USERNAME=systemapic
# MAPIC_PGSQL_PASSWORD=docker

PGPASSWORD=$MAPIC_POSTGIS_PASSWORD psql -U $MAPIC_POSTGIS_USERNAME -d $DATABASE -h $MAPIC_POSTGIS_HOST -c "select row_to_json(t) from (select ST_Value(rast, ST_Transform(ST_SetSRID(ST_MakePoint($LON, $LAT), 4326), 3857)) from $RASTER) as t;"
# -c "select row_to_json(t) from (select * from $2 where st_intersects(st_transform(st_setsrid(ST_geomfromgeojson('$3'), 4326), 3857), sub.the_geom_3857)) as t;"
# -c "select row_to_json(t) from (select * from $2 where st_intersects(st_transform(st_setsrid(ST_geomfromgeojson('$3'), 4326), 3857), sub.the_geom_3857)) as t;"

# select row_to_json(t) from (select 
#     ST_Value(
#         rast, 
#         ST_Transform(
#             ST_SetSRID(
#                 ST_MakePoint(
#                     20.45516967773438,
#                     40.66397287638688
#                 ),
#             4326),
#         3857)
#     ) from file_gdocqsccymgehpkrnguw
# ) as t;